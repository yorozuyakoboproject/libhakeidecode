import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface T55Block {
  readonly bits: readonly number[];
}

export interface T55Case extends RoundtripCase<T55Block> {}

export const T55_SAMPLE_RATE = 25_000;
export const T55_COIL_FREQUENCY = 125_000;
export const T55_OPTIONS = {
  coilfreq: T55_COIL_FREQUENCY,
  start_gap: 20,
  w_gap: 1000,
  w_one_min: 48,
  w_one_max: 63,
  w_zero_min: 16,
  w_zero_max: 31,
  em4100_decode: 'on',
} as const;

function block(length: 70 | 38 | 2, random?: () => number): T55Block {
  const bits = Array.from({ length }, (_, index) => (random ? random() & 1 : index % 3 === 0 ? 1 : 0));
  if (bits.length === 70) {
    bits[67] = 0;
    bits[68] = 0;
    bits[69] = 0;
  } else if (bits.length === 38) {
    bits[35] = 1;
    bits[36] = 1;
    bits[37] = 1;
  }
  return { bits };
}

function annotationCount(item: T55Block): number {
  if (item.bits.length === 70) return 156;
  if (item.bits.length === 38) return 83;
  if (item.bits.length === 2) return 7;
  return 0;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x54353558,
}: GenerationOptions = {}): Iterable<T55Case> {
  const boundaries: readonly { name: string; block: T55Block; startSample: bigint }[] = [
    { name: 'full-config-block', block: block(70), startSample: 7n },
    { name: 'short-password-block', block: block(38), startSample: 0n },
    { name: 'opcode-only', block: block(2), startSample: 9_007_199_254_740_990n },
  ];
  for (const item of boundaries) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: T55_SAMPLE_RATE,
      startSample: item.startSample,
      channels: { data: 3 },
      options: { ...T55_OPTIONS },
      chunkSamples: [1, 7, 127, 4093],
      minimumPayloadBits: 0,
      *generate() {
        const expectedAnnotations: ExpectedFrame[] = [
          { classIndex: 1, texts: ['Start gap'] },
          { classIndex: 5 },
          { classIndex: 3, texts: ['Write mode exit'] },
        ];
        yield {
          data: [item.block],
          expected: [{ protoId: 't55xx', kind: 'summary' }],
          expectedAnnotations,
          annotationCount: annotationCount(item.block),
          payloadBits: item.block.bits.length,
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const count = Math.ceil(required / 70);
  const perBlock = 256;
  yield {
    name: 'seeded-long-write-blocks',
    kind: 'long',
    seed,
    sampleRate: T55_SAMPLE_RATE,
    startSample: 0n,
    channels: { data: 0 },
    options: { ...T55_OPTIONS },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < count; offset += perBlock) {
        const data = Array.from({ length: Math.min(perBlock, count - offset) }, () => block(70, random));
        const expectedAnnotations: ExpectedFrame[] =
          offset === 0
            ? [{ classIndex: 1, texts: ['Start gap'] }, { classIndex: 5 }]
            : [{ classIndex: 3, texts: ['Write mode exit'] }];
        yield {
          data,
          expected: offset === 0 ? [{ protoId: 't55xx', kind: 'summary' }] : [],
          expectedAnnotations,
          annotationCount: data.length * 156,
          payloadBits: data.length * 70,
        };
      }
    },
  };
}
