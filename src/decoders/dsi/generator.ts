import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { dsiLevel } from './index.js';

export interface DsiFrame {
  readonly kind: 'backward' | 'forward';
  readonly value: number;
}

export interface DsiCase extends RoundtripCase<DsiFrame> {}

const SUMMARY: ExpectedFrame = { protoId: 'dsi', kind: 'summary' };

export function dsiDecodedBits(frame: DsiFrame, startBit = 0): number[] {
  const width = frame.kind === 'forward' ? 16 : 8;
  return [startBit, ...Array.from({ length: width }, (_, index) => (frame.value >>> (width - index - 1)) & 1)];
}

function frameAnnotations(frame: DsiFrame, startBit = 0): ExpectedFrame[] {
  const bits = dsiDecodedBits(frame, startBit);
  const result: ExpectedFrame[] = bits.map((bit) => ({ classIndex: 0, texts: [String(bit)] }));
  const start = [`Startbit: ${bits[0]}`, `ST: ${bits[0]}`, 'ST', 'S', 'S'];
  result.push({ classIndex: 1, texts: start }, { classIndex: 3, texts: start });
  if (frame.kind === 'backward') {
    const value = frame.value & 0xff;
    const hex = value.toString(16).toUpperCase().padStart(2, '0');
    result.push(
      { classIndex: 3, texts: [`Data: ${hex}`, `Dat: ${hex}`, `Dat: ${hex}`, `D: ${hex}`, 'D'] },
      {
        classIndex: 2,
        texts: [
          `Level: ${dsiLevel(value)}%`,
          `Lev: ${dsiLevel(value)}%`,
          `Lev: ${dsiLevel(value)}%`,
          `L: ${dsiLevel(value)}`,
          'D',
        ],
      },
    );
  }
  return result;
}

function frameBits(frame: DsiFrame): number {
  return frame.kind === 'forward' ? 16 : 8;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x445349,
}: GenerationOptions = {}): Iterable<DsiCase> {
  yield {
    name: 'backward-min-max-and-forward',
    kind: 'boundary',
    seed,
    sampleRate: 2_400,
    startSample: 9_007_199_254_740_990n,
    channels: { dsi: 2 },
    options: { polarity: 'active-high' },
    chunkSamples: [1, 7, 31, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data: DsiFrame[] = [
        { kind: 'backward', value: 0x00 },
        { kind: 'backward', value: 0xff },
        { kind: 'forward', value: 0xaaaa },
        { kind: 'backward', value: 0x55 },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: data.flatMap((frame) => frameAnnotations(frame)),
        annotationCount: data.reduce((sum, frame) => sum + (frame.kind === 'forward' ? 19 : 13), 0),
        payloadBits: data.reduce((sum, frame) => sum + frameBits(frame), 0),
      };
    },
  };
  yield {
    name: 'active-low-backward',
    kind: 'boundary',
    seed,
    sampleRate: 2_400,
    startSample: 23n,
    channels: { dsi: 5 },
    options: { polarity: 'active-low' },
    chunkSamples: [3, 17, 513],
    minimumPayloadBits: 0,
    *generate() {
      const data: DsiFrame[] = [{ kind: 'backward', value: 0x81 }];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: frameAnnotations(data[0]!, 0),
        annotationCount: 13,
        payloadBits: 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const framesPerBlock = 65_536;
  const blocks = Math.ceil(required / (framesPerBlock * 8));
  yield {
    name: 'seeded-long-backward',
    kind: 'long',
    seed,
    sampleRate: 2_400,
    startSample: 0n,
    channels: { dsi: 0 },
    options: { polarity: 'active-high' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data = Array.from({ length: framesPerBlock }, (): DsiFrame => ({
          kind: 'backward',
          value: random() & 0xff,
        }));
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: frameAnnotations(data[0]!).slice(0, 4),
          annotationCount: data.length * 13,
          payloadBits: data.length * 8,
        };
      }
    },
  };
}
