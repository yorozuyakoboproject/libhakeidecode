import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface SPIWord {
  readonly mosi?: number;
  readonly miso?: number;
}
export interface SPICase extends RoundtripCase<SPIWord> {}

function channels(hasMiso: boolean, hasMosi: boolean, hasCs: boolean): Record<string, number> {
  return {
    clk: 3,
    ...(hasMiso ? { miso: 0 } : {}),
    ...(hasMosi ? { mosi: 7 } : {}),
    ...(hasCs ? { cs: 1 } : {}),
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x535049,
}: GenerationOptions = {}): Iterable<SPICase> {
  const boundaries = [
    { name: 'mode-0-msb-8-duplex', cpol: 0, cpha: 0, bits: 8, order: 'msb-first', miso: true, mosi: true, cs: true },
    { name: 'mode-1-lsb-1-mosi', cpol: 0, cpha: 1, bits: 1, order: 'lsb-first', mosi: true, cs: true },
    { name: 'mode-2-lsb-16-miso', cpol: 1, cpha: 0, bits: 16, order: 'lsb-first', miso: true, cs: true },
    { name: 'mode-3-msb-16-duplex', cpol: 1, cpha: 1, bits: 16, order: 'msb-first', miso: true, mosi: true, cs: true },
    {
      name: 'mode-0-lsb-32-duplex-no-cs',
      cpol: 0,
      cpha: 0,
      bits: 32,
      order: 'lsb-first',
      miso: true,
      mosi: true,
      cs: false,
    },
    {
      name: 'mode-2-msb-32-miso-no-cs',
      cpol: 1,
      cpha: 0,
      bits: 32,
      order: 'msb-first',
      miso: true,
      cs: false,
    },
    {
      name: 'mode-3-msb-8-cs-high',
      cpol: 1,
      cpha: 1,
      bits: 8,
      order: 'msb-first',
      mosi: true,
      cs: true,
      polarity: 'active-high',
    },
  ];
  for (const item of boundaries) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: 4_000_000,
      startSample: item.name === 'mode-3-msb-16-duplex' ? 9_007_199_254_740_990n : 11n,
      channels: channels(!!item.miso, !!item.mosi, !!item.cs),
      options: {
        cs_polarity: item.polarity ?? 'active-low',
        cpol: item.cpol,
        cpha: item.cpha,
        bitorder: item.order,
        wordsize: item.bits,
      },
      chunkSamples: [1, 7, 127, 4093],
      minimumPayloadBits: 0,
      *generate() {
        const data: SPIWord[] = [],
          expected: ExpectedFrame[] = [],
          mask = 2 ** item.bits - 1;
        for (let index = 0; index < 24; index++) {
          const raw = ([0, mask, 1, mask - 1, 0x5a5a5a5a & mask, 0xa5a5a5a5 & mask][index % 6]! & mask) >>> 0;
          const word: SPIWord = {
            ...(item.mosi ? { mosi: raw } : {}),
            ...(item.miso ? { miso: (raw ^ mask) >>> 0 } : {}),
          };
          data.push(word);
          expected.push({
            mosi: item.mosi ? (word.mosi ?? null) : null,
            miso: item.miso ? (word.miso ?? null) : null,
            cs: item.cs ? true : null,
            wordIndex: index,
          });
        }
        yield { data, expected, payloadBits: data.length * item.bits };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const words = Math.ceil(required / 8);
  const perBlock = 256;
  yield {
    name: 'seeded-long-mode-0-duplex',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: channels(true, true, true),
    options: { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder: 'msb-first', wordsize: 8 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < words; offset += perBlock) {
        const data: SPIWord[] = [],
          expected: ExpectedFrame[] = [];
        for (let index = offset; index < Math.min(words, offset + perBlock); index++) {
          const word = { mosi: random() & 0xff, miso: random() & 0xff };
          data.push(word);
          expected.push({ mosi: word.mosi, miso: word.miso, cs: true, wordIndex: index });
        }
        yield { data, expected, payloadBits: data.length * 8 };
      }
    },
  };
}
