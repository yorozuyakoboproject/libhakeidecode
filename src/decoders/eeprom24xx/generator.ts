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

export interface Eeprom24xxCase extends RoundtripCase<I2COperation> {}

const CHAIN = [{ decoder: 'i2c', options: { address_format: 'unshifted' } }] as const;
const SUMMARY: ExpectedFrame = { protoId: 'eeprom24xx', kind: 'summary' };

function operation(
  direction: 'read' | 'write',
  data: readonly number[],
  options: Partial<I2COperation> = {},
): I2COperation {
  return { address: 0x50, addressBits: 7, direction, data, ...options };
}

function bits(operations: readonly I2COperation[]): number {
  return operations.reduce((sum, item) => sum + 9 * (1 + item.data.length), 0);
}

const CONTROL_PREFIX: readonly ExpectedFrame[] = [
  {
    classIndex: 1,
    texts: ['Control code bits: 1010', 'Control code: 1010', 'Ctrl code: 1010', 'Ctrl code', 'Ctrl', 'C'],
  },
  { classIndex: 2, texts: ['Address bit 2: 0', 'Addr bit 2', 'A2', 'A'] },
  { classIndex: 2, texts: ['Address bit 1: 0', 'Addr bit 1', 'A1', 'A'] },
  { classIndex: 2, texts: ['Address bit 0: 0', 'Addr bit 0', 'A0', 'A'] },
  { classIndex: 3, texts: ['R/W bit: write', 'R/W', 'RW', 'W'] },
  { classIndex: 6, texts: ['Control word', 'Control', 'CW', 'C'] },
];

function caseOptions(chip = 'generic'): Record<string, string | number> {
  return { chip, addr_counter: 0 };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x32345858,
}: GenerationOptions = {}): Iterable<Eeprom24xxCase> {
  yield {
    name: 'byte-write',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 9_007_199_254_740_000n,
    channels: { scl: 1, sda: 4 },
    options: caseOptions(),
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [operation('write', [0x10, 0xab])];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          ...CONTROL_PREFIX,
          { classIndex: 4, texts: ['Word address byte: 10', 'Word addr byte: 10', 'Addr: 10', 'A: 10', '10'] },
          { classIndex: 5, texts: ['Data byte 10: AB', 'Data byte: AB', 'Byte: AB', 'DB: AB', 'AB'] },
          {
            classIndex: 9,
            texts: ['Byte write (addr=10, 1 byte): AB', 'Byte write (addr=10, 1 byte)', 'Byte write', 'BW', 'B'],
          },
        ],
        annotationCount: 11,
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'page-write',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 17n,
    channels: { scl: 2, sda: 5 },
    options: caseOptions(),
    chunkSamples: [7, 127, 2047],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [operation('write', [0x20, 0x01, 0x02, 0x03, 0x04])];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          ...CONTROL_PREFIX,
          { classIndex: 4, texts: ['Word address byte: 20', 'Word addr byte: 20', 'Addr: 20', 'A: 20', '20'] },
          { classIndex: 5, texts: ['Data byte 20: 01', 'Data byte: 01', 'Byte: 01', 'DB: 01', '01'] },
          { classIndex: 8, texts: ['Data', 'D'] },
          {
            classIndex: 10,
            texts: [
              'Page write (addr=20, 4 bytes): 01 02 03 04',
              'Page write (addr=20, 4 bytes)',
              'Page write',
              'PW',
              'P',
            ],
          },
        ],
        annotationCount: 14,
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'current-address-read',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { scl: 3, sda: 6 },
    options: caseOptions(),
    chunkSamples: [3, 31],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [operation('read', [0x5a], { dataAcks: [false] })];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          {
            classIndex: 1,
            texts: ['Control code bits: 1010', 'Control code: 1010', 'Ctrl code: 1010', 'Ctrl code', 'Ctrl', 'C'],
          },
          { classIndex: 3, texts: ['R/W bit: read', 'R/W', 'RW', 'R'] },
          { classIndex: 5, texts: ['Data byte 00: 5A', 'Data byte: 5A', 'Byte: 5A', 'DB: 5A', '5A'] },
          { classIndex: 11, texts: ['Current address read: 5A', 'Current address read', 'Cur addr read', 'CAR', 'C'] },
        ],
        annotationCount: 9,
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'random-read',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 123_456n,
    channels: { scl: 0, sda: 1 },
    options: caseOptions(),
    chunkSamples: [1, 2, 3, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [
        operation('write', [0x30], { stop: false }),
        operation('read', [0x5a], { repeatedStart: true, dataAcks: [false] }),
      ];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          ...CONTROL_PREFIX,
          { classIndex: 4, texts: ['Word address byte: 30', 'Word addr byte: 30', 'Addr: 30', 'A: 30', '30'] },
          { classIndex: 5, texts: ['Data byte 30: 5A', 'Data byte: 5A', 'Byte: 5A', 'DB: 5A', '5A'] },
          {
            classIndex: 12,
            texts: [
              'Random access read (addr=30, 1 byte): 5A',
              'Random access read (addr=30, 1 byte)',
              'Random access read',
              'RAR',
              'R',
            ],
          },
        ],
        annotationCount: 17,
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'sequential-random-read',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 5n,
    channels: { scl: 4, sda: 7 },
    options: caseOptions(),
    chunkSamples: [15, 255],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [
        operation('write', [0x40], { stop: false }),
        operation('read', [0x11, 0x22, 0x33], { repeatedStart: true, dataAcks: [true, true, false] }),
      ];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          ...CONTROL_PREFIX,
          { classIndex: 4, texts: ['Word address byte: 40', 'Word addr byte: 40', 'Addr: 40', 'A: 40', '40'] },
          { classIndex: 5, texts: ['Data byte 40: 11', 'Data byte: 11', 'Byte: 11', 'DB: 11', '11'] },
          {
            classIndex: 13,
            texts: [
              'Sequential random read (addr=40, 3 bytes): 11 22 33',
              'Sequential random read (addr=40, 3 bytes)',
              'Sequential random read',
              'SRR',
              'S',
            ],
          },
        ],
        annotationCount: 19,
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'address-nack',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 77n,
    channels: { scl: 1, sda: 3 },
    options: caseOptions(),
    chunkSamples: [5, 47],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [operation('write', [], { addressAck: false })];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 6, texts: ['Control word', 'Control', 'CW', 'C'] },
          { classIndex: 0, texts: ['Warning: No reply from slave!'] },
        ],
        annotationCount: 7,
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'page-size-and-boundary-warnings',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 1n,
    channels: { scl: 5, sda: 6 },
    options: caseOptions(),
    chunkSamples: [11, 113],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [0x00, ...Array.from({ length: 9 }, (_, index) => index)];
      const operations = [operation('write', data)];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          {
            classIndex: 10,
            texts: [
              'Page write (addr=00, 9 bytes): 00 01 02 03 04 05 06 07 08',
              'Page write (addr=00, 9 bytes)',
              'Page write',
              'PW',
              'P',
            ],
          },
          { classIndex: 0, texts: ['Warning: Wrote 9 bytes but page size is only 8 bytes!'] },
          { classIndex: 0, texts: ['Warning: Page write crossed page boundary from page 0 to 1!'] },
        ],
        annotationCount: 21,
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'random-read-repeated-start-warning',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 9_007_199_254_740_100n,
    channels: { scl: 3, sda: 5 },
    options: caseOptions(),
    chunkSamples: [1, 19, 257],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [
        operation('write', [0x30], { stop: false }),
        operation('read', [0x5a], { repeatedStart: true, dataAcks: [false], stop: false }),
        operation('write', [0x10], { repeatedStart: true }),
      ];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 0, texts: ['Warning: STOP expected (not RESTART)'] },
          {
            classIndex: 12,
            texts: [
              'Random access read (addr=30, 1 byte): 5A',
              'Random access read (addr=30, 1 byte)',
              'Random access read',
              'RAR',
              'R',
            ],
          },
        ],
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'current-read-repeated-start-warning',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 9_007_199_254_740_200n,
    channels: { scl: 5, sda: 7 },
    options: caseOptions(),
    chunkSamples: [3, 29, 257],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [
        operation('read', [0x5a], { dataAcks: [false], stop: false }),
        operation('write', [0x10], { repeatedStart: true }),
      ];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 0, texts: ['Warning: STOP expected (not RESTART)'] },
          {
            classIndex: 11,
            texts: ['Current address read: 5A', 'Current address read', 'Cur addr read', 'CAR', 'C'],
          },
        ],
        payloadBits: bits(operations),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    operationsPerBlock = 60,
    dataPerOperation = 200,
    bitsPerOperation = 9 * (1 + 2 + dataPerOperation),
    blocks = Math.ceil(required / (operationsPerBlock * bitsPerOperation));
  yield {
    name: 'seeded-long-cat24m01-page-writes',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { scl: 2, sda: 4 },
    options: caseOptions('onsemi_cat24m01'),
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const operations: I2COperation[] = [];
        for (let index = 0; index < operationsPerBlock; index++) {
          const data = [0x00, 0x00, ...Array.from({ length: dataPerOperation }, () => random() & 0xff)];
          operations.push(operation('write', data));
        }
        yield {
          data: operations,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            {
              classIndex: 1,
              texts: ['Control code bits: 1010', 'Control code: 1010', 'Ctrl code: 1010', 'Ctrl code', 'Ctrl', 'C'],
            },
            { classIndex: 2, texts: ['Address bit 1: 0', 'Addr bit 1', 'A1', 'A'] },
            { classIndex: 2, texts: ['Address bit 0: 0', 'Addr bit 0', 'A0', 'A'] },
            { classIndex: 3, texts: ['R/W bit: write', 'R/W', 'RW', 'W'] },
            { classIndex: 6, texts: ['Control word', 'Control', 'CW', 'C'] },
          ],
          annotationCount: operations.length * 210,
          payloadBits: operations.length * bitsPerOperation,
        };
      }
    },
  };
}
