import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Em4100Tag {
  readonly bits: readonly number[];
  readonly valid?: boolean;
}

export interface Em4100Case extends RoundtripCase<Em4100Tag> {}

export const EM4100_SAMPLE_RATE = 62_500;
export const EM4100_BIT_SAMPLES = 8;

export function makeTag(nibbles: readonly number[], valid = true): Em4100Tag {
  if (nibbles.length !== 10) throw new RangeError('EM4100 requires ten data nibbles');
  const bits = [1, 1, 1, 1, 1, 1, 1, 1, 1];
  const columns = [0, 0, 0, 0];
  for (const nibble of nibbles) {
    const value = nibble & 0x0f;
    const row = [3, 2, 1, 0].map((shift) => (value >>> shift) & 1);
    bits.push(
      ...row,
      row.reduce((sum, bit) => sum ^ bit, 0),
    );
    for (let index = 0; index < 4; index++) columns[index] ^= row[index]!;
  }
  bits.push(...columns, 0);
  if (!valid) bits[60] ^= 1;
  return { bits, valid };
}

function randomTag(random: () => number): Em4100Tag {
  return makeTag(Array.from({ length: 10 }, () => random() & 0x0f));
}

function annotationCount(tags: readonly Em4100Tag[]): number {
  return tags.reduce((total, tag) => total + (tag.valid === false ? 91 : 92), 0);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x454d3431,
}: GenerationOptions = {}): Iterable<Em4100Case> {
  const base = {
    seed,
    sampleRate: EM4100_SAMPLE_RATE,
    channels: { data: 3 },
    options: { polarity: 'active-high', datarate: 16, coilfreq: 125_000 },
  };
  const boundaries: readonly { name: string; tags: readonly Em4100Tag[]; startSample: bigint; polarity: string }[] = [
    {
      name: 'valid-min-max-nibbles',
      startSample: 7n,
      polarity: 'active-high',
      tags: [makeTag([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), makeTag([15, 15, 15, 15, 15, 15, 15, 15, 15, 15])],
    },
    {
      name: 'valid-and-invalid-parity',
      startSample: 11n,
      polarity: 'active-high',
      tags: [makeTag([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), makeTag([0xf, 0, 0xf, 0, 0xa, 0x5, 0xa, 0x5, 3, 0xc], false)],
    },
    {
      name: 'active-low-large-position',
      startSample: 9_007_199_254_740_990n,
      polarity: 'active-low',
      tags: [makeTag([0x1, 0x8, 0x7, 0xe, 0x3, 0xc, 0x9, 0x6, 0xb, 0x4])],
    },
  ];

  for (const item of boundaries) {
    yield {
      ...base,
      name: item.name,
      kind: 'boundary',
      startSample: item.startSample,
      options: { ...base.options, polarity: item.polarity },
      chunkSamples: [1, 7, 127, 4093],
      minimumPayloadBits: 0,
      *generate() {
        const expectedAnnotations: ExpectedFrame[] = [
          { classIndex: 1, texts: ['Header', 'Head', 'He', 'H'] },
          { classIndex: 2 },
          { classIndex: 3 },
          { classIndex: 8, texts: ['Stop bit', 'SB', 'S'] },
          ...(item.tags[0]!.valid === false ? [] : [{ classIndex: 9 }]),
        ];
        yield {
          data: item.tags,
          expected: [{ protoId: 'em4100', kind: 'summary' }],
          expectedAnnotations,
          annotationCount: annotationCount(item.tags),
          payloadBits: item.tags.length * 64,
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const count = Math.ceil(required / 64);
  const perBlock = 256;
  yield {
    ...base,
    name: 'seeded-long-tags',
    kind: 'long',
    startSample: 7n,
    options: { ...base.options, polarity: 'active-high' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < count; offset += perBlock) {
        const tags = Array.from({ length: Math.min(perBlock, count - offset) }, () => randomTag(random));
        const expectedAnnotations: ExpectedFrame[] =
          offset === 0
            ? [{ classIndex: 1, texts: ['Header', 'Head', 'He', 'H'] }, { classIndex: 9 }]
            : [{ classIndex: 9 }];
        yield {
          data: tags,
          expected: offset === 0 ? [{ protoId: 'em4100', kind: 'summary' }] : [],
          expectedAnnotations,
          annotationCount: annotationCount(tags),
          payloadBits: tags.length * 64,
        };
      }
    },
  };
}
