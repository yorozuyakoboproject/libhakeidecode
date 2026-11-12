import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { I2CDirection } from '../i2c/index.js';

export interface I2COperation {
  readonly address: number;
  readonly direction: I2CDirection;
  readonly data: readonly number[];
  readonly addressAck?: boolean;
  readonly dataAcks?: readonly boolean[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface Ltc26x7Case extends RoundtripCase<I2COperation> {}

const CHAIN = [{ decoder: 'i2c', options: { address_format: 'shifted' } }] as const;
const PIN_NAMES = [
  ['GND', 'GND', 'GND', 'G'],
  ['FLOAT', 'FLOAT', 'FLOAT', 'F'],
  ['VCC', 'VCC', 'VCC', 'V'],
] as const;
const COMMANDS: Readonly<Record<number, readonly string[]>> = {
  0x00: ['Write Input Register', 'Write In Reg', 'Wr In Reg', 'WIR'],
  0x01: ['Update DAC', 'Update', 'U'],
  0x03: ['Write and Power Up DAC', 'Write & Power Up', 'W&PU'],
  0x04: ['Power Down DAC', 'Power Down', 'PD'],
  0x0f: ['No Operation', 'No Op', 'NO'],
};
const ADDRESSES: Readonly<Record<number, readonly string[]>> = {
  0x00: ['DAC A', 'A'],
  0x01: ['DAC B', 'B'],
  0x0f: ['All DACs', 'All'],
};
const INVALID_ADDRESS_TEXTS = ['Invalid address', 'Invalid addr', 'Inv addr', 'INV'] as const;

interface TimedOperation {
  readonly start: bigint;
  readonly frameStarts: readonly bigint[];
  readonly frameEnds: readonly bigint[];
  readonly stop: bigint | null;
  readonly next: bigint;
}

function timeOperation(operation: I2COperation, cursor: bigint): TimedOperation {
  const start = cursor + 2n,
    frameStarts = [start + 3n],
    frameEnds = [start + 27n];
  for (let index = 1; index <= operation.data.length; index++) {
    frameStarts.push(start + 3n + BigInt(index) * 27n);
    frameEnds.push(start + 27n + BigInt(index) * 27n);
  }
  const lastEnd = frameEnds[frameEnds.length - 1]!,
    stop = operation.stop === false ? null : lastEnd + 4n;
  return { start, frameStarts, frameEnds, stop, next: stop === null ? lastEnd + 2n : stop + 2n };
}

function operationBits(operation: I2COperation): number {
  return 9 * (1 + operation.data.length);
}

function ternary(value: number): [number, number, number] | null {
  if (!Number.isSafeInteger(value) || value < 0 || value > 26) return null;
  return [Math.floor(value / 9), Math.floor(value / 3) % 3, value % 3];
}

function addressTexts(address: number): readonly string[] {
  if (address === 0x73) return ['Global address', 'Global addr', 'Glob addr', 'GA'];
  if (!Number.isInteger(address) || address < 0 || address > 0x7f || address & 0x0c) return INVALID_ADDRESS_TEXTS;
  const encoded = (address & 0x03) | ((address & 0x70) >> 2);
  if (encoded < 0x04 || encoded > 0x1e) return INVALID_ADDRESS_TEXTS;
  const pins = ternary(encoded - 4);
  if (!pins) return INVALID_ADDRESS_TEXTS;
  return [
    `CA2=${PIN_NAMES[pins[0]]![0]} CA1=${PIN_NAMES[pins[1]]![0]} CA0=${PIN_NAMES[pins[2]]![0]}`,
    `2=${PIN_NAMES[pins[0]]![1]} 1=${PIN_NAMES[pins[1]]![1]} 0=${PIN_NAMES[pins[2]]![1]}`,
    `${PIN_NAMES[pins[0]]![2]} ${PIN_NAMES[pins[1]]![2]} ${PIN_NAMES[pins[2]]![2]}`,
    `${PIN_NAMES[pins[0]]![3]} ${PIN_NAMES[pins[1]]![3]} ${PIN_NAMES[pins[2]]![3]}`,
  ];
}

function voltageTexts(chip: string, vref: number, high: number, low: number): readonly [string, string] {
  let raw = (high << 8) | low,
    voltage: number;
  if (chip === 'ltc2617') {
    raw >>= 2;
    voltage = (vref * raw) / 0x3fff;
  } else if (chip === 'ltc2627') {
    raw >>= 4;
    voltage = (vref * raw) / 0x0fff;
  } else voltage = (vref * raw) / 0xffff;
  return [voltage.toFixed(6) + 'V', voltage.toFixed(2) + 'V'];
}

function operationAnnotations(
  operation: I2COperation,
  cursor: bigint,
  chip: string,
  vref: number,
): { expectedAnnotations: ExpectedFrame[]; next: bigint } {
  const timing = timeOperation(operation, cursor),
    command = operation.data[0]!,
    commandTexts = COMMANDS[(command >> 4) & 0xf] ?? [],
    dac = command & 0xf,
    addressText = ADDRESSES[dac] ?? [],
    middle = (timing.frameStarts[1]! + timing.frameEnds[1]!) / 2n,
    expectedAnnotations: ExpectedFrame[] = [
      {
        ss: timing.frameStarts[0]!,
        es: timing.frameEnds[0]!,
        classIndex: 0,
        texts: addressTexts(operation.address),
      },
      {
        ss: timing.frameStarts[1]!,
        es: middle,
        classIndex: 1,
        texts: commandTexts,
      },
      {
        ss: middle,
        es: timing.frameEnds[1]!,
        classIndex: 2,
        texts: addressText,
      },
    ];
  const texts = voltageTexts(chip, vref, operation.data[1]!, operation.data[2]!);
  if (dac === 0x0f) {
    expectedAnnotations.push(
      { ss: timing.frameStarts[2]!, es: timing.frameEnds[3]!, classIndex: 3, texts },
      { ss: timing.frameStarts[2]!, es: timing.frameEnds[3]!, classIndex: 4, texts },
    );
  } else {
    expectedAnnotations.push({
      ss: timing.frameStarts[2]!,
      es: timing.frameEnds[3]!,
      classIndex: 3 + dac,
      texts,
    });
  }
  return { expectedAnnotations, next: timing.next };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4c544332,
}: GenerationOptions = {}): Iterable<Ltc26x7Case> {
  for (const chip of ['ltc2607', 'ltc2617', 'ltc2627'] as const) {
    const vref = chip === 'ltc2607' ? 1.5 : 3.3;
    yield {
      name: 'write-update-' + chip,
      kind: 'boundary',
      seed,
      sampleRate: 800_000,
      startSample: chip === 'ltc2617' ? 9_007_199_254_740_990n : 13n,
      channels: { scl: 2, sda: 5 },
      options: { chip, vref },
      chunkSamples: [3, 31, 257, 4093],
      minimumPayloadBits: 0,
      chain: CHAIN,
      *generate() {
        const data: I2COperation[] = [
            { address: 0x10, direction: 'write', data: [0x30, 0x12, 0x34] },
            { address: 0x10, direction: 'write', data: [0x3f, 0xff, 0xff] },
            { address: 0x11, direction: 'write', data: [0x01, 0x80, 0x00] },
          ],
          expectedAnnotations: ExpectedFrame[] = [];
        let cursor = (chip === 'ltc2617' ? 9_007_199_254_740_990n : 13n) + 3n;
        for (const operation of data) {
          const result = operationAnnotations(operation, cursor, chip, vref);
          expectedAnnotations.push(...result.expectedAnnotations);
          cursor = result.next;
        }
        yield {
          data,
          expected: [{ protoId: 'ltc26x7', kind: 'summary', annotations: expectedAnnotations.length }],
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
        };
      },
    };
  }

  for (const [name, address] of [
    ['invalid-negative-address', 0x00],
    ['invalid-negative-address-max', 0x03],
    ['invalid-reserved-address', 0x04],
    ['invalid-high-address', 0x7f],
  ] as const) {
    const startSample = 13n;
    yield {
      name,
      kind: 'boundary',
      seed,
      sampleRate: 800_000,
      startSample,
      channels: { scl: 2, sda: 5 },
      options: { chip: 'ltc2607', vref: 1.5 },
      chunkSamples: [3, 31, 257, 4093],
      minimumPayloadBits: 0,
      chain: CHAIN,
      *generate() {
        const operation: I2COperation = { address, direction: 'write', data: [] },
          timing = timeOperation(operation, startSample + 3n);
        yield {
          data: [operation],
          expected: [{ protoId: 'ltc26x7', kind: 'summary', annotations: 1 }],
          expectedAnnotations: [
            {
              ss: timing.frameStarts[0]!,
              es: timing.frameEnds[0]!,
              classIndex: 0,
              texts: INVALID_ADDRESS_TEXTS,
            },
          ],
          annotationCount: 1,
          payloadBits: operationBits(operation),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    count = Math.ceil(required / 36),
    perBlock = 128;
  yield {
    name: 'seeded-long-dac-writes',
    kind: 'long',
    seed,
    sampleRate: 800_000,
    startSample: 0n,
    channels: { scl: 1, sda: 6 },
    options: { chip: 'ltc2607', vref: 1.5 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      let cursor = 3n;
      for (let offset = 0; offset < count; offset += perBlock) {
        const data: I2COperation[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = offset; index < Math.min(count, offset + perBlock); index++) {
          const high = random() & 0xff,
            low = random() & 0xff,
            operation: I2COperation = {
              address: index & 1 ? 0x10 : 0x11,
              direction: 'write',
              data: [0x30, high, low],
            },
            result = operationAnnotations(operation, cursor, 'ltc2607', 1.5);
          cursor = result.next;
          data.push(operation);
          expectedAnnotations.push(...result.expectedAnnotations);
        }
        const expected: ExpectedFrame[] =
          offset === 0 ? [{ protoId: 'ltc26x7', kind: 'summary', annotations: count * 4 }] : [];
        yield {
          data,
          expected,
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
        };
      }
    },
  };
}
