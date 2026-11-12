import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Em4305Block {
  readonly bits: readonly number[];
}

export interface Em4305Case extends RoundtripCase<Em4305Block> {}

export const EM4305_SAMPLE_RATE = 25_000;
export const EM4305_COIL_FREQUENCY = 125_000;
export const EM4305_OPTIONS = {
  coilfreq: EM4305_COIL_FREQUENCY,
  first_field_stop: 40,
  w_gap: 1000,
  w_one_max: 32,
  w_zero_on_min: 15,
  w_zero_off_max: 27,
  em4100_decode: 'on',
} as const;

function setMsbBits(bits: number[], index: number, count: number, value: number): void {
  for (let offset = 0; offset < count; offset++) bits[index + offset] = (value >>> (count - offset - 1)) & 1;
}

function setLsbBits(bits: number[], index: number, count: number, value: number): void {
  for (let offset = 0; offset < count; offset++) bits[index + offset] = (value >>> offset) & 1;
}

function makeBlock(length: 50 | 57, random?: () => number): Em4305Block {
  const bits = Array.from({ length }, (_, index) => (random ? random() & 1 : index % 4 === 0 ? 1 : 0));
  bits[0] = 0;
  setMsbBits(bits, 1, 3, 1);
  if (bits.length === 57) setLsbBits(bits, 5, 4, random ? 5 : 4);
  return { bits };
}

function annotationCount(item: Em4305Block): number {
  if (item.bits.length === 50) return 68;
  if (item.bits.length === 57) return 92;
  return 0;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x454d3433,
}: GenerationOptions = {}): Iterable<Em4305Case> {
  const boundaries: readonly { name: string; block: Em4305Block; startSample: bigint }[] = [
    { name: 'login-password', block: makeBlock(50), startSample: 9n },
    { name: 'config-word', block: makeBlock(57), startSample: 0n },
    { name: 'large-sample-position', block: makeBlock(50), startSample: 9_007_199_254_740_990n },
  ];
  for (const item of boundaries) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: EM4305_SAMPLE_RATE,
      startSample: item.startSample,
      channels: { data: 2 },
      options: { ...EM4305_OPTIONS },
      chunkSamples: [1, 7, 127, 4093],
      minimumPayloadBits: 0,
      *generate() {
        const expectedAnnotations: ExpectedFrame[] = [
          { classIndex: 1, texts: ['First field stop', 'Field stop', 'FFS'] },
          { classIndex: 5 },
          { classIndex: 3, texts: ['Write mode exit'] },
        ];
        yield {
          data: [item.block],
          expected: [{ protoId: 'em4305', kind: 'summary' }],
          expectedAnnotations,
          annotationCount: annotationCount(item.block),
          payloadBits: item.block.bits.length,
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const count = Math.ceil(required / 50);
  const perBlock = 256;
  yield {
    name: 'seeded-long-login-blocks',
    kind: 'long',
    seed,
    sampleRate: EM4305_SAMPLE_RATE,
    startSample: 0n,
    channels: { data: 1 },
    options: { ...EM4305_OPTIONS },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < count; offset += perBlock) {
        const data = Array.from({ length: Math.min(perBlock, count - offset) }, () => makeBlock(50, random));
        const expectedAnnotations: ExpectedFrame[] =
          offset === 0
            ? [
                { classIndex: 1, texts: ['First field stop', 'Field stop', 'FFS'] },
                { classIndex: 5, texts: ['Login'] },
              ]
            : [{ classIndex: 3, texts: ['Write mode exit'] }];
        yield {
          data,
          expected: offset === 0 ? [{ protoId: 'em4305', kind: 'summary' }] : [],
          expectedAnnotations,
          annotationCount: data.length * 68,
          payloadBits: data.length * 50,
        };
      }
    },
  };
}
