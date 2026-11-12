import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface SdaTransaction {
  readonly command: readonly number[];
  readonly chipEnableData: 0 | 1;
  readonly readData: readonly number[];
}

export interface Sda2506Case extends RoundtripCase<SdaTransaction> {}

const CHANNELS = { clk: 3, d: 0, ce: 1 } as const;
const SUMMARY: ExpectedFrame = { protoId: 'sda2506', kind: 'summary' };

function lsbBits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >>> index) & 1);
}

function readTransaction(address: number, data: readonly number[]): SdaTransaction {
  return {
    command: [...lsbBits(address, 7), 0],
    chipEnableData: 0,
    readData: data,
  };
}

function writeTransaction(address: number, value: number): SdaTransaction {
  return {
    command: [...lsbBits(value, 8), ...lsbBits(address, 7), 1],
    chipEnableData: 0,
    readData: [],
  };
}

function eraseTransaction(address: number): SdaTransaction {
  return {
    command: [...lsbBits(address, 7), 1],
    chipEnableData: 1,
    readData: [],
  };
}

function options(): Record<string, string> {
  return {};
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53444132,
}: GenerationOptions = {}): Iterable<Sda2506Case> {
  yield {
    name: 'read-write-erase',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_000n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = [readTransaction(0x25, [0xa5, 0x3c]), writeTransaction(0x12, 0x5a), eraseTransaction(0x33)];
      const expectedAnnotations: ExpectedFrame[] = [
        { classIndex: 3, texts: ['addr: 25'] },
        { classIndex: 3, texts: ['CB: 00'] },
        { classIndex: 3, texts: ['read: 25'] },
        { classIndex: 2, texts: ['read'] },
        { classIndex: 3, texts: ['A5'] },
        { classIndex: 3, texts: ['3C'] },
        { classIndex: 3, texts: ['addr: 12'] },
        { classIndex: 3, texts: ['CB: 01'] },
        { classIndex: 3, texts: ['data: 5A'] },
        { classIndex: 2, texts: ['Write to 12: 5A'] },
        { classIndex: 3, texts: ['addr: 33'] },
        { classIndex: 3, texts: ['CB: 01'] },
        { classIndex: 2, texts: ['Erase: 33'] },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 61,
        payloadBits: data.reduce((sum, item) => sum + item.command.length + item.readData.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    transactionsPerBlock = 32,
    bytesPerTransaction = 256,
    bitsPerTransaction = 8 + bytesPerTransaction * 8,
    transactions = Math.ceil(required / bitsPerTransaction);
  yield {
    name: 'seeded-long-read-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < transactions; offset += transactionsPerBlock) {
        const count = Math.min(transactionsPerBlock, transactions - offset),
          data: SdaTransaction[] = [];
        for (let index = 0; index < count; index++)
          data.push(
            readTransaction(
              (offset + index) & 0x7f,
              Array.from({ length: bytesPerTransaction }, () => random() & 0xff),
            ),
          );
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations: [{ classIndex: 2, texts: ['read'] }],
          annotationCount: count * (12 + bytesPerTransaction * 9),
          payloadBits: count * bitsPerTransaction,
        };
      }
    },
  };
}
