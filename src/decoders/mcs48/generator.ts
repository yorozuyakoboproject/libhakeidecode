import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Mcs48Word {
  readonly address: number;
  readonly data: number;
}

export interface Mcs48Case extends RoundtripCase<Mcs48Word> {}

const SAMPLE_RATE = 4_000_000;
const BASE_CHANNELS = {
  ale: 0,
  psen: 1,
  d0: 2,
  d1: 3,
  d2: 4,
  d3: 5,
  d4: 6,
  d5: 7,
  d6: 8,
  d7: 9,
  a8: 10,
  a9: 11,
  a10: 12,
  a11: 13,
} as const;

function annotation(address: number, data: number): ExpectedFrame {
  return {
    classIndex: 0,
    texts: [
      `${address.toString(16).toUpperCase().padStart(4, '0')}:${data.toString(16).toUpperCase().padStart(2, '0')}`,
    ],
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d43533438,
}: GenerationOptions = {}): Iterable<Mcs48Case> {
  const boundary: readonly Mcs48Word[] = [
    { address: 0x0000, data: 0x00 },
    { address: 0x0123, data: 0x5a },
    { address: 0x0fff, data: 0xff },
  ];
  yield {
    name: 'twelve-bit-address-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 41n,
    channels: BASE_CHANNELS,
    options: {},
    chunkSamples: [1, 9, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: boundary,
        expected: [{ protoId: 'mcs48', kind: 'summary' }],
        expectedAnnotations: boundary.map((word) => annotation(word.address, word.data)),
        annotationCount: boundary.length,
        payloadBits: boundary.length * 20,
      };
    },
  };

  const banked: readonly Mcs48Word[] = [
    { address: 0x0000, data: 0xa5 },
    { address: 0x0800, data: 0x3c },
    { address: 0x1fff, data: 0xff },
  ];
  yield {
    name: 'thirteen-bit-address-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 9_007_199_254_740_990n,
    channels: { ...BASE_CHANNELS, a12: 14 },
    options: {},
    chunkSamples: [3, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: banked,
        expected: [{ protoId: 'mcs48', kind: 'summary' }],
        expectedAnnotations: banked.map((word) => annotation(word.address, word.data)),
        annotationCount: banked.length,
        payloadBits: banked.length * 21,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const wordsPerBlock = 13_000;
  const blocks = 4;
  yield {
    name: 'seeded-long-banked-program-fetch',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: { ...BASE_CHANNELS, a12: 14 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data = Array.from({ length: wordsPerBlock }, () => ({
          address: random() & 0x1fff,
          data: random() & 0xff,
        }));
        yield {
          data,
          expected: block === 0 ? [{ protoId: 'mcs48', kind: 'summary' }] : [],
          expectedAnnotations: [annotation(data[0]!.address, data[0]!.data)],
          annotationCount: data.length,
          payloadBits: data.length * 21,
        };
      }
    },
  };
}
