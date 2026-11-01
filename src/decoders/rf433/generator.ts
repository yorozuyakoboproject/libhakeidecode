import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface RF433Word {
  readonly code?: number;
  readonly trits?: readonly number[];
  readonly invalid?: boolean;
  readonly noise?: boolean;
}
export interface RF433Case extends RoundtripCase<RF433Word> {}

function base3(digits: readonly number[]): number {
  let value = 0;
  for (const digit of digits) value = value * 3 + digit;
  return value;
}

function expected(word: RF433Word, encoding: string): ExpectedFrame {
  if (encoding === 'ev1527') {
    const code = (word.code ?? 0) & 0xffffff & (word.invalid ? ~(1 << 11) : 0xffffff);
    return {
      encoding,
      address: code >>> 4,
      button: code & 0x0f,
      code,
      valid: !word.invalid,
    };
  }
  const trits = word.trits ?? [];
  return {
    encoding,
    address: base3(trits.slice(0, 8)),
    button: base3(trits.slice(8, 12)),
    code: base3(trits),
    valid: true,
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x524634,
}: GenerationOptions = {}): Iterable<RF433Case> {
  const boundaries = [
    { name: 'ev1527', encoding: 'ev1527', repeat: true },
    { name: 'ev1527-invalid-pulse', encoding: 'ev1527', invalid: true },
    { name: 'pt2262-tristate', encoding: 'pt2262', trits: [0, 1, 2, 0, 2, 1, 1, 0, 1, 2, 0, 1] },
    {
      name: 'pt2262-repeat-noise',
      encoding: 'pt2262',
      trits: [2, 2, 0, 1, 1, 0, 2, 1, 0, 1, 1, 2],
      repeat: true,
      noise: true,
    },
  ];
  for (const item of boundaries) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: 2_000_000,
      startSample: item.name === 'pt2262-repeat-noise' ? 9_007_199_254_740_990n : 8n,
      channels: { data: 6 },
      options: { encoding: item.encoding },
      chunkSamples: [1, 29, 257, 4093],
      minimumPayloadBits: 0,
      *generate() {
        const base: RF433Word =
          item.encoding === 'ev1527' ? { code: 0x35a7c1, invalid: item.invalid } : { trits: item.trits };
        const data: RF433Word[] = item.noise ? [{ noise: true }] : [];
        data.push(base);
        if (item.repeat) data.push(base, base, base);
        if (item.noise) data.push({ noise: true }, base);
        const expectedFrames = data.filter((word) => !word.noise).map((word) => expected(word, item.encoding));
        yield {
          data,
          expected: expectedFrames,
          payloadBits: expectedFrames.length * (item.encoding === 'ev1527' ? 24 : 12),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const count = Math.ceil(required / 24);
  const perBlock = 256;
  yield {
    name: 'seeded-long-ev1527',
    kind: 'long',
    seed,
    sampleRate: 20_000,
    startSample: 0n,
    channels: { data: 1 },
    options: { encoding: 'ev1527' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < count; offset += perBlock) {
        const data: RF433Word[] = [],
          expectedFrames: ExpectedFrame[] = [];
        for (let index = offset; index < Math.min(count, offset + perBlock); index++) {
          const word = { code: random() & 0xffffff };
          data.push(word);
          expectedFrames.push(expected(word, 'ev1527'));
        }
        yield { data, expected: expectedFrames, payloadBits: data.length * 24 };
      }
    },
  };
}
