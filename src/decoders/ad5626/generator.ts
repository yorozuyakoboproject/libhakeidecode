import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Ad5626Frame {
  readonly mosi: readonly number[];
  readonly bits?: number;
}

export interface Ad5626Case extends RoundtripCase<Ad5626Frame> {}

const channels = { clk: 3, miso: 0, mosi: 7, cs: 1 };

function bytes16(value: number): number[] {
  return [Math.floor(value / 256) & 0xff, value & 0xff];
}

function voltage(value: number): ExpectedFrame {
  return { classIndex: 0, texts: [(value / 1000).toFixed(3) + 'V'] };
}

function summary(): ExpectedFrame {
  return { protoId: 'ad5626', kind: 'summary' };
}

function spiOptions(wordsize: number, bitorder = 'msb-first') {
  return { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder, wordsize };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0xad5626,
}: GenerationOptions = {}): Iterable<Ad5626Case> {
  const byteValues = [0x0000, 0x0001, 0x0fff, 0x7fff, 0x8000, 0xabcd, 0xffff, 0x0000];
  yield {
    name: 'byte-words-min-max',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 11n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = byteValues.map((value) => ({ mosi: bytes16(value) }));
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: byteValues.map(voltage),
        annotationCount: data.length,
        payloadBits: data.length * 16,
      };
    },
  };

  const wordValues = [0xffff, 0x0100, 0x7fff, 0x8000, 0x1234];
  yield {
    name: 'multi-byte-word',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(16) }],
    chunkSamples: [4093, 8191],
    minimumPayloadBits: 0,
    *generate() {
      const data = wordValues.map((value) => ({ mosi: bytes16(value) }));
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: wordValues.map(voltage),
        annotationCount: data.length,
        payloadBits: data.length * 16,
      };
    },
  };

  const lsbValues = [0x1234, 0xabcd, 0x00ff];
  yield {
    name: 'lsb-first-byte-words',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 5n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8, 'lsb-first') }],
    chunkSamples: [3, 31, 1021],
    minimumPayloadBits: 0,
    *generate() {
      const data = lsbValues.map((value) => ({ mosi: bytes16(value) }));
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: lsbValues.map(voltage),
        annotationCount: data.length,
        payloadBits: data.length * 16,
      };
    },
  };

  yield {
    name: 'partial-frame-boundary',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 19n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [2, 13, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data: Ad5626Frame[] = [{ mosi: bytes16(0x1234) }, { mosi: [0xab], bits: 8 }, { mosi: bytes16(0x00ff) }];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: [voltage(0x1234), voltage(0xab), voltage(0x00ff)],
        annotationCount: data.length,
        payloadBits: 16 + 8 + 16,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalFrames = Math.ceil(required / 16);
  const framesPerBlock = 4096;
  const blocks = Math.ceil(totalFrames / framesPerBlock);
  yield {
    name: 'seeded-long',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(framesPerBlock, totalFrames - block * framesPerBlock),
          data: Ad5626Frame[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const value = random() & 0xffff;
          data.push({ mosi: bytes16(value) });
          if (index === 0 || index === count - 1) expectedAnnotations.push(voltage(value));
        }
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations,
          annotationCount: data.length,
          payloadBits: data.length * 16,
        };
      }
    },
  };
}
