import type { MemoryBudget } from '../memory.js';
import type { AnalogTiming } from '../../libhakei/device.js';
import type { ColumnView } from './types.js';
import { LocalAnalogSampleStore } from './local-analogStore.js';
import {
  sampleIndex,
  sampleFloor,
  sampleCeil,
  minSample,
  maxSample,
  localNumber,
  type SampleInput,
} from '../../libhakei/sample-index.js';
export { ANALOG_BLOCK_SAMPLES } from './local-analogStore.js';
export interface AnalogRange {
  readonly min: number;
  readonly max: number;
}
export interface AnalogColumnView {
  readonly startSample: bigint;
  readonly endSample: bigint;
  readonly bins: number;
  readonly low: Float32Array;
  readonly high: Float32Array;
  readonly logic?: ColumnView & { readonly edges?: bigint[] };
}
export interface AnalogStore {
  readonly timing?: AnalogTiming;
  readonly nativeLength?: bigint;
  readonly samplerate: number;
  readonly length: bigint;
  readonly range: AnalogRange | null;
  readonly mean: number | null;
  append(values: ArrayLike<number>, startSample?: SampleInput): void;
  sampleAt(index: SampleInput): number;
  query(startSample: SampleInput, endSample: SampleInput, bins: number): AnalogColumnView;
  memory(): { totalBytes: number };
}
import { SEGMENT_SAMPLES } from './segment.js';
const SEGMENT = BigInt(SEGMENT_SAMPLES);
export class AnalogSampleStore implements AnalogStore {
  private segments: LocalAnalogSampleStore[] = [];
  private sampleCount = 0n;
  private minimum = Infinity;
  private maximum = -Infinity;
  private sum = 0;
  get length(): bigint {
    return this.sampleCount;
  }
  get range(): AnalogRange | null {
    return this.sampleCount ? { min: this.minimum, max: this.maximum } : null;
  }
  get mean(): number | null {
    return this.sampleCount ? this.sum / Number(this.sampleCount) : null;
  }
  private low = new Float32Array(0);
  private high = new Float32Array(0);
  constructor(
    readonly samplerate: number,
    private readonly budget?: MemoryBudget,
  ) {
    this.segments.push(new LocalAnalogSampleStore(samplerate, budget));
  }
  prepareAppend(count: number): () => void {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('invalid local append length');
    const originalSegments = this.segments.length,
      rollbacks: (() => void)[] = [];
    const rollback = () => {
      for (const undo of rollbacks.reverse()) undo();
      for (const segment of this.segments.splice(originalSegments)) segment.dispose();
    };
    try {
      let offset = this.sampleCount,
        remaining = count;
      while (remaining) {
        const block = localNumber(offset / SEGMENT),
          local = Number(offset % SEGMENT);
        this.segments[block] ??= new LocalAnalogSampleStore(this.samplerate, this.budget);
        const n = Math.min(remaining, SEGMENT_SAMPLES - local);
        rollbacks.push(this.segments[block]!.prepareAppend(n));
        offset += BigInt(n);
        remaining -= n;
      }
    } catch (error) {
      rollback();
      throw error;
    }
    let rolledBack = false;
    return () => {
      if (!rolledBack) {
        rolledBack = true;
        rollback();
      }
    };
  }
  append(values: ArrayLike<number>, startSample: SampleInput = this.length): void {
    for (let i = 0; i < values.length; i++)
      if (!Number.isFinite(values[i]) || Math.abs(values[i]!) > 3.4028234663852886e38)
        throw new RangeError('analog samples must be finite Float32 values');
    this.appendValidated(values, startSample);
  }
  appendValidated(values: ArrayLike<number>, startSample: SampleInput = this.length): void {
    if (sampleIndex(startSample) !== this.length) throw new Error('analog chunks must be contiguous');
    this.prepareAppend(values.length);
    for (let done = 0; done < values.length;) {
      const segment = this.segments[localNumber(this.sampleCount / SEGMENT)]!;
      const n = Math.min(values.length - done, SEGMENT_SAMPLES - Number(this.sampleCount % SEGMENT));
      const part =
        values instanceof Float32Array || values instanceof Float64Array
          ? values.subarray(done, done + n)
          : Array.from({ length: n }, (_, i) => values[done + i]!);
      const stats = segment.appendValidated(part);
      this.minimum = Math.min(this.minimum, stats.minimum);
      this.maximum = Math.max(this.maximum, stats.maximum);
      this.sum += stats.sum;
      done += n;
      this.sampleCount += BigInt(n);
    }
  }
  dispose(): void {
    for (const segment of this.segments) segment.dispose();
    this.segments.length = 1;
    this.sampleCount = 0n;
    this.minimum = Infinity;
    this.maximum = -Infinity;
    this.sum = 0;
  }
  sampleAt(input: SampleInput): number {
    const index = sampleIndex(input);
    if (index >= this.length) throw new RangeError(`sample ${index} out of range`);
    return this.segments[localNumber(index / SEGMENT)]!.sampleAt(Number(index % SEGMENT));
  }
  copyRange(startSample: SampleInput, endSample: SampleInput): Float32Array {
    const start = sampleIndex(startSample),
      end = sampleIndex(endSample);
    if (end < start || end > this.length) throw new RangeError('invalid analog sample range');
    const out = new Float32Array(localNumber(end - start, SEGMENT_SAMPLES));
    let offset = 0;
    for (let p = start; p < end;) {
      const next = minSample(end, (p / SEGMENT + 1n) * SEGMENT),
        segment = this.segments[localNumber(p / SEGMENT)]!;
      const chunk = segment.copyRange(Number(p % SEGMENT), Number((p % SEGMENT) + next - p));
      out.set(chunk, offset);
      offset += chunk.length;
      p = next;
    }
    return out;
  }
  query(startSample: SampleInput, endSample: SampleInput, bins: number): AnalogColumnView {
    if (!Number.isSafeInteger(bins) || bins < 1) throw new RangeError('invalid analog query');
    const start = maxSample(0n, sampleFloor(startSample)),
      end = minSample(this.length, sampleCeil(endSample));
    if (start >= end) throw new RangeError('empty analog query');
    if (start / SEGMENT === (end - 1n) / SEGMENT) {
      const origin = (start / SEGMENT) * SEGMENT;
      return {
        ...this.segments[localNumber(start / SEGMENT)]!.query(Number(start - origin), Number(end - origin), bins),
        startSample: start,
        endSample: end,
      };
    }
    if (this.low.length !== bins) {
      this.low = new Float32Array(bins);
      this.high = new Float32Array(bins);
    }
    const width = end - start;
    for (let i = 0; i < bins; i++) {
      let p = start + (width * BigInt(i)) / BigInt(bins);
      const last = minSample(end, maxSample(p + 1n, start + (width * BigInt(i + 1)) / BigInt(bins)));
      let low = Infinity,
        high = -Infinity;
      while (p < last) {
        const origin = (p / SEGMENT) * SEGMENT,
          next = minSample(last, origin + SEGMENT);
        const view = this.segments[localNumber(p / SEGMENT)]!.query(Number(p - origin), Number(next - origin), 1);
        low = Math.min(low, view.low[0]!);
        high = Math.max(high, view.high[0]!);
        p = next;
      }
      this.low[i] = low;
      this.high[i] = high;
    }
    return { startSample: start, endSample: end, bins, low: this.low, high: this.high };
  }
  memory(): { totalBytes: number } {
    return {
      totalBytes:
        this.segments.reduce((n, segment) => n + segment.memory().totalBytes, 0) +
        this.low.byteLength +
        this.high.byteLength,
    };
  }
}
