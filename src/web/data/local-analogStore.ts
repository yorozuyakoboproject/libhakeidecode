import { SEGMENT_SAMPLES } from './segment.js';
import type { MemoryBudget } from '../memory.js';

export interface AnalogColumnView {
  readonly startSample: number;
  readonly endSample: number;
  readonly bins: number;
  readonly low: Float32Array;
  readonly high: Float32Array;
}

export interface AnalogStore {
  readonly samplerate: number;
  readonly length: number;
  append(values: ArrayLike<number>, startSample?: number): void;
  sampleAt(index: number): number;
  query(startSample: number, endSample: number, bins: number): AnalogColumnView;
  memory(): { totalBytes: number };
}

const LEVEL_LOG = 4;
const MAX_LEVEL = 6;

const CORE_BINS = 32;

const binSizeOf = (level: number): number => Math.pow(2, LEVEL_LOG * level);

export const ANALOG_BLOCK_SAMPLES = 65_536;
function summaryBlockSamples(level: number): number { return Math.max(64, ANALOG_BLOCK_SAMPLES / 16 ** level); }
export function estimateLocalAnalogBytes(samples: number): { baseBytes: number; pyramidBytes: number; totalBytes: number } {
  const baseBytes = Math.ceil(samples / ANALOG_BLOCK_SAMPLES) * ANALOG_BLOCK_SAMPLES * 4;
  let pyramidBytes = 0;
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const block = summaryBlockSamples(level), bins = Math.floor(samples / 16 ** level);
    pyramidBytes += Math.ceil(bins / block) * block * 8;
  }
  return { baseBytes, pyramidBytes, totalBytes: baseBytes + pyramidBytes };
}
class FloatBlocks {
  readonly blocks: Float32Array[] = [];
  constructor(readonly blockSamples: number, private readonly budget?: MemoryBudget, private readonly label = 'analog block') {}
  reserve(samples: number): void {
    while (this.blocks.length < Math.ceil(samples / this.blockSamples)) {
      this.blocks.push(this.budget ? new Float32Array(this.budget.allocate(this.blockSamples * 4, this.label)) : new Float32Array(this.blockSamples));
    }
  }
  trim(count: number): void { while (this.blocks.length > count) { const block = this.blocks.pop()!; this.budget?.release(block.buffer); } }
  at(index: number): number { return this.blocks[Math.floor(index / this.blockSamples)]![index % this.blockSamples]!; }
  set(index: number, value: number): void { this.blocks[Math.floor(index / this.blockSamples)]![index % this.blockSamples] = value; }
  get byteLength(): number { return this.blocks.length * this.blockSamples * 4; }
}

export class LocalAnalogSampleStore implements AnalogStore {
  readonly samplerate: number;
  length = 0;
  private readonly values: FloatBlocks;
  private preparedTo = 0;

  private readonly levelMin: FloatBlocks[] = [];
  private readonly levelMax: FloatBlocks[] = [];
  private readonly validBins: number[] = [];
  private readonly binSize: number[] = [1];
  private scratchBins = 0;
  private scratchLow = new Float32Array(0);
  private scratchHigh = new Float32Array(0);

  private queryLow = Infinity;
  private queryHigh = -Infinity;

  constructor(samplerate: number, budget?: MemoryBudget) {
    if (!Number.isSafeInteger(samplerate) || samplerate <= 0) throw new Error(`samplerate must be positive, got ${samplerate}`);
    this.samplerate = samplerate;
    this.values = new FloatBlocks(ANALOG_BLOCK_SAMPLES, budget);
    this.validBins[0] = 0;
    for (let level = 1; level <= MAX_LEVEL; level++) {
      this.levelMin[level] = new FloatBlocks(summaryBlockSamples(level), budget, 'analog summary');
      this.levelMax[level] = new FloatBlocks(summaryBlockSamples(level), budget, 'analog summary');
      this.validBins[level] = 0;
      this.binSize[level] = binSizeOf(level);
    }
  }

  prepareAppend(count: number): () => void {
    const required = this.length + count;
    if (!Number.isSafeInteger(count) || count < 0 || required > SEGMENT_SAMPLES) throw new RangeError('append exceeds local analog segment capacity');
    if (required <= this.preparedTo) return () => {};
    const previousPrepared = this.preparedTo;
    const planes = [this.values, ...this.levelMin.slice(1), ...this.levelMax.slice(1)], sizes = planes.map(plane => plane.blocks.length);
    const rollback = () => { this.preparedTo = previousPrepared; planes.forEach((plane, index) => plane.trim(sizes[index]!)); };
    try {
      this.values.reserve(required);
      for (let level = 1; level <= MAX_LEVEL; level++) {
        const bins = Math.floor(required / this.binSize[level]!);
        this.levelMin[level]!.reserve(bins); this.levelMax[level]!.reserve(bins);
      }
    } catch (error) { rollback(); throw error; }
    this.preparedTo = required; return rollback;
  }
  append(values: ArrayLike<number>, startSample = this.length): void {
    for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i]) || Math.abs(values[i]!) > 3.4028234663852886e38) throw new RangeError('analog samples must be finite Float32 values');
    this.appendValidated(values, startSample);
  }

  appendValidated(values: ArrayLike<number>, startSample = this.length): void {
    if (startSample !== this.length) throw new Error('analog chunks must be contiguous');
    this.prepareAppend(values.length);
    for (let index = 0; index < values.length;) {
      const sample = this.length + index, block = this.values.blocks[Math.floor(sample / ANALOG_BLOCK_SAMPLES)]!;
      const offset = sample % ANALOG_BLOCK_SAMPLES, count = Math.min(values.length - index, ANALOG_BLOCK_SAMPLES - offset);
      if (values instanceof Float32Array) block.set(values.subarray(index, index + count), offset);
      else for (let i = 0; i < count; i++) block[offset + i] = values[index + i]!;
      index += count;
    }
    this.length += values.length; this.updatePyramid();
  }
  dispose(): void { for (const plane of [this.values, ...this.levelMin.slice(1), ...this.levelMax.slice(1)]) plane.trim(0); this.length = 0; this.preparedTo = 0; this.validBins.fill(0); }

  sampleAt(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) throw new RangeError(`sample ${index} out of range`);
    return this.values.at(index);
  }

  copyRange(startSample: number, endSample: number): Float32Array {
    if (!Number.isInteger(startSample) || !Number.isInteger(endSample) || startSample < 0 || endSample < startSample || endSample > this.length) {
      throw new RangeError('invalid analog sample range');
    }
    const out = new Float32Array(endSample - startSample);
    for (let source = startSample, target = 0; source < endSample;) {
      const block = this.values.blocks[Math.floor(source / ANALOG_BLOCK_SAMPLES)]!, offset = source % ANALOG_BLOCK_SAMPLES;
      const count = Math.min(endSample - source, ANALOG_BLOCK_SAMPLES - offset);
      out.set(block.subarray(offset, offset + count), target);
      source += count; target += count;
    }
    return out;
  }

  query(startSample: number, endSample: number, bins: number): AnalogColumnView {
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample) || !Number.isInteger(bins) || bins < 1) throw new RangeError('invalid analog query');
    const start = Math.max(0, Math.min(this.length, Math.floor(startSample)));
    const end = Math.max(start + 1, Math.min(this.length, Math.ceil(endSample)));
    if (start >= this.length) throw new RangeError('analog query starts past the end');
    if (this.scratchBins !== bins) {
      this.scratchBins = bins; this.scratchLow = new Float32Array(bins); this.scratchHigh = new Float32Array(bins);
    }
    const level = this.pickLevel((end - start) / bins);
    for (let i = 0; i < bins; i++) {
      const a = Math.min(end - 1, start + Math.floor((end - start) * i / bins));
      const b = Math.max(a + 1, Math.min(end, start + Math.floor((end - start) * (i + 1) / bins)));
      this.queryLow = Infinity;
      this.queryHigh = -Infinity;
      this.rangeMinMax(a, b, level);
      this.scratchLow[i] = this.queryLow;
      this.scratchHigh[i] = this.queryHigh;
    }
    return { startSample: start, endSample: end, bins, low: this.scratchLow, high: this.scratchHigh };
  }

  private updatePyramid(): void {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      const size = this.binSize[level]!;
      const first = this.validBins[level]!;
      const last = Math.floor(this.length / size);
      if (last <= first) break;

      const mins = this.levelMin[level]!;
      const maxs = this.levelMax[level]!;
      if (level === 1) {
        for (let bin = first; bin < last; bin++) {
          const start = bin * size;
          let low = Infinity, high = -Infinity;
          for (let sample = start; sample < start + size; sample++) {
            const value = this.values.at(sample);
            low = Math.min(low, value);
            high = Math.max(high, value);
          }
          mins.set(bin, low);
          maxs.set(bin, high);
        }
      } else {
        const sourceMin = this.levelMin[level - 1]!;
        const sourceMax = this.levelMax[level - 1]!;
        for (let bin = first; bin < last; bin++) {
          const sourceStart = bin * 16;
          let low = Infinity, high = -Infinity;
          for (let source = sourceStart; source < sourceStart + 16; source++) {
            low = Math.min(low, sourceMin.at(source));
            high = Math.max(high, sourceMax.at(source));
          }
          mins.set(bin, low);
          maxs.set(bin, high);
        }
      }
      this.validBins[level] = last;
    }
  }

  private pickLevel(samplesPerBin: number): number {
    let level = 0;
    for (let candidate = 1; candidate <= MAX_LEVEL; candidate++) {
      if (this.binSize[candidate]! * CORE_BINS > samplesPerBin) break;
      if (this.validBins[candidate] === 0) break;
      level = candidate;
    }
    return level;
  }

  private rangeMinMax(start: number, end: number, level: number): void {
    if (start >= end) return;
    if (level === 0) {
      for (let sample = start; sample < end; sample++) {
        const value = this.values.at(sample);
        this.queryLow = Math.min(this.queryLow, value);
        this.queryHigh = Math.max(this.queryHigh, value);
      }
      return;
    }

    const size = this.binSize[level]!;
    const first = Math.ceil(start / size);
    const last = Math.floor(end / size);
    const coreLast = Math.min(last, this.validBins[level]!);
    if (first >= coreLast) {
      this.rangeMinMax(start, end, level - 1);
      return;
    }

    const leftEnd = first * size;
    if (start < leftEnd) this.rangeMinMax(start, leftEnd, level - 1);
    const mins = this.levelMin[level]!;
    const maxs = this.levelMax[level]!;
    for (let bin = first; bin < coreLast; bin++) {
      this.queryLow = Math.min(this.queryLow, mins.at(bin));
      this.queryHigh = Math.max(this.queryHigh, maxs.at(bin));
    }
    const rightStart = coreLast * size;
    if (rightStart < end) this.rangeMinMax(rightStart, end, level - 1);
  }

  memory(): { totalBytes: number } {
    let pyramidBytes = 0;
    for (let level = 1; level <= MAX_LEVEL; level++) {
      pyramidBytes += this.levelMin[level]!.byteLength + this.levelMax[level]!.byteLength;
    }
    return {
      totalBytes: this.values.byteLength + pyramidBytes + this.scratchLow.byteLength + this.scratchHigh.byteLength,
    };
  }
}
