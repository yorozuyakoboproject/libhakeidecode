import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export type DaliFrame =
  | { readonly kind: 'forward'; readonly address: number; readonly data: number }
  | { readonly kind: 'backward'; readonly reply: number };

export interface DaliCase extends RoundtripCase<DaliFrame> {}

interface Timing {
  readonly sampleRate: number;
  readonly startSample: bigint;
}

const LEAD_HALVES = 1;

export function daliHalfbit(sampleRate: number): number {
  return Math.trunc((sampleRate * 0.0008333) / 2);
}

export function daliFrameBits(frame: DaliFrame): number[] {
  const bits = [1];
  if (frame.kind === 'backward') {
    for (let shift = 7; shift >= 0; shift--) bits.push((frame.reply >>> shift) & 1);
  } else {
    for (let shift = 7; shift >= 0; shift--) bits.push((frame.address >>> shift) & 1);
    for (let shift = 7; shift >= 0; shift--) bits.push((frame.data >>> shift) & 1);
  }
  return bits;
}

function frameHalves(frame: DaliFrame): number {
  return daliFrameBits(frame).length * 2 + 4;
}

function frameStart(timing: Timing, frames: readonly DaliFrame[], index: number): bigint {
  let halves = 0;
  for (let cursor = 0; cursor < index; cursor++) halves += frameHalves(frames[cursor]!);
  return timing.startSample + BigInt((halves + LEAD_HALVES) * daliHalfbit(timing.sampleRate));
}

function bitInterval(
  timing: Timing,
  frames: readonly DaliFrame[],
  frameIndex: number,
  bitIndex: number,
): { ss: bigint; es: bigint } {
  const halfbit = daliHalfbit(timing.sampleRate);
  const ss = frameStart(timing, frames, frameIndex) + BigInt(bitIndex * 2 * halfbit);
  return { ss, es: ss + BigInt(2 * halfbit) };
}

function annotationCount(frame: DaliFrame): number {
  const bits = daliFrameBits(frame).length;
  if (frame.kind === 'backward') return bits + 4;
  const extended = frame.address >= 160 && frame.address < 254;
  return bits + (extended || frame.address >= 254 ? 7 : 8);
}

function firstAnnotations(timing: Timing, frames: readonly DaliFrame[]): ExpectedFrame[] {
  const first = frames[0]!;
  const bit = bitInterval(timing, frames, 0, 0);
  const annotations: ExpectedFrame[] = [
    { ss: bit.ss, es: bit.es, classIndex: 0, texts: [String(daliFrameBits(first)[0]!)] },
    { ss: bit.ss, es: bit.es, classIndex: 1 },
  ];
  if (first.kind === 'backward') annotations.push({ ...bitInterval(timing, frames, 0, 1), classIndex: 6 });
  return annotations;
}

function lastAnnotation(timing: Timing, frames: readonly DaliFrame[]): ExpectedFrame {
  const index = frames.length - 1;
  const frame = frames[index]!;
  if (frame.kind === 'backward') {
    return {
      ss: bitInterval(timing, frames, index, 1).ss,
      es: bitInterval(timing, frames, index, 8).es,
      classIndex: 6,
    };
  }
  return {
    ss: bitInterval(timing, frames, index, 9).ss,
    es: bitInterval(timing, frames, index, 16).es,
    classIndex: 5,
  };
}

function summary(): ExpectedFrame {
  return { protoId: 'dali', kind: 'summary' };
}

function payloadBits(frames: readonly DaliFrame[]): number {
  return frames.reduce((total, frame) => total + daliFrameBits(frame).length, 0);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x44414c49,
}: GenerationOptions = {}): Iterable<DaliCase> {
  const boundaryFrames: DaliFrame[] = [
    { kind: 'forward', address: 0x00, data: 0x00 },
    { kind: 'forward', address: 0x03, data: 0x20 },
    { kind: 'forward', address: 0x82, data: 0x10 },
    { kind: 'forward', address: 0xfe, data: 0x00 },
    { kind: 'forward', address: 0xa3, data: 0x05 },
    { kind: 'forward', address: 0xc1, data: 0x08 },
    { kind: 'forward', address: 0x01, data: 0xe7 },
    { kind: 'backward', reply: 0x5a },
  ];
  const boundaryTiming = { sampleRate: 10_000, startSample: 17n };
  yield {
    name: 'forward-and-backward-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: boundaryTiming.sampleRate,
    startSample: boundaryTiming.startSample,
    channels: { dali: 2 },
    options: { polarity: 'active-low' },
    chunkSamples: [1, 7, 31, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const expectedAnnotations = firstAnnotations(boundaryTiming, boundaryFrames);
      expectedAnnotations.push(lastAnnotation(boundaryTiming, boundaryFrames));
      yield {
        data: boundaryFrames,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: boundaryFrames.reduce((count, frame) => count + annotationCount(frame), 0),
        payloadBits: payloadBits(boundaryFrames),
      };
    },
  };

  const highFrames: DaliFrame[] = [
    { kind: 'forward', address: 0xfe, data: 0xff },
    { kind: 'backward', reply: 0x00 },
    { kind: 'backward', reply: 0xff },
  ];
  const highTiming = {
    sampleRate: 10_000,
    startSample: 9_007_199_254_740_990n - BigInt(LEAD_HALVES * daliHalfbit(10_000)),
  };
  yield {
    name: 'active-high-large-sample',
    kind: 'boundary',
    seed,
    sampleRate: highTiming.sampleRate,
    startSample: highTiming.startSample,
    channels: { dali: 5 },
    options: { polarity: 'active-high' },
    chunkSamples: [3, 13, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const expectedAnnotations = firstAnnotations(highTiming, highFrames);
      expectedAnnotations.push(lastAnnotation(highTiming, highFrames));
      yield {
        data: highFrames,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: highFrames.reduce((count, frame) => count + annotationCount(frame), 0),
        payloadBits: payloadBits(highFrames),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalFrames = Math.ceil(required / 9);
  const perBlock = 1024;
  const longTiming = { sampleRate: 10_000, startSample: 0n };
  const replyHalves = frameHalves({ kind: 'backward', reply: 0 });
  yield {
    name: 'seeded-long-replies',
    kind: 'long',
    seed,
    sampleRate: longTiming.sampleRate,
    startSample: longTiming.startSample,
    channels: { dali: 0 },
    options: { polarity: 'active-low' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let frameIndex = 0;
      for (let offset = 0; offset < totalFrames; offset += perBlock) {
        const count = Math.min(perBlock, totalFrames - offset);
        const data: DaliFrame[] = [];
        for (let index = 0; index < count; index++) data.push({ kind: 'backward', reply: random() & 0xff });
        const blockTiming = {
          sampleRate: longTiming.sampleRate,
          startSample: longTiming.startSample + BigInt(frameIndex * replyHalves * daliHalfbit(longTiming.sampleRate)),
        };
        const first = firstAnnotations(blockTiming, data)[0]!;
        const last = lastAnnotation(blockTiming, data);
        yield {
          data,
          expected: frameIndex === 0 ? [summary()] : [],
          expectedAnnotations: [first, last],
          annotationCount: count * 13,
          payloadBits: count * 9,
        };
        frameIndex += count;
      }
    },
  };
}
