import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface I2COperation {
  readonly address: number;
  readonly addressBits: 7 | 10;
  readonly direction: 'read' | 'write';
  readonly data: readonly number[];
  readonly addressAck?: boolean;
  readonly dataAcks?: readonly boolean[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface Ds1307Case extends RoundtripCase<I2COperation> {}

const CHAIN = [{ decoder: 'i2c', options: { address_format: 'unshifted' } }] as const;
const SUMMARY: ExpectedFrame = { protoId: 'ds1307', kind: 'summary' };
const DATE_TIME = [0x59, 0x58, 0x21, 0x05, 0x15, 0x10, 0x26] as const;

function operation(
  direction: 'read' | 'write',
  data: readonly number[],
  options: Partial<I2COperation> = {},
): I2COperation {
  return { address: 0x68, addressBits: 7, direction, data, ...options };
}

function bits(operation: I2COperation): number {
  return 9 * (1 + operation.data.length);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x44533133,
}: GenerationOptions = {}): Iterable<Ds1307Case> {
  yield {
    name: 'write-full-date-time',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 101n,
    channels: { scl: 1, sda: 4 },
    options: {},
    chunkSamples: [7, 127, 2047],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [operation('write', [0x00, ...DATE_TIME])];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 0, texts: ['Seconds', 'Sec', 'S'] },
          { classIndex: 9, texts: ['Clock halt: 0', 'Clk hlt: 0', 'CH: 0', 'CH'] },
          { classIndex: 10, texts: ['Second: 59', 'Sec: 59', 'S: 59', 'S'] },
          { classIndex: 3, texts: ['Day of week', 'Day', 'D'] },
          { classIndex: 16, texts: ['Weekday: Thursday', 'WD: Thursday', 'WD', 'W'] },
          { classIndex: 25, texts: ['Written date/time: Thursday, 15.10.2026 21:58:59'] },
        ],
        annotationCount: 29,
        payloadBits: operations.reduce((sum, item) => sum + bits(item), 0),
      };
    },
  };

  yield {
    name: 'read-full-date-time',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { scl: 2, sda: 5 },
    options: {},
    chunkSamples: [1, 17, 257],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [
        operation('write', [0x00], { stop: false }),
        operation('read', DATE_TIME, { repeatedStart: true, dataAcks: DATE_TIME.map(() => true).concat(false) }),
      ];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 0, texts: ['Seconds', 'Sec', 'S'] },
          { classIndex: 1, texts: ['Minutes', 'Min', 'M'] },
          { classIndex: 2, texts: ['Hours', 'H'] },
          { classIndex: 13, texts: ['24-hour mode', '24h mode', '24h'] },
          { classIndex: 19, texts: ['Year: 26', 'Y: 26', 'Y'] },
          { classIndex: 24, texts: ['Read date/time: Thursday, 15.10.2026 21:58:59'] },
        ],
        annotationCount: 29,
        payloadBits: operations.reduce((sum, item) => sum + bits(item), 0),
      };
    },
  };

  yield {
    name: 'wrong-address-warning',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 999n,
    channels: { scl: 3, sda: 6 },
    options: {},
    chunkSamples: [3, 31],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [{ ...operation('write', [0x00]), address: 0x69 }];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [{ classIndex: 28, texts: ['Ignoring non-DS1307 data (slave 0x69)'] }],
        annotationCount: 1,
        payloadBits: operations.reduce((sum, item) => sum + bits(item), 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    operationsPerBlock = 200,
    dataPerOperation = 50,
    bitsPerOperation = 9 * (2 + dataPerOperation),
    blocks = Math.ceil(required / (operationsPerBlock * bitsPerOperation));
  yield {
    name: 'seeded-long-sram-stream',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { scl: 0, sda: 2 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const operations: I2COperation[] = [];
        for (let index = 0; index < operationsPerBlock; index++) {
          const data = [0x08, ...Array.from({ length: dataPerOperation }, () => random() & 0xff)];
          operations.push(operation('write', data));
        }
        yield {
          data: operations,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            { classIndex: 8, texts: ['RAM', 'R'] },
            { classIndex: 23, texts: ['SRAM: 0x00', '0x00'] },
            { classIndex: 8, texts: ['RAM', 'R'] },
          ],
          annotationCount: operations.length * dataPerOperation * 2,
          payloadBits: operations.length * bitsPerOperation,
        };
      }
    },
  };
}
