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

export interface Tca6408aCase extends RoundtripCase<I2COperation> {}

const SUMMARY: ExpectedFrame = { protoId: 'tca6408a', kind: 'summary' };

function operationBits(operation: I2COperation): number {
  return 9 * (1 + operation.data.length);
}

function registerAnnotation(index: 0 | 1 | 2 | 3): ExpectedFrame {
  return {
    classIndex: 0,
    texts: [
      ['Input port', 'In', 'I'],
      ['Output port', 'Out', 'O'],
      ['Polarity inversion register', 'Pol', 'P'],
      ['Configuration register', 'Conf', 'C'],
    ][index],
  };
}

function valueAnnotation(text: string): ExpectedFrame {
  return { classIndex: 1, texts: [text] };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x54434136,
}: GenerationOptions = {}): Iterable<Tca6408aCase> {
  const common = {
    seed,
    sampleRate: 800_000,
    channels: { scl: 2, sda: 5 },
    chain: [{ decoder: 'i2c', options: { address_format: 'shifted' } }],
  } as const;

  yield {
    ...common,
    name: 'boundary-registers-read-and-warning',
    kind: 'boundary',
    startSample: 23n,
    options: {},
    chunkSamples: [31, 509, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: I2COperation[] = [
        { address: 0x20, direction: 'write', data: [0, 0x00] },
        { address: 0x20, direction: 'write', data: [1, 0xff] },
        { address: 0x21, direction: 'write', data: [2, 0xaa] },
        { address: 0x21, direction: 'write', data: [3, 0x55] },
        { address: 0x22, direction: 'write', data: [1, 0x00] },
        { address: 0x20, direction: 'write', data: [1, 0x3c], stop: false },
        { address: 0x21, direction: 'read', data: [0x3c, 0x00], repeatedStart: true },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          registerAnnotation(0),
          valueAnnotation('State of inputs: 00'),
          registerAnnotation(1),
          valueAnnotation('Outputs set: FF'),
          registerAnnotation(2),
          valueAnnotation('Polarity inverted: AA'),
          registerAnnotation(3),
          valueAnnotation('Configuration: 55'),
          { classIndex: 2, texts: ['Warning: I²C slave 0x22 not a TCA6408A compatible chip.'] },
          registerAnnotation(1),
          valueAnnotation('Outputs set: 3C'),
          valueAnnotation('Outputs set: 3C'),
          valueAnnotation('Outputs set: 00'),
        ],
        annotationCount: 13,
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
    chunkSamples: [37, 509, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: I2COperation[] = [{ address: 0x20, direction: 'write', data: [3, 0x55], addressAck: false }];
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
  const bitsPerTransaction = 9 * (2 + wordsPerTransaction);
  const blocks = Math.ceil(required / (bitsPerTransaction * transactionsPerBlock));

  yield {
    ...common,
    name: 'seeded-long-output-writes',
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
          const operation: I2COperation = { address: 0x20, direction: 'write', data: [1, ...values] };
          data.push(operation);
          bits += operationBits(operation);
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [registerAnnotation(1)],
          annotationCount: data.reduce((sum, operation) => sum + operation.data.length, 0),
          payloadBits: bits,
        };
      }
    },
  };
}
