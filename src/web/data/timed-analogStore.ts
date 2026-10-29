import { sampleIndex, minSample, maxSample, type SampleInput } from '../../libhakei/sample-index.js';
import type { AnalogTiming } from '../../libhakei/device.js';
import { AnalogSampleStore, type AnalogStore, type AnalogColumnView } from './analogStore.js';

export class PendingAnalogStore extends AnalogSampleStore {}

export class TimedAnalogStore implements AnalogStore {
  constructor(
    readonly native: AnalogSampleStore,
    readonly timing: AnalogTiming,
    readonly samplerate: number,
    readonly limit: bigint,
  ) {}
  private get scale(): number {
    return this.timing.referenceMv / 1000 / ((1 << this.timing.bits) - 1);
  }
  get length(): bigint {
    if (!this.native.length) return 0n;
    const t = this.timing.firstTick + this.native.length * this.timing.periodTicks;
    return minSample(
      this.limit,
      (t * BigInt(this.samplerate) + BigInt(this.timing.clockHz) - 1n) / BigInt(this.timing.clockHz),
    );
  }
  get range() {
    const r = this.native.range;
    return r ? { min: r.min * this.scale, max: r.max * this.scale } : null;
  }
  get mean() {
    return this.native.mean === null ? null : this.native.mean * this.scale;
  }
  nativeIndex(sample: bigint): bigint {
    const numerator = sample * BigInt(this.timing.clockHz) - this.timing.firstTick * BigInt(this.samplerate);
    const denominator = BigInt(this.samplerate) * this.timing.periodTicks;
    return numerator < 0n ? -1n : numerator / denominator;
  }
  append(values: ArrayLike<number>, start?: SampleInput): void {
    this.native.append(values, start);
  }
  sampleAt(input: SampleInput): number {
    const index = this.nativeIndex(sampleIndex(input));
    return index < 0n || index >= this.native.length ? NaN : this.native.sampleAt(index) * this.scale;
  }
  query(startInput: SampleInput, endInput: SampleInput, bins: number): AnalogColumnView {
    const start = sampleIndex(startInput),
      end = sampleIndex(endInput);
    if (!Number.isSafeInteger(bins) || bins < 1 || end <= start) throw new RangeError('Invalid analog time range');
    const low = new Float32Array(bins).fill(NaN),
      high = new Float32Array(bins).fill(NaN);
    for (let i = 0; i < bins; ++i) {
      const a = start + ((end - start) * BigInt(i)) / BigInt(bins);
      const b = start + ((end - start) * BigInt(i + 1)) / BigInt(bins);
      const rawStart = this.nativeIndex(a);
      const boundary = b * BigInt(this.timing.clockHz) - this.timing.firstTick * BigInt(this.samplerate) - 1n;
      const rawEnd = boundary < 0n ? -1n : boundary / (BigInt(this.samplerate) * this.timing.periodTicks);
      const first = maxSample(0n, rawStart);
      const last = minSample(this.native.length, maxSample(first + 1n, rawEnd + 1n));
      if (rawEnd < 0n || first >= last) continue;
      const result = this.native.query(first, last, 1);
      low[i] = result.low[0]! * this.scale;
      high[i] = result.high[0]! * this.scale;
    }
    return { startSample: start, endSample: end, bins, low, high };
  }
  memory() {
    return this.native.memory();
  }
}
