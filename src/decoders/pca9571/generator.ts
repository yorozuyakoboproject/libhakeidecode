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

export interface Pca9571Case extends RoundtripCase<I2COperation> {}

const SUMMARY: ExpectedFrame = { protoId: 'pca9571', kind: 'summary' };

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function operationBits(operation: I2COperation): number {
  return 9 * (1 + operation.data.length);
}

function outputAnnotation(value: number): ExpectedFrame {
  return { classIndex: 1, texts: [`Outputs set: ${hex(value)}`, `W: ${hex(value)}`] };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x50434152,
}: GenerationOptions = {}): Iterable<Pca9571Case> {
  const common = {
    seed,
    sampleRate: 800_000,
    channels: { scl: 0, sda: 1 },
    chain: [{ decoder: 'i2c', options: { address_format: 'shifted' } }],
  } as const;

  yield {
    ...common,
    name: 'boundary-write-read-and-warning',
    kind: 'boundary',
    startSample: 13n,
    options: {},
    chunkSamples: [17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: I2COperation[] = [
        { address: 0x25, direction: 'write', data: [0x00, 0xff] },
        { address: 0x25, direction: 'write', data: [0x55], stop: false },
        { address: 0x25, direction: 'read', data: [0xaa], repeatedStart: true },
        { address: 0x24, direction: 'write', data: [0x01] },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          outputAnnotation(0x00),
          outputAnnotation(0xff),
          outputAnnotation(0x55),
          { classIndex: 2, texts: ['Warning: read value and last write value (55) are different'] },
          { classIndex: 1, texts: ['Outputs read: AA', 'R: AA'] },
          { classIndex: 2, texts: ['Warning: I²C slave 0x24 not a PCA9571 compatible chip.'] },
        ],
        annotationCount: 6,
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  yield {
    ...common,
    name: 'boundary-address-nack-resets-state',
    kind: 'boundary',
    startSample: 9_007_199_254_740_991n,
    options: {},
    chunkSamples: [29, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: I2COperation[] = [{ address: 0x25, direction: 'write', data: [0x55], addressAck: false }];
      yield {
        data,
        expected: [SUMMARY],
        annotationCount: 0,
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const wordsPerTransaction = 8192;
  const transactionsPerBlock = 3;
  const bitsPerTransaction = 9 * (1 + wordsPerTransaction);
  const blocks = Math.ceil(required / (bitsPerTransaction * transactionsPerBlock));

  yield {
    ...common,
    name: 'seeded-long-write-stream',
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
        for (let index = 0; index < transactionsPerBlock; index++) {
          const values = Array.from({ length: wordsPerTransaction }, () => random() & 0xff);
          const operation: I2COperation = { address: 0x25, direction: 'write', data: values };
          data.push(operation);
          bits += operationBits(operation);
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [outputAnnotation(data[0]!.data[0]!)],
          annotationCount: data.reduce((sum, operation) => sum + operation.data.length, 0),
          payloadBits: bits,
        };
      }
    },
  };
}
