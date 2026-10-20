import type { MemoryBudget } from '../memory.js';
import { LocalAnalogSampleStore } from './local-analogStore.js';
import { sampleIndex, sampleFloor, sampleCeil, minSample, maxSample, localNumber, samplePhase, type SampleInput } from '../../libhakei/sample-index.js';
export { ANALOG_BLOCK_SAMPLES } from './local-analogStore.js';
export interface AnalogColumnView { readonly startSample: bigint; readonly endSample: bigint; readonly bins: number; readonly low: Float32Array; readonly high: Float32Array }
export interface AnalogStore {
  readonly samplerate: number; readonly length: bigint;
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
  get length(): bigint { return this.sampleCount; }
  private low = new Float32Array(0); private high = new Float32Array(0);
  constructor(readonly samplerate: number, private readonly budget?: MemoryBudget) { this.segments.push(new LocalAnalogSampleStore(samplerate, budget)); }
  prepareAppend(count: number): () => void {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('invalid local append length');
    const originalSegments = this.segments.length, rollbacks: (() => void)[] = [];
    const rollback = () => { for (const undo of rollbacks.reverse()) undo(); for (const segment of this.segments.splice(originalSegments)) segment.dispose(); };
    try {
      let offset = this.sampleCount, remaining = count;
      while (remaining) {
        const block = localNumber(offset / SEGMENT), local = Number(offset % SEGMENT);
        this.segments[block] ??= new LocalAnalogSampleStore(this.samplerate, this.budget);
        const n = Math.min(remaining, SEGMENT_SAMPLES - local); rollbacks.push(this.segments[block]!.prepareAppend(n));
        offset += BigInt(n); remaining -= n;
      }
    } catch (error) { rollback(); throw error; }
    let rolledBack = false; return () => { if (!rolledBack) { rolledBack = true; rollback(); } };
  }
  append(values: ArrayLike<number>, startSample: SampleInput = this.length): void {
    for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i]) || Math.abs(values[i]!) > 3.4028234663852886e38) throw new RangeError('analog samples must be finite Float32 values');
    this.appendValidated(values, startSample);
  }
  appendValidated(values: ArrayLike<number>, startSample: SampleInput = this.length): void {
    if (sampleIndex(startSample) !== this.length) throw new Error('analog chunks must be contiguous');
    this.prepareAppend(values.length);
    for (let done = 0; done < values.length;) {
      const segment = this.segments[localNumber(this.sampleCount / SEGMENT)]!;
      const n = Math.min(values.length - done, SEGMENT_SAMPLES - Number(this.sampleCount % SEGMENT));
      const part = values instanceof Float32Array || values instanceof Float64Array ? values.subarray(done, done + n) : Array.from({length: n}, (_, i) => values[done + i]!);
      segment.appendValidated(part); done += n; this.sampleCount += BigInt(n);
    }
  }
  dispose(): void { for (const segment of this.segments) segment.dispose(); this.segments.length = 1; this.sampleCount = 0n; }
  sampleAt(input: SampleInput): number {
    const index = sampleIndex(input); if (index >= this.length) throw new RangeError(`sample ${index} out of range`);
    return this.segments[localNumber(index / SEGMENT)]!.sampleAt(Number(index % SEGMENT));
  }
  copyRange(startSample: SampleInput, endSample: SampleInput): Float32Array {
    const start = sampleIndex(startSample), end = sampleIndex(endSample);
    if (end < start || end > this.length) throw new RangeError('invalid analog sample range');
    const out = new Float32Array(localNumber(end - start, SEGMENT_SAMPLES)); let offset = 0;
    for (let p = start; p < end;) {
      const next = minSample(end, (p / SEGMENT + 1n) * SEGMENT), segment = this.segments[localNumber(p / SEGMENT)]!;
      const chunk = segment.copyRange(Number(p % SEGMENT), Number(p % SEGMENT + next - p));
      out.set(chunk, offset); offset += chunk.length; p = next;
    }
    return out;
  }
  query(startSample: SampleInput, endSample: SampleInput, bins: number): AnalogColumnView {
    if (!Number.isSafeInteger(bins) || bins < 1) throw new RangeError('invalid analog query');
    const start = maxSample(0n, sampleFloor(startSample)), end = minSample(this.length, sampleCeil(endSample));
    if (start >= end) throw new RangeError('empty analog query');
    if (start / SEGMENT === (end - 1n) / SEGMENT) {
      const origin = start / SEGMENT * SEGMENT;
      return {...this.segments[localNumber(start / SEGMENT)]!.query(Number(start - origin), Number(end - origin), bins), startSample: start, endSample: end};
    }
    if (this.low.length !== bins) { this.low = new Float32Array(bins); this.high = new Float32Array(bins); }
    const width = end - start;
    for (let i = 0; i < bins; i++) {
      let p = start + width * BigInt(i) / BigInt(bins);
      const last = minSample(end, maxSample(p + 1n, start + width * BigInt(i + 1) / BigInt(bins)));
      let low = Infinity, high = -Infinity;
      while (p < last) {
        const origin = p / SEGMENT * SEGMENT, next = minSample(last, origin + SEGMENT);
        const view = this.segments[localNumber(p / SEGMENT)]!.query(Number(p - origin), Number(next - origin), 1);
        low = Math.min(low, view.low[0]!); high = Math.max(high, view.high[0]!); p = next;
      }
      this.low[i] = low; this.high[i] = high;
    }
    return {startSample: start, endSample: end, bins, low: this.low, high: this.high};
  }
  memory(): {totalBytes: number} { return {totalBytes: this.segments.reduce((n, segment) => n + segment.memory().totalBytes, 0) + this.low.byteLength + this.high.byteLength}; }
}

export interface ProceduralAnalogStoreOptions {
  readonly samplerate: number;
  readonly length: SampleInput;
  readonly pattern?: 'sine' | 'square' | 'triangle' | 'sawtooth' | 'constant';
  readonly frequencyHz?: number;
  readonly amplitude?: number;
  readonly offset?: number;
  readonly phase?: number;
  readonly value?: number;
}

export class ProceduralAnalogSampleStore implements AnalogStore {
  readonly samplerate: number;
  readonly length: bigint;
  private readonly pattern: NonNullable<ProceduralAnalogStoreOptions['pattern']>;
  private readonly frequencyHz: number;
  private readonly amplitude: number;
  private readonly offset: number;
  private readonly phase: number;
  private readonly value: number;
  private scratchBins = 0;
  private scratchLow = new Float32Array(0);
  private scratchHigh = new Float32Array(0);

  constructor(options: ProceduralAnalogStoreOptions) {
    if (!Number.isSafeInteger(options.samplerate) || options.samplerate <= 0) throw new Error('samplerate must be positive');
    if (sampleIndex(options.length) < 1n) throw new Error('length must be positive');
    const frequencyHz = options.frequencyHz ?? 1_000;
    if (!(frequencyHz > 0) || !Number.isFinite(frequencyHz)) throw new Error('frequencyHz must be positive');
    for (const [name, candidate] of [['amplitude', options.amplitude], ['offset', options.offset], ['phase', options.phase], ['value', options.value]] as const) {
      if (candidate !== undefined && !Number.isFinite(candidate)) throw new Error(`${name} must be finite`);
    }
    this.samplerate = options.samplerate;
    this.length = sampleIndex(options.length);
    this.pattern = options.pattern ?? 'sine';
    this.frequencyHz = frequencyHz;
    this.amplitude = options.amplitude ?? 1;
    this.offset = options.offset ?? 0;
    this.phase = options.phase ?? 0;
    this.value = options.value ?? this.offset;
  }

  append(_values: ArrayLike<number>, _startSample: SampleInput = 0n): void {
    throw new Error('procedural analog stores are immutable');
  }

  sampleAt(input: SampleInput): number {
    const index = sampleIndex(input);
    if (index >= this.length) throw new RangeError(`sample ${index} out of range`);
    return this.valueAt(index);
  }

  query(startSample: SampleInput, endSample: SampleInput, bins: number): AnalogColumnView {
    if (!Number.isInteger(bins) || bins < 1) throw new RangeError('invalid analog query');
    const start = maxSample(0n, minSample(this.length, sampleFloor(startSample)));
    const end = maxSample(start + 1n, minSample(this.length, sampleCeil(endSample)));
    if (start >= this.length) throw new RangeError('analog query starts past the end');
    if (this.scratchBins !== bins) {
      this.scratchBins = bins;
      this.scratchLow = new Float32Array(bins);
      this.scratchHigh = new Float32Array(bins);
    }
    for (let i = 0; i < bins; i++) {
      const a = minSample(end - 1n, start + (end - start) * BigInt(i) / BigInt(bins));
      const b = maxSample(a + 1n, minSample(end, start + (end - start) * BigInt(i + 1) / BigInt(bins)));
      const range = this.rangeMinMax(a, b);
      this.scratchLow[i] = range[0];
      this.scratchHigh[i] = range[1];
    }
    return { startSample: start, endSample: end, bins, low: this.scratchLow, high: this.scratchHigh };
  }

  memory(): { totalBytes: number } {
    return { totalBytes: this.scratchLow.byteLength + this.scratchHigh.byteLength };
  }

  private valueAt(sample: bigint): number {
    const cycles = samplePhase(sample, this.frequencyHz, this.samplerate) + this.phase / (2 * Math.PI);
    const fraction = cycles - Math.floor(cycles);
    switch (this.pattern) {
      case 'sine': return this.offset + this.amplitude * .5 * (Math.sin(cycles * 2 * Math.PI) + 1);
      case 'square': return fraction < .5 ? this.offset + this.amplitude : this.offset;
      case 'triangle': return this.offset + this.amplitude * (1 - Math.abs(2 * fraction - 1));
      case 'sawtooth': return this.offset + this.amplitude * fraction;
      case 'constant': return this.value;
    }
  }

  private rangeMinMax(start: bigint, end: bigint): [number, number] {
    if (this.pattern === 'sine') {
      if (Number(end - start) * this.frequencyHz / this.samplerate >= 1) {
        return [Math.min(this.offset, this.offset + this.amplitude), Math.max(this.offset, this.offset + this.amplitude)];
      }
      const last = end - 1n;
      let low = Math.min(this.valueAt(start), this.valueAt(last));
      let high = Math.max(this.valueAt(start), this.valueAt(last));
      const theta0 = 2 * Math.PI * samplePhase(start, this.frequencyHz, this.samplerate) + this.phase;
      const theta1 = theta0 + 2 * Math.PI * Number(last - start) * this.frequencyHz / this.samplerate;
      const firstExtremum = Math.ceil((theta0 - Math.PI / 2) / Math.PI);
      const lastExtremum = Math.floor((theta1 - Math.PI / 2) / Math.PI);
      for (let k = firstExtremum; k <= lastExtremum; k++) {
        const value = this.offset + this.amplitude * .5 * (Math.sin(Math.PI / 2 + k * Math.PI) + 1);
        low = Math.min(low, value); high = Math.max(high, value);
      }
      return [low, high];
    }
    const span = end - start;
    const count = Math.min(512, Math.max(1, Number(span)));
    let low = Infinity, high = -Infinity;
    for (let i = 0; i < count; i++) {
      const sample = start + minSample(span - 1n, span * BigInt(i) / BigInt(count));
      const value = this.valueAt(sample);
      low = Math.min(low, value); high = Math.max(high, value);
    }
    return [low, high];
  }
}
