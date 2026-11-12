import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Ltc242xFrame {
  readonly words: readonly number[];
}

export interface Ltc242xCase extends RoundtripCase<Ltc242xFrame> {}

const channels = { clk: 3, miso: 0, mosi: 7, cs: 1 };

function spiOptions(wordsize = 8): Record<string, string | number> {
  return { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder: 'msb-first', wordsize };
}

export function ltc242xWord(raw: number, channel: number): Ltc242xFrame {
  const value = ((channel & 1) << 22) | (raw & 0x3fffff);
  return {
    words: [Math.floor(value / 0x10000) & 0xff, Math.floor(value / 0x100) & 0xff, value & 0xff],
  };
}

function voltage(raw: number, channel: number, vref: number): ExpectedFrame {
  const signed = raw - 0x200000;
  const value = (signed / 0xfffff) * vref;
  return { classIndex: channel, texts: [`${value.toFixed(6)}V`, `${value.toFixed(2)}V`] };
}

function summary(): ExpectedFrame {
  return { protoId: 'ltc242x', kind: 'summary' };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4c544332,
}: GenerationOptions = {}): Iterable<Ltc242xCase> {
  const boundaryValues: readonly (readonly [raw: number, channel: number])[] = [
    [0, 0],
    [0x3fffff, 0],
    [0x200000, 1],
    [0x1fffff, 1],
  ];
  yield {
    name: 'signed-channel-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 23n,
    channels,
    options: { vref: 2.5 },
    chain: [{ decoder: 'spi', options: spiOptions() }],
    chunkSamples: [3, 37, 509],
    minimumPayloadBits: 0,
    *generate() {
      const data = boundaryValues.map(([raw, channel]) => ltc242xWord(raw, channel));
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: boundaryValues.map(([raw, channel]) => voltage(raw, channel, 2.5)),
        annotationCount: data.length,
        payloadBits: data.length * 24,
      };
    },
  };

  const singleWord = ltc242xWord(0x123456, 0);
  yield {
    name: 'single-24-bit-word',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels,
    options: { vref: 1.5 },
    chain: [{ decoder: 'spi', options: spiOptions(24) }],
    chunkSamples: [1, 7, 127],
    minimumPayloadBits: 0,
    *generate() {
      const packed = singleWord.words[0]! * 0x10000 + singleWord.words[1]! * 0x100 + singleWord.words[2]!;
      const data: Ltc242xFrame[] = [{ words: [packed] }];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: [voltage(0x123456, 0, 1.5)],
        annotationCount: 1,
        payloadBits: 24,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalFrames = Math.ceil(required / 24);
  const perBlock = 4096;
  yield {
    name: 'seeded-long',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels,
    options: { vref: 4.096 },
    chain: [{ decoder: 'spi', options: spiOptions() }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < totalFrames; offset += perBlock) {
        const count = Math.min(perBlock, totalFrames - offset);
        const data: Ltc242xFrame[] = [];
        const expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const raw = random() & 0x3fffff;
          const channel = random() & 1;
          data.push(ltc242xWord(raw, channel));
          if (index === 0 || index === count - 1) expectedAnnotations.push(voltage(raw, channel, 4.096));
        }
        yield {
          data,
          expected: offset === 0 ? [summary()] : [],
          expectedAnnotations,
          annotationCount: count,
          payloadBits: count * 24,
        };
      }
    },
  };
}
