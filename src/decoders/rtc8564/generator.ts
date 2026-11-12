import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface I2COperation {
  readonly address: number;
  readonly direction: 'read' | 'write';
  readonly data: readonly number[];
  readonly addressAck?: boolean;
  readonly dataAcks?: readonly boolean[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface Rtc8564Case extends RoundtripCase<I2COperation> {}

const SUMMARY: ExpectedFrame = { protoId: 'rtc8564', kind: 'summary' };

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function operationBits(operation: I2COperation): number {
  return 9 * (1 + operation.data.length);
}

function control2(value: number): ExpectedFrame {
  const tiTp = value & 0x10 ? 1 : 0;
  const af = value & 0x08 ? 1 : 0;
  const tf = value & 0x04 ? 1 : 0;
  const aie = value & 0x02 ? 1 : 0;
  const tie = value & 0x01 ? 1 : 0;
  return {
    classIndex: 1,
    texts: [
      `TI/TP = ${tiTp}: ${tiTp ? 'repeated' : 'single-shot'} operation upon fixed-cycle timer interrupt events\n` +
        `AF = ${af}: ${af ? '' : 'no '}alarm interrupt detected\n` +
        `TF = ${tf}: ${tf ? '' : 'no '}fixed-cycle timer interrupt detected\n` +
        `AIE = ${aie}: INT# pin output ${aie ? 'enabled' : 'prohibited'} when an alarm interrupt occurs\n` +
        `TIE = ${tie}: INT# pin output ${tie ? 'enabled' : 'prohibited'} when a fixed-cycle interrupt event occurs`,
    ],
  };
}

function registerAccess(direction: 'read' | 'write', register: number, value: number): ExpectedFrame {
  const access = `${hex(register)}: ${hex(value)}`;
  return {
    classIndex: 15,
    texts:
      direction === 'write'
        ? [`Write register ${access}`, `Write reg ${access}`, `WR ${access}`, 'WR', 'W']
        : [`Read register ${access}`, `Read reg ${access}`, `RR ${access}`, 'RR', 'R'],
  };
}

function reserved(): ExpectedFrame {
  return { classIndex: 11, texts: ['Reserved bit', 'Reserved', 'Rsvd', 'R'] };
}

function bcd(value: number): number {
  return (value & 0x0f) + (value >>> 4) * 10;
}

function registerFields(register: number, value: number): ExpectedFrame[] {
  switch (register) {
    case 1:
      return [control2(value)];
    case 2: {
      const vl = (value & 0x80) !== 0 ? 1 : 0;
      const seconds = bcd(value & 0x7f);
      return [
        { classIndex: 12, texts: [`Voltage low: ${vl}`, `Volt. low: ${vl}`, `VL: ${vl}`, 'VL'] },
        { classIndex: 2, texts: [`Second: ${seconds}`, `Sec: ${seconds}`, `S: ${seconds}`, 'S'] },
      ];
    }
    case 3: {
      const minutes = bcd(value & 0x7f);
      return [
        reserved(),
        {
          classIndex: 3,
          texts: [`Minute: ${minutes}`, `Min: ${minutes}`, `M: ${minutes}`, 'M'],
        },
      ];
    }
    case 4: {
      const hours = bcd(value & 0x3f);
      return [reserved(), reserved(), { classIndex: 4, texts: [`Hour: ${hours}`, `H: ${hours}`, 'H'] }];
    }
    case 5: {
      const days = bcd(value & 0x3f);
      return [reserved(), reserved(), { classIndex: 5, texts: [`Day: ${days}`, `D: ${days}`, 'D'] }];
    }
    case 6: {
      const weekdays = bcd(value & 0x07);
      return [
        ...Array.from({ length: 5 }, reserved),
        { classIndex: 6, texts: [`Weekday: ${weekdays}`, `WD: ${weekdays}`, 'WD', 'W'] },
      ];
    }
    case 7: {
      const century = (value & 0x80) !== 0 ? 1 : 0;
      const months = bcd(value & 0x1f);
      return [
        {
          classIndex: 13,
          texts: [`Century bit: ${century}`, `Century: ${century}`, `Cent: ${century}`, `C: ${century}`, 'C'],
        },
        reserved(),
        reserved(),
        {
          classIndex: 7,
          texts: [`Month: ${months}`, `Mon: ${months}`, `M: ${months}`, 'M'],
        },
      ];
    }
    case 8: {
      const years = bcd(value);
      return [{ classIndex: 8, texts: [`Year: ${years}`, `Y: ${years}`, 'Y'] }];
    }
    default:
      return [];
  }
}

function decimal(value: number): string {
  return value.toString().padStart(2, '0');
}

function dateTime(classIndex: 9 | 10, values: readonly number[]): ExpectedFrame {
  const seconds = bcd(values[2]! & 0x7f);
  const minutes = bcd(values[3]! & 0x7f);
  const hours = bcd(values[4]! & 0x3f);
  const days = bcd(values[5]! & 0x3f);
  const months = bcd(values[7]! & 0x1f);
  const years = bcd(values[8]!);
  const date =
    `${decimal(days)}.${decimal(months)}.${decimal(years)} ` +
    `${decimal(hours)}:${decimal(minutes)}:${decimal(seconds)}`;
  return {
    classIndex,
    texts:
      classIndex === 9
        ? [`Write date/time: ${date}`, `Write: ${date}`, `W: ${date}`]
        : [`Read date/time: ${date}`, `Read: ${date}`, `R: ${date}`],
  };
}

function fullExpectations(values: readonly number[], direction: 'read' | 'write'): ExpectedFrame[] {
  const expected: ExpectedFrame[] = [];
  for (let register = 0; register <= 8; register++) {
    expected.push(registerAccess(direction, register, values[register]!));
    expected.push(...registerFields(register, values[register]!));
  }
  expected.push(dateTime(direction === 'write' ? 9 : 10, values));
  return expected;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x52544338,
}: GenerationOptions = {}): Iterable<Rtc8564Case> {
  const common = {
    seed,
    sampleRate: 800_000,
    channels: { scl: 4, sda: 6 },
    chain: [{ decoder: 'i2c', options: { address_format: 'shifted' } }],
  } as const;

  yield {
    ...common,
    name: 'boundary-write-clock',
    kind: 'boundary',
    startSample: 29n,
    options: {},
    chunkSamples: [41, 509, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const values = [0x00, 0x1f, 0xd9, 0x59, 0x23, 0x31, 0x07, 0x92, 0x99];
      const data: I2COperation[] = [{ address: 0x51, direction: 'write', data: [0, ...values] }];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: fullExpectations(values, 'write'),
        annotationCount: 32,
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  yield {
    ...common,
    name: 'boundary-read-clock',
    kind: 'boundary',
    startSample: 0n,
    options: {},
    chunkSamples: [53, 997, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const values = [0x00, 0x00, 0x00, 0x59, 0x23, 0x31, 0x07, 0x12, 0x00];
      const data: I2COperation[] = [
        { address: 0x51, direction: 'write', data: [0], stop: false },
        { address: 0x51, direction: 'read', data: values, repeatedStart: true },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: fullExpectations(values, 'read'),
        annotationCount: 32,
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const transactionsPerBlock = 50;
  const bitsPerTransaction = 9 * 11;
  const blocks = Math.ceil(required / (bitsPerTransaction * transactionsPerBlock));

  yield {
    ...common,
    name: 'seeded-long-clock-writes',
    kind: 'long',
    startSample: 0n,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: I2COperation[] = [];
        let bits = 0;
        let firstValue = 0;
        for (let index = 0; index < transactionsPerBlock; index++) {
          const values = [0, ...Array.from({ length: 8 }, () => random() & 0xff)];
          if (index === 0) firstValue = values[0]!;
          const operation: I2COperation = { address: 0x51, direction: 'write', data: [0, ...values] };
          data.push(operation);
          bits += operationBits(operation);
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [registerAccess('write', 0, firstValue)],
          annotationCount: transactionsPerBlock * 32,
          payloadBits: bits,
        };
      }
    },
  };
}
