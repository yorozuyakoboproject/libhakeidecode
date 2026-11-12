import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface I2SWord {
  readonly value: number;
  readonly bits: number;
}

export interface I2SCase extends RoundtripCase<I2SWord> {
  readonly initialWordSelect?: 0 | 1;
  readonly initialWordBits?: number;
}

export const I2S_DUMMY_BITS = 16;
export const I2S_SAMPLES_PER_BIT = 2;

const CHANNELS = { sck: 3, ws: 1, sd: 7 };

function wordText(value: number): string {
  return value.toString(16).padStart(8, '0');
}

function wordFrames(
  data: readonly I2SWord[],
  start: bigint,
  firstIndex: number,
  warnings: { previousBits: number },
): { frames: ExpectedFrame[]; annotations: ExpectedFrame[]; annotationsCount: number; end: bigint } {
  const frames: ExpectedFrame[] = [];
  const annotations: ExpectedFrame[] = [];
  let cursor = start;
  let annotationsCount = 0;
  for (let offset = 0; offset < data.length; offset++) {
    const word = data[offset]!;
    const es = cursor + BigInt(I2S_SAMPLES_PER_BIT * word.bits);
    const left = (firstIndex + offset) % 2 === 0;
    const channel = left ? 'L' : 'R';
    frames.push({
      ss: cursor,
      es,
      protoId: 'i2s',
      kind: 'protocol',
      data: ['DATA', [channel, word.value]],
    });
    annotations.push({
      ss: cursor,
      es,
      classIndex: left ? 0 : 1,
      texts: [
        `${left ? 'Left channel' : 'Right channel'}: ${wordText(word.value)}`,
        `${left ? 'Left' : 'Right'}: ${wordText(word.value)}`,
        `${channel}: ${wordText(word.value)}`,
        channel,
      ],
    });
    annotationsCount++;
    if (warnings.previousBits !== -1 && warnings.previousBits !== word.bits) {
      annotations.push({
        ss: cursor,
        es,
        classIndex: 2,
        texts: [`Received ${word.bits}-bit word, expected ${warnings.previousBits}-bit word`],
      });
      annotationsCount++;
    }
    warnings.previousBits = word.bits;
    cursor = es;
  }
  return { frames, annotations, annotationsCount, end: cursor };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x493253,
}: GenerationOptions = {}): Iterable<I2SCase> {
  yield {
    name: 'sixteen-bit-min-max',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 17n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: I2SWord[] = [
        { value: 0x0000, bits: 16 },
        { value: 0xffff, bits: 16 },
        { value: 0x8000, bits: 16 },
      ];
      const result = wordFrames(data, 17n + BigInt(I2S_SAMPLES_PER_BIT * I2S_DUMMY_BITS), 0, {
        previousBits: -1,
      });
      yield {
        data,
        expected: result.frames,
        expectedAnnotations: result.annotations,
        annotationCount: result.annotationsCount,
        payloadBits: 48,
      };
    },
  };

  yield {
    name: 'variable-word-length',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [3, 31, 1021],
    minimumPayloadBits: 0,
    *generate() {
      const data: I2SWord[] = [
        { value: 0xab, bits: 8 },
        { value: 0x1234, bits: 16 },
        { value: 0x5a, bits: 8 },
      ];
      const result = wordFrames(data, 9_007_199_254_740_990n + BigInt(I2S_SAMPLES_PER_BIT * I2S_DUMMY_BITS), 0, {
        previousBits: -1,
      });
      yield {
        data,
        expected: result.frames,
        expectedAnnotations: result.annotations,
        annotationCount: result.annotationsCount,
        payloadBits: 32,
      };
    },
  };

  yield {
    name: 'initial-ws-zero-paired',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 13n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [2, 5, 61],
    minimumPayloadBits: 0,
    initialWordSelect: 0,
    initialWordBits: 5,
    *generate() {
      const data: I2SWord[] = [
        { value: 0x0001, bits: 16 },
        { value: 0x8002, bits: 16 },
        { value: 0x7fff, bits: 16 },
        { value: 0xfffe, bits: 16 },
        { value: 0xaaaa, bits: 16 },
      ];
      const result = wordFrames(data, 13n + BigInt(I2S_SAMPLES_PER_BIT * 5), 1, {
        previousBits: -1,
      });
      yield {
        data,
        expected: result.frames,
        expectedAnnotations: result.annotations,
        annotationCount: result.annotationsCount,
        payloadBits: 80,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const words = Math.ceil(required / 16);
  const perBlock = 2048;
  yield {
    name: 'seeded-long-sixteen-bit',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let index = 0;
      let cursor = 32n;
      let previousBits = -1;
      for (let offset = 0; offset < words; offset += perBlock) {
        const count = Math.min(perBlock, words - offset);
        const data: I2SWord[] = Array.from({ length: count }, () => ({ value: random() & 0xffff, bits: 16 }));
        const first = wordFrames(data, cursor, index, { previousBits });
        yield {
          data,
          expected: first.frames,
          expectedAnnotations: first.annotations.slice(0, 1),
          annotationCount: count,
          payloadBits: count * 16,
        };
        index += count;
        cursor = first.end;
        previousBits = 16;
      }
    },
  };
}
