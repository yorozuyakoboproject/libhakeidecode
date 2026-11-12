import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Ad79x0Frame {
  readonly miso: readonly number[];
  readonly bits?: number;
}

export interface Ad79x0Case extends RoundtripCase<Ad79x0Frame> {}

const channels = { clk: 3, miso: 0, mosi: 7, cs: 1 },
  NORMAL = ['Normal Mode', 'Normal', 'Norm', 'N'],
  POWER_DOWN = ['Power Down Mode', 'Power Down', 'PD'],
  POWER_UP = ['Power Up Mode', 'Power Up', 'PU'];

function bytes16(value: number): number[] {
  return [Math.floor(value / 256) & 0xff, value & 0xff];
}

function annotations(value: number, bits: number, vref: number): ExpectedFrame[] {
  const frames: ExpectedFrame[] = [];
  if (bits >= 10) {
    if (value === 0xfff) {
      frames.push({ classIndex: 0, texts: POWER_UP }, { classIndex: 2, texts: ['Invalid data', 'Invalid', 'N/A'] });
      return frames;
    }
    frames.push(
      { classIndex: 0, texts: NORMAL },
      {
        classIndex: 2,
        texts: bits === 16 ? ['Complete conversion', 'Complete', 'C'] : ['Incomplete conversion', 'Incomplete', 'I'],
      },
    );
    const voltage = (value / 4095) * vref;
    frames.push({ classIndex: 1, texts: [voltage.toFixed(6) + 'V', voltage.toFixed(2) + 'V'] });
  } else {
    frames.push({ classIndex: 0, texts: POWER_DOWN }, { classIndex: 2, texts: ['Invalid data', 'Invalid', 'N/A'] });
  }
  return frames;
}

function summary(): ExpectedFrame {
  return { protoId: 'ad79x0', kind: 'summary' };
}

function spiOptions(wordsize: number, bitorder = 'msb-first') {
  return { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder, wordsize };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0xad79,
}: GenerationOptions = {}): Iterable<Ad79x0Case> {
  const completeValues = [0x0000, 0x0001, 0x0800, 0x0abc, 0x0fff, 0x0123],
    completeVref = 2.5;
  yield {
    name: 'complete-modes-vref',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 13n,
    channels,
    options: { vref: completeVref },
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = completeValues.map((value) => ({ miso: bytes16(value) })),
        expectedAnnotations = completeValues.flatMap((value) => annotations(value, 16, completeVref));
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 16,
      };
    },
  };

  const wordValues = [0x0abc, 0x0800, 0x0fff],
    wordVref = 1.5;
  yield {
    name: 'multi-byte-word',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels,
    options: { vref: wordVref },
    chain: [{ decoder: 'spi', options: spiOptions(16) }],
    chunkSamples: [4093, 8191],
    minimumPayloadBits: 0,
    *generate() {
      const data = wordValues.map((value) => ({ miso: bytes16(value) })),
        expectedAnnotations = wordValues.flatMap((value) => annotations(value, 16, wordVref));
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 16,
      };
    },
  };

  const partialVref = 1.5;
  yield {
    name: 'incomplete-and-power-down',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 17n,
    channels,
    options: { vref: partialVref },
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [2, 31, 1021],
    minimumPayloadBits: 0,
    *generate() {
      const data: Ad79x0Frame[] = [
          { miso: bytes16(0x1234) },
          { miso: [0xaa, 0x00], bits: 10 },
          { miso: [0xab, 0x00], bits: 12 },
          { miso: [0xff, 0x00], bits: 15 },
          { miso: [0xaa], bits: 8 },
          { miso: bytes16(0x00ff) },
        ],
        expectedAnnotations = [
          ...annotations(0x1234, 16, partialVref),
          ...annotations(0xaa * 4, 10, partialVref),
          ...annotations(0xab * 16, 12, partialVref),
          ...annotations(0xff * 128, 15, partialVref),
          ...annotations(0xaa, 8, partialVref),
          ...annotations(0x00ff, 16, partialVref),
        ];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: 16 + 10 + 12 + 15 + 8 + 16,
      };
    },
  };

  const lsbValues = [0x0abc, 0x0123],
    lsbVref = 1.5;
  yield {
    name: 'lsb-first-byte-words',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 7n,
    channels,
    options: { vref: lsbVref },
    chain: [{ decoder: 'spi', options: spiOptions(8, 'lsb-first') }],
    chunkSamples: [3, 17, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data = lsbValues.map((value) => ({ miso: bytes16(value) })),
        expectedAnnotations = lsbValues.flatMap((value) => annotations(value, 16, lsbVref));
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 16,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    totalFrames = Math.ceil(required / 16),
    framesPerBlock = 4096,
    blocks = Math.ceil(totalFrames / framesPerBlock),
    longVref = 1.5;
  yield {
    name: 'seeded-long',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels,
    options: { vref: longVref },
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(framesPerBlock, totalFrames - block * framesPerBlock),
          data: Ad79x0Frame[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const value = random() % 0xfff;
          data.push({ miso: bytes16(value) });
          if (index === 0 || index === count - 1) expectedAnnotations.push(...annotations(value, 16, longVref));
        }
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations,
          annotationCount: data.length * 3,
          payloadBits: data.length * 16,
        };
      }
    },
  };
}
