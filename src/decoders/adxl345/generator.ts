import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface AdxlTransaction {
  readonly mosi: readonly number[];
  readonly miso?: readonly number[];
  readonly pauseAfter?: boolean;
}

export interface AdxlCase extends RoundtripCase<AdxlTransaction> {}

const CHANNELS = { clk: 3, miso: 0, mosi: 7, cs: 1 } as const;
const CHAIN = [
  {
    decoder: 'spi',
    options: {
      cs_polarity: 'active-low',
      cpol: 0,
      cpha: 0,
      bitorder: 'msb-first',
      wordsize: 8,
    },
  },
] as const;
const SUMMARY: ExpectedFrame = { protoId: 'adxl345', kind: 'summary' };
const WRITE_TEXTS = ['WRITE REG', 'WRITE', 'W'];
const READ_TEXTS = ['READ REG', 'READ', 'R'];
const SINGLE_TEXTS = ['SINGLE BYTE', 'SING BYTE', '1 BYTE', '1B'];
const MULTIPLE_TEXTS = ['MULTIPLE BYTES', 'MULTI BYTES', 'n*BYTES', 'n*B'];

function write(register: number, data: readonly number[]): AdxlTransaction {
  const multiple = data.length > 1;
  return {
    mosi: [(multiple ? 0x40 : 0) | (register & 0x3f), ...data],
    miso: Array(data.length + 1).fill(0),
    pauseAfter: multiple,
  };
}

function read(register: number, data: readonly number[]): AdxlTransaction {
  const multiple = data.length > 1;
  return {
    mosi: [0x80 | (multiple ? 0x40 : 0) | (register & 0x3f), ...Array(data.length).fill(0)],
    miso: [0, ...data],
    pauseAfter: multiple,
  };
}

function dataAnnotations(address: number): number {
  if (address < 0x1d) return 2;
  if ([0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x28, 0x29].includes(address)) return 2;
  if ([0x27, 0x2a, 0x2b, 0x2e, 0x2f, 0x30].includes(address)) return 9;
  if (address === 0x2c) return 6;
  if (address === 0x2d || address === 0x31) return 8;
  if ([0x32, 0x33, 0x34, 0x35, 0x36, 0x37].includes(address)) return 2;
  if (address === 0x38) return 4;
  if (address === 0x39) return 4;
  return 0;
}

function transactionAnnotations(transaction: AdxlTransaction): number {
  const command = transaction.mosi[0]!,
    address = command & 0x3f,
    data = transaction.mosi.length - 1;
  let count = 3;
  for (let index = 0; index < data; index++) count += dataAnnotations(address + index);
  return count;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4144584c,
}: GenerationOptions = {}): Iterable<AdxlCase> {
  yield {
    name: 'boundary-registers-bits-axes-and-multibyte',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data: AdxlTransaction[] = [
        write(0x00, [0x11]),
        write(0x1d, [0x10]),
        write(0x1e, [0x01]),
        write(0x1f, [0x02]),
        write(0x20, [0x03]),
        write(0x21, [0x10]),
        write(0x22, [0x10]),
        write(0x23, [0x10]),
        write(0x24, [0x10]),
        write(0x25, [0x10]),
        write(0x26, [0x10]),
        write(0x27, [0x80]),
        write(0x28, [0x10]),
        write(0x29, [0x10]),
        write(0x2a, [0x1f]),
        write(0x2b, [0xef]),
        write(0x2c, [0x0e]),
        write(0x2d, [0x00]),
        write(0x2e, [0x55]),
        write(0x2f, [0xaa]),
        write(0x30, [0xff]),
        write(0x31, [0x00]),
        read(0x32, [0x12]),
        read(0x33, [0x34]),
        read(0x34, [0x56]),
        read(0x35, [0x78]),
        read(0x36, [0x9a]),
        read(0x37, [0xbc]),
        write(0x38, [0xe5]),
        write(0x39, [0x7f]),
        read(0x00, [0xaa, 0x55, 0x00]),
        write(0x21, [0x00]),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        { classIndex: 1, texts: WRITE_TEXTS },
        { classIndex: 2, texts: SINGLE_TEXTS },
        { classIndex: 3, texts: ['ADDRESS: 0x00', 'ADDR: 0x00', '0x00'] },
        { classIndex: 3, texts: ['0'] },
        { classIndex: 4, texts: ['17'] },
        { classIndex: 4, texts: ['Threshold: 1.000000 g', '1.000000 g'] },
        { classIndex: 4, texts: ['ACT ac', 'ac'] },
        { classIndex: 4, texts: ['1600.000000'] },
        { classIndex: 4, texts: ['8 Hz'] },
        { classIndex: 4, texts: ['+/-2 g'] },
        { classIndex: 4, texts: ['X: 0x3412', '13312'] },
        { classIndex: 4, texts: ['Trigger'] },
        { classIndex: 4, texts: ['Samples: 5', '5'] },
        { classIndex: 4, texts: ['Entries: 63', '63'] },
        { classIndex: 0, texts: READ_TEXTS },
        { classIndex: 2, texts: MULTIPLE_TEXTS },
        { classIndex: 4, texts: ['170'] },
        { classIndex: 5, texts: ['Disable single/double tap'] },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: data.reduce((sum, transaction) => sum + transactionAnnotations(transaction), 0),
        payloadBits: data.reduce((sum, transaction) => sum + transaction.mosi.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    total = Math.ceil(required / 16),
    perBlock = 8192,
    blocks = Math.ceil(total / perBlock);
  yield {
    name: 'seeded-long-register-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: AdxlTransaction[] = [];
        for (let index = block * perBlock; index < Math.min(total, (block + 1) * perBlock); index++)
          data.push(write(0x00, [random() & 0xff]));
        const value = data[0]!.mosi[1]!,
          expectedAnnotations: ExpectedFrame[] = [
            { classIndex: 1, texts: WRITE_TEXTS },
            { classIndex: 2, texts: SINGLE_TEXTS },
            { classIndex: 3, texts: ['ADDRESS: 0x00', 'ADDR: 0x00', '0x00'] },
            { classIndex: 3, texts: ['0'] },
            { classIndex: 4, texts: [String(value)] },
          ];
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: data.length * 5,
          payloadBits: data.length * 16,
        };
      }
    },
  };
}
