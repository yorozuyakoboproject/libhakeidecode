import { sampleIndex, sampleFloor, sampleCeil, minSample, maxSample, localNumber, numberFraction, type SampleInput } from '../../libhakei/sample-index.js';
import { assertGapBounds, mergeGap, splitAroundGaps } from './gaps.js';
import { GAP_BIT, type SampleStore, type ColumnView, type GapSpan, type MemoryReport } from './types.js';
import { isChannelCount, type ChannelCount } from './channel-count.js';

export interface ProceduralStoreOptions {
  channelCount: ChannelCount;
  samplerate: number;
  length: SampleInput;
  frequencyHz: number;
}

export class ProceduralSampleStore implements SampleStore {
  readonly channelCount: ChannelCount;
  readonly samplerate: number;
  readonly length: bigint;
  private readonly numerator: bigint;
  private readonly denominator: bigint;
  private readonly reflected: boolean;
  private gapList: GapSpan[] = [];
  private scratch = {low: new Uint8Array(0), high: new Uint8Array(0), edge: new Uint8Array(0), packed: new Uint8Array(0)};

  constructor(options: ProceduralStoreOptions) {
    if (!isChannelCount(options.channelCount)) throw new RangeError('invalid channel count');
    if (!Number.isSafeInteger(options.samplerate) || options.samplerate < 1) throw new RangeError('invalid samplerate');
    if (!(options.frequencyHz > 0) || !Number.isFinite(options.frequencyHz)) throw new RangeError('invalid signal frequency');
    this.channelCount = options.channelCount; this.samplerate = options.samplerate;
    this.length = sampleIndex(options.length);
    const [n, d] = numberFraction(options.frequencyHz);
    const denominator = d * BigInt(this.samplerate), folded = n * 2n % (denominator * 2n);
    this.reflected = folded > denominator;
    const numerator = this.reflected ? denominator * 2n - folded : folded;
    let divisor = denominator, remainder = numerator;
    while (remainder) { const next = divisor % remainder; divisor = remainder; remainder = next; }
    this.numerator = numerator / divisor;
    this.denominator = denominator / divisor;
  }

  append(_chunk: Uint8Array): void { throw new Error('procedural stores are immutable'); }
  noteGap(startSample: SampleInput, endSample: SampleInput): void {
    const start = sampleIndex(startSample), end = sampleIndex(endSample);
    assertGapBounds(start, end, this.length); this.gapList = mergeGap(this.gapList, start, end);
  }
  gaps(): GapSpan[] { return this.gapList.map(gap => ({...gap})); }
  private checkChannel(channel: number): void {
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.channelCount) throw new RangeError('channel out of range');
  }

  private transitionsThrough(sample: bigint): bigint {
    if (sample <= 0n || !this.numerator) return 0n;
    const value = sample * this.numerator;
    return this.reflected ? (value + this.denominator - 1n) / this.denominator : value / this.denominator;
  }
  private edgeAt(ordinal: bigint): bigint {
    return this.reflected ? (ordinal - 1n) * this.denominator / this.numerator + 1n
      : (ordinal * this.denominator + this.numerator - 1n) / this.numerator;
  }
  private levelAt(sample: bigint): number { return 1 ^ Number(this.transitionsThrough(sample) & 1n); }
  sampleAt(channel: number, sample: SampleInput): number {
    this.checkChannel(channel); const position = sampleIndex(sample);
    if (position >= this.length) throw new RangeError(`sample ${position} out of range`);
    return this.levelAt(position);
  }
  private bounds(startSample: SampleInput, endSample: SampleInput): [bigint, bigint] {
    return [maxSample(0n, sampleFloor(startSample)), minSample(this.length, sampleCeil(endSample))];
  }
  query(channel: number, startSample: SampleInput, endSample: SampleInput, bins: number): ColumnView {
    this.checkChannel(channel);
    if (!Number.isSafeInteger(bins) || bins < 1) throw new RangeError('bins must be a positive integer');
    const [start, end] = this.bounds(startSample, endSample);
    if (start >= end) throw new RangeError('empty query range');
    if (this.scratch.low.length !== bins) this.scratch = {low: new Uint8Array(bins), high: new Uint8Array(bins), edge: new Uint8Array(bins), packed: new Uint8Array(bins)};
    const {low, high, edge, packed} = this.scratch, width = end - start, divisor = BigInt(bins);
    for (let i = 0, gap = 0; i < bins; i++) {
      const a = start + width * BigInt(i) / divisor;
      const b = minSample(end, maxSample(a + 1n, start + width * BigInt(i + 1) / divisor));
      const last = this.transitionsThrough(b - 1n), first = this.transitionsThrough(a);
      const mixed = last > first, level = 1 ^ Number(first & 1n);
      low[i] = mixed ? 0 : level; high[i] = mixed ? 1 : level;
      edge[i] = last > this.transitionsThrough(a - 1n) ? 1 : 0;
      while (gap < this.gapList.length && this.gapList[gap]!.endSample <= a) gap++;
      const gapHit = gap < this.gapList.length && this.gapList[gap]!.startSample < b;
      packed[i] = high[i]! | low[i]! << 1 | edge[i]! << 2 | (gapHit ? GAP_BIT : 0);
    }
    return {channel, startSample: start, endSample: end, bins, low, high, edge, packed};
  }
  private edgeSegments(channel: number, startSample: SampleInput, endSample: SampleInput): Array<[bigint, bigint]> {
    this.checkChannel(channel); const [start, end] = this.bounds(startSample, endSample);
    return start >= end ? [] : splitAroundGaps(this.gapList, maxSample(1n, start), end);
  }

  edges(channel: number, startSample: SampleInput, endSample: SampleInput): bigint[] {
    const segments = this.edgeSegments(channel, startSample, endSample);
    let count = 0n;
    for (const [a, b] of segments) count += this.transitionsThrough(b - 1n) - this.transitionsThrough(a - 1n);
    const output = new Array<bigint>(localNumber(count)); let index = 0;
    for (const [a, b] of segments) {
      const last = this.transitionsThrough(b - 1n);
      for (let ordinal = this.transitionsThrough(a - 1n) + 1n; ordinal <= last; ordinal++) output[index++] = this.edgeAt(ordinal);
    }
    return output;
  }
  edgeCount(channel: number, startSample: SampleInput, endSample: SampleInput): number {
    let count = 0n;
    for (const [a, b] of this.edgeSegments(channel, startSample, endSample)) count += this.transitionsThrough(b - 1n) - this.transitionsThrough(a - 1n);
    return Number(count);
  }

  packRange(startSample: SampleInput, endSample: SampleInput, channels: number = this.channelCount): Uint8Array {
    const start = sampleIndex(startSample), end = sampleIndex(endSample);
    if (end < start || end > this.length) throw new RangeError('invalid packed range');
    if (!Number.isInteger(channels) || channels < 1 || channels > this.channelCount) throw new RangeError('invalid packed channel count');
    const stride = Math.ceil(channels / 8), output = new Uint8Array(localNumber(end - start, 2 ** 26) * stride);
    const mask = channels % 8 ? (1 << (channels % 8)) - 1 : 255;
    for (const [a, b] of splitAroundGaps(this.gapList, start, end)) {
      let position = a, level = this.levelAt(a), ordinal = this.transitionsThrough(a) + 1n;
      while (position < b) {
        const next = this.numerator ? minSample(b, this.edgeAt(ordinal++)) : b;
        if (level) {
          const first = localNumber(position - start) * stride, last = localNumber(next - start) * stride;
          output.fill(stride === 1 ? mask : 255, first, last);
          if (stride > 1 && mask !== 255) for (let byte = first + stride - 1; byte < last; byte += stride) output[byte] = mask;
        }
        position = next; level ^= 1;
      }
    }
    return output;
  }
  memory(): MemoryReport {
    const metadataBytes = 128 + Math.ceil((this.length.toString(2).length + this.numerator.toString(2).length + this.denominator.toString(2).length) / 8);
    const totalBytes = metadataBytes + Object.values(this.scratch).reduce((n, values) => n + values.byteLength, 0);
    return {baseBytes: metadataBytes, pyramidBytes: 0, totalBytes, slackBytes: 0, overhead: 0};
  }
}
