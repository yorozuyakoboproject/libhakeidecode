import { createPackedWindow } from '../libhakeidecode/signal.js';
import type { OptionValue, SignalWindow } from '../libhakeidecode/types.js';

export const MIN_PAYLOAD_BITS = 1_048_576;

export type ExpectedValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | readonly unknown[]
  | { value: number; tolerance: number };
export type ExpectedFrame = Readonly<Record<string, ExpectedValue>>;

export interface GeneratedBlock<T> {
  readonly data: readonly T[];
  readonly expected: readonly ExpectedFrame[];
  readonly expectedAnnotations?: readonly ExpectedFrame[];
  readonly annotationCount?: number;
  readonly payloadBits: number;
}

export interface RoundtripConfig {
  readonly name: string;
  readonly kind: 'boundary' | 'long';
  readonly seed: number;
  readonly sampleRate: number;
  readonly channels: Readonly<Record<string, number>>;
  readonly options: Record<string, OptionValue>;
  readonly startSample: bigint;
  readonly chunkSamples: readonly number[];
  readonly minimumPayloadBits: number;
  readonly chain?: readonly RoundtripChainNode[];
}

export interface RoundtripChainNode {
  readonly decoder: string;
  readonly options: Record<string, OptionValue>;
}

export interface RoundtripCase<T> extends RoundtripConfig {
  generate(): Iterable<GeneratedBlock<T>>;
}

export interface WaveformEncoder<T> {
  push(data: readonly T[]): Iterable<SignalWindow>;
  finish(): Iterable<SignalWindow>;
}

export interface GenerationOptions {
  readonly minimumPayloadBits?: number;
  readonly seed?: number;
}

export function randomWords(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}

export class PackedWaveformWriter {
  private buffer: Uint8Array;
  private offset = 0;
  private chunk = 0;
  private start: bigint;

  constructor(private readonly config: RoundtripConfig) {
    if (!config.chunkSamples.length || config.chunkSamples.some((size) => !Number.isSafeInteger(size) || size < 1))
      throw new RangeError('Waveform chunk sizes must be positive integers');
    this.buffer = new Uint8Array(config.chunkSamples[0]!);
    this.start = config.startSample;
  }

  *write(value: number, samples: number): Iterable<SignalWindow> {
    if (!Number.isSafeInteger(samples) || samples < 0) throw new RangeError('Invalid waveform run length');
    while (samples > 0) {
      const count = Math.min(samples, this.buffer.length - this.offset);
      this.buffer.fill(value, this.offset, this.offset + count);
      this.offset += count;
      samples -= count;
      if (this.offset === this.buffer.length) {
        yield createPackedWindow(this.start, this.config.sampleRate, this.buffer, this.config.channels);
        this.start += BigInt(this.buffer.length);
        this.chunk++;
        this.buffer = new Uint8Array(this.config.chunkSamples[this.chunk % this.config.chunkSamples.length]!);
        this.offset = 0;
      }
    }
  }

  *finish(): Iterable<SignalWindow> {
    if (!this.offset) return;
    yield createPackedWindow(
      this.start,
      this.config.sampleRate,
      this.buffer.subarray(0, this.offset),
      this.config.channels,
    );
    this.start += BigInt(this.offset);
    this.offset = 0;
  }
}
