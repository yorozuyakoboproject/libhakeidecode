import { sampleIndex, sampleFloor, sampleCeil, minSample, maxSample, localNumber, type SampleInput } from '../../libhakei/sample-index.js';
import { LocalPlanarSampleStore, type PlanarStoreOptions } from './local-planarStore.js';
import { assertGapBounds, mergeGap, splitAroundGaps } from './gaps.js';
import { GAP_BIT, type SampleStore, type ColumnView, type GapSpan, type MemoryReport } from './types.js';
export { BASE_BLOCK_BITS_LOG, type PlanarStoreOptions } from './local-planarStore.js';

import { SEGMENT_SAMPLES as PLANAR_SEGMENT_SAMPLES } from './segment.js';
export { SEGMENT_SAMPLES as PLANAR_SEGMENT_SAMPLES } from './segment.js';
const SEGMENT = BigInt(PLANAR_SEGMENT_SAMPLES);
export interface PlanarStoreTimings { appendCalls: number; appendPrepareMs: number; appendCopyMs: number; appendSummaryMs: number; refreshCalls: number; refreshMs: number; finalizeMs: number }
const PACKED_STAGE_BLOCK_BYTES = 4 * 1024 * 1024;
const PACKED_STAGE_GROUP_SAMPLES = 1024;
const PACKED_STAGE_GROUPS_PER_BLOCK = PACKED_STAGE_BLOCK_BYTES / PACKED_STAGE_GROUP_SAMPLES;
const PACKED_STAGE_SUMMARY_BYTES = PACKED_STAGE_GROUPS_PER_BLOCK * 2;
type PackedSummaryBlock = { ones: Uint8Array; zeros: Uint8Array; buffer: ArrayBuffer };
export class PlanarSampleStore implements SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  private segments: LocalPlanarSampleStore[];
  private sampleCount = 0n;
  private deferPyramid: boolean;
  private stagedPackedBlocks: (Uint8Array | null)[] | null;
  private packedSummaryBlocks: PackedSummaryBlock[] | null;
  private materializingPacked = false;
  private readonly timing: PlanarStoreTimings = { appendCalls: 0, appendPrepareMs: 0, appendCopyMs: 0, appendSummaryMs: 0, refreshCalls: 0, refreshMs: 0, finalizeMs: 0 };
  get timings(): PlanarStoreTimings { return { ...this.timing }; }
  private readonly keepPacked: boolean;
  get length(): bigint { return this.sampleCount; }
  snapColumns: boolean;
  coreBins: number;
  get transpose32Backend() { return this.segments[0]!.transpose32Backend; }
  get transposeScratchBytes() { return this.segments.reduce((n, segment) => n + segment.transposeScratchBytes, 0); }
  private gapList: GapSpan[] = [];
  private scratch = { low: new Uint8Array(0), high: new Uint8Array(0), edge: new Uint8Array(0), packed: new Uint8Array(0) };
  constructor(private readonly options: PlanarStoreOptions) {
    if (options.stagePacked && options.channelCount > 8) throw new Error('packed staging supports at most 8 channels');
    this.segments = [new LocalPlanarSampleStore(options)];
    this.deferPyramid = options.deferPyramid === true;
    this.stagedPackedBlocks = options.stagePacked ? [] : null;
    this.keepPacked = options.keepPacked === true;
    this.packedSummaryBlocks = options.stagePacked && this.keepPacked ? [] : null;
    this.channelCount = options.channelCount; this.samplerate = options.samplerate;
    this.snapColumns = options.snapColumns === true; this.coreBins = options.coreBins ?? 32;
  }
  prepareAppend(count: number): () => void {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('invalid local append length');
    if (this.stagedPackedBlocks && !this.materializingPacked) {
      const end = this.sampleCount + BigInt(count);
      if (end > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('packed capture exceeds safe local length');
      const blocks = this.stagedPackedBlocks, summaries = this.packedSummaryBlocks, originalBlocks = blocks.length, required = Number(end);
      const originalSummaries = summaries?.length ?? 0;
      const rollback = (): void => {
        while (blocks.length > originalBlocks) {
          const block = blocks.pop();
          if (block) this.options.budget?.release(block.buffer);
        }
        if (summaries) while (summaries.length > originalSummaries) {
          const summary = summaries.pop();
          if (summary) this.options.budget?.release(summary.buffer);
        }
      };
      try {
        while (blocks.length * PACKED_STAGE_BLOCK_BYTES < required) {
          const raw = new Uint8Array(this.options.budget
            ? this.options.budget.allocate(PACKED_STAGE_BLOCK_BYTES, 'packed capture block')
            : new ArrayBuffer(PACKED_STAGE_BLOCK_BYTES));
          try {
            if (!this.packedSummaryBlocks) { blocks.push(raw); continue; }
            const activeSummaries = this.packedSummaryBlocks;
            const buffer = this.options.budget
              ? this.options.budget.allocate(PACKED_STAGE_SUMMARY_BYTES, 'packed capture summary')
              : new ArrayBuffer(PACKED_STAGE_SUMMARY_BYTES);
            activeSummaries.push({ buffer, ones: new Uint8Array(buffer, 0, PACKED_STAGE_GROUPS_PER_BLOCK),
              zeros: new Uint8Array(buffer, PACKED_STAGE_GROUPS_PER_BLOCK, PACKED_STAGE_GROUPS_PER_BLOCK) });
            blocks.push(raw);
          } catch (error) {
            this.releasePackedSummaries();
            blocks.push(raw);
            continue;
          }
        }
      } catch (error) { rollback(); throw error; }
      let rolledBack = false;
      return () => { if (!rolledBack) { rolledBack = true; rollback(); } };
    }
    const originalSegments = this.segments.length, rollbacks: (() => void)[] = [];
    const rollback = () => {
      for (const undo of rollbacks.reverse()) undo();
      for (const segment of this.segments.splice(originalSegments)) segment.dispose();
    };
    try {
      let offset = this.sampleCount, remaining = count;
      while (remaining) {
        const block = localNumber(offset / SEGMENT), local = Number(offset % SEGMENT);
        this.segments[block] ??= new LocalPlanarSampleStore({ ...this.options, deferPyramid: this.deferPyramid });
        const n = Math.min(remaining, PLANAR_SEGMENT_SAMPLES - local);
        rollbacks.push(this.segments[block]!.prepareAppend(n));
        offset += BigInt(n); remaining -= n;
      }
    } catch (error) { rollback(); throw error; }
    let rolledBack = false;
    return () => { if (!rolledBack) { rolledBack = true; rollback(); } };
  }
  private appendParts(count: number, append: (segment: LocalPlanarSampleStore, offset: number, count: number) => void): void {
    this.prepareAppend(count);
    for (let done = 0; done < count;) {
      const segment = this.segments[localNumber(this.sampleCount / SEGMENT)]!;
      const n = Math.min(count - done, PLANAR_SEGMENT_SAMPLES - Number(this.sampleCount % SEGMENT));
      append(segment, done, n); done += n; this.sampleCount += BigInt(n);
    }
  }
  appendChannels(channels: readonly ArrayLike<number>[]): void {
    if (channels.length !== this.channelCount || channels.some(c => c.length !== channels[0]!.length)) throw new Error('Logic layout mismatch');
    if (this.stagedPackedBlocks && !this.materializingPacked) {
      const packed = new Uint8Array(channels[0]!.length);
      for (let sample = 0; sample < packed.length; sample++) {
        let value = 0;
        for (let channel = 0; channel < channels.length; channel++) if (channels[channel]![sample]) value |= 1 << channel;
        packed[sample] = value;
      }
      this.append(packed);
      return;
    }
    this.appendParts(channels[0]!.length, (segment, offset, count) => {
      if (offset === 0 && count === channels[0]!.length) segment.appendChannels(channels);
      else {
        const views = new Map<ArrayLike<number>, ArrayLike<number>>();
        segment.appendChannels(channels.map(c => {
          let view = views.get(c);
          if (!view) { view = ArrayBuffer.isView(c) ? (c as Uint8Array).subarray(offset, offset + count) : Array.from({length: count}, (_, i) => c[offset + i]!); views.set(c, view); }
          return view;
        }));
      }
    });
  }
  append(chunk: Uint8Array): void {
    const stride = Math.ceil(this.channelCount / 8);
    if (chunk.length % stride) throw new Error('chunk length must be a whole number of samples');
    if (this.stagedPackedBlocks && !this.materializingPacked) {
      const count = chunk.length / stride, prepareStarted = performance.now();
      this.prepareAppend(count);
      this.timing.appendPrepareMs += performance.now() - prepareStarted;
      const start = Number(this.sampleCount), copyStarted = performance.now();
      for (let copied = 0; copied < count;) {
        const position = start + copied, blockIndex = Math.floor(position / PACKED_STAGE_BLOCK_BYTES);
        const blockOffset = position % PACKED_STAGE_BLOCK_BYTES;
        const size = Math.min(count - copied, PACKED_STAGE_BLOCK_BYTES - blockOffset);
        this.stagedPackedBlocks[blockIndex]!.set(chunk.subarray(copied, copied + size), blockOffset);
        copied += size;
      }
      this.timing.appendCalls++;
      this.timing.appendCopyMs += performance.now() - copyStarted;
      if (this.packedSummaryBlocks) {
        const summaryStarted = performance.now();
        this.updatePackedSummary(start, count);
        this.timing.appendSummaryMs += performance.now() - summaryStarted;
      }
      this.sampleCount += BigInt(count);
      return;
    }
    this.appendParts(chunk.length / stride, (segment, offset, count) => segment.append(chunk.subarray(offset * stride, (offset + count) * stride)));
  }
  appendTransposed32(planes: readonly Uint32Array[]): void {
    if (this.channelCount !== 32) throw new Error('transposed append requires 32 channels');
    if (planes.length !== 32 || planes.some(p => !(p instanceof Uint32Array) || p.length !== planes[0]!.length) || this.sampleCount % 32n) throw new Error('transposed append requires 32 equal Uint32Array, word-aligned planes');
    this.appendParts(planes[0]!.length * 32, (segment, offset, count) => segment.appendTransposed32(planes.map(p => p.subarray(offset / 32, (offset + count) / 32))));
  }
  dispose(): void {
    for (const segment of this.segments) segment.dispose();
    for (const block of this.stagedPackedBlocks ?? []) if (block) this.options.budget?.release(block.buffer);
    for (const summary of this.packedSummaryBlocks ?? []) this.options.budget?.release(summary.buffer);
    this.stagedPackedBlocks = null; this.packedSummaryBlocks = null; this.materializingPacked = false;
    this.segments.length = 1; this.sampleCount = 0n; this.gapList = [];
  }
  finalizePyramid(): void {
    const started = performance.now();
    if (this.stagedPackedBlocks && !this.keepPacked) this.materializePackedSync();
    if (!this.stagedPackedBlocks) this.finalizeSegments(); else this.deferPyramid = false;
    this.timing.finalizeMs += performance.now() - started;
  }
  async finalizePyramidAsync(): Promise<void> {
    if (this.stagedPackedBlocks && !this.keepPacked) await this.materializePackedAsync();
    if (!this.stagedPackedBlocks) this.finalizeSegments(); else this.deferPyramid = false;
  }
  private finalizeSegments(): void {
    for (const segment of this.segments) segment.finalizePyramid();
    this.deferPyramid = false;
  }

  refreshPyramid(): void {
    if (!this.deferPyramid || this.stagedPackedBlocks) return;
    const started = performance.now();
    for (const segment of this.segments) segment.refreshPyramid();
    this.timing.refreshCalls++;
    this.timing.refreshMs += performance.now() - started;
  }
  private materializePackedSync(): void {
    const blocks = this.stagedPackedBlocks!;
    let remaining = Number(this.sampleCount);
    this.sampleCount = 0n; this.materializingPacked = true;
    try {
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]!;
        const count = Math.min(remaining, PACKED_STAGE_BLOCK_BYTES);
        if (count) this.append(block.subarray(0, count));
        this.options.budget?.release(block.buffer); blocks[index] = null;
        remaining -= count;
      }
      this.releasePackedSummaries();
      this.stagedPackedBlocks = null;
    } catch (error) {
      this.releaseStagedPacked(blocks);
      this.finalizeSegments();
      throw error;
    } finally { this.materializingPacked = false; }
  }
  private async materializePackedAsync(): Promise<void> {
    const blocks = this.stagedPackedBlocks!;
    let remaining = Number(this.sampleCount);
    this.sampleCount = 0n; this.materializingPacked = true;
    try {
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]!;
        const count = Math.min(remaining, PACKED_STAGE_BLOCK_BYTES);
        if (count) this.append(block.subarray(0, count));
        this.options.budget?.release(block.buffer); blocks[index] = null;
        remaining -= count;
        if ((index & 15) === 15) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      this.releasePackedSummaries();
      this.stagedPackedBlocks = null;
    } catch (error) {
      this.releaseStagedPacked(blocks);
      this.finalizeSegments();
      throw error;
    } finally { this.materializingPacked = false; }
  }
  private releaseStagedPacked(blocks: (Uint8Array | null)[]): void {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      if (block) this.options.budget?.release(block.buffer);
      blocks[index] = null;
    }
    this.releasePackedSummaries();
    this.stagedPackedBlocks = null;
  }
  private releasePackedSummaries(): void {
    const summaries = this.packedSummaryBlocks;
    if (!summaries) return;
    for (const summary of summaries) this.options.budget?.release(summary.buffer);
    summaries.length = 0;
    this.packedSummaryBlocks = null;
  }
  private updatePackedSummary(start: number, count: number): void {
    const blocks = this.stagedPackedBlocks!, summaries = this.packedSummaryBlocks!;
    const mask = (1 << this.channelCount) - 1, end = start + count;
    for (let position = start; position < end;) {
      const blockIndex = Math.floor(position / PACKED_STAGE_BLOCK_BYTES), blockOffset = position % PACKED_STAGE_BLOCK_BYTES;
      const block = blocks[blockIndex]!, summary = summaries[blockIndex]!;
      const group = Math.floor(blockOffset / PACKED_STAGE_GROUP_SAMPLES), groupStart = group * PACKED_STAGE_GROUP_SAMPLES;
      const groupEnd = groupStart + PACKED_STAGE_GROUP_SAMPLES, localEnd = Math.min(end - blockIndex * PACKED_STAGE_BLOCK_BYTES, groupEnd);
      const localStart = blockOffset;
      let ones = summary.ones[group]!, zeros = summary.zeros[group]!;
      if (localStart === groupStart && localEnd === groupEnd) {
        const words = new Uint32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
        for (let word = groupStart >>> 2, stop = groupEnd >>> 2; word < stop; word++) {
          const value = words[word]!;
          ones |= (value | (value >>> 8) | (value >>> 16) | (value >>> 24)) & mask;
          const inverse = (~value) >>> 0;
          zeros |= (inverse | (inverse >>> 8) | (inverse >>> 16) | (inverse >>> 24)) & mask;
          if (ones === mask && zeros === mask) break;
        }
      } else {
        for (let offset = localStart; offset < localEnd; offset++) {
          const value = block[offset]!;
          ones |= value & mask; zeros |= (~value) & mask;
        }
      }
      summary.ones[group] = ones; summary.zeros[group] = zeros;
      position = blockIndex * PACKED_STAGE_BLOCK_BYTES + localEnd;
    }
  }
  private packedValue(channel: number, index: number): number {
    const value = this.stagedPackedBlocks![Math.floor(index / PACKED_STAGE_BLOCK_BYTES)]![index % PACKED_STAGE_BLOCK_BYTES]!;
    return (value >>> channel) & 1;
  }
  private packedRangeState(channel: number, start: number, end: number): { low: number; high: number; edge: number } {
    const bit = 1 << channel, summaries = this.packedSummaryBlocks;
    let low = 1, high = 0, edge = 0, position = start;
    let previous = start > 0 ? this.packedValue(channel, start - 1) : 0;
    const sample = (index: number): void => {
      const value = this.packedValue(channel, index);
      if (value) high = 1; else low = 0;
      if (index > 0 && value !== previous) edge = 1;
      previous = value;
    };
    if (!summaries) {
      while (position < end) sample(position++);
      return { low, high, edge };
    }
    while (position < end && position % PACKED_STAGE_GROUP_SAMPLES) sample(position++);
    while (position + PACKED_STAGE_GROUP_SAMPLES <= end) {
      const blockIndex = Math.floor(position / PACKED_STAGE_BLOCK_BYTES);
      const group = Math.floor((position % PACKED_STAGE_BLOCK_BYTES) / PACKED_STAGE_GROUP_SAMPLES);
      const summary = summaries[blockIndex]!;
      const ones = (summary.ones[group]! & bit) !== 0, zeros = (summary.zeros[group]! & bit) !== 0;
      if (ones) high = 1; if (zeros) low = 0; if (ones && zeros) edge = 1;
      const first = this.packedValue(channel, position);
      if (first !== previous) edge = 1;
      previous = this.packedValue(channel, position + PACKED_STAGE_GROUP_SAMPLES - 1);
      position += PACKED_STAGE_GROUP_SAMPLES;
    }
    while (position < end) sample(position++);
    return { low, high, edge };
  }
  private queryPacked(channel: number, start: bigint, end: bigint, bins: number): ColumnView {
    const s = Number(start), e = Number(end), width = e - s;
    if (bins !== this.scratch.low.length) this.scratch = { low: new Uint8Array(bins), high: new Uint8Array(bins), edge: new Uint8Array(bins), packed: new Uint8Array(bins) };
    const { low, high, edge, packed } = this.scratch;
    let gap = 0;
    for (let i = 0; i < bins; i++) {
      let a = s + Math.floor(i * width / bins), b = s + Math.floor((i + 1) * width / bins);
      if (b <= a) b = Math.min(e, a + 1);
      const state = this.packedRangeState(channel, a, b);
      low[i] = state.low; high[i] = state.high; edge[i] = state.edge;
      while (gap < this.gapList.length && this.gapList[gap]!.endSample <= BigInt(a)) gap++;
      const gapHit = gap < this.gapList.length && this.gapList[gap]!.startSample < BigInt(b);
      packed[i] = state.high | (state.low << 1) | (state.edge << 2) | (gapHit ? GAP_BIT : 0);
    }
    return { channel, startSample: start, endSample: end, bins, low, high, edge, packed };
  }
  private scanPackedEdges(channel: number, start: number, end: number, output?: bigint[]): number {
    const bit = 1 << channel, summaries = this.packedSummaryBlocks;
    let count = 0, position = start, previous = position > 0 ? this.packedValue(channel, position - 1) : 0;
    const sample = (index: number): void => {
      const value = this.packedValue(channel, index);
      if (value !== previous) { count++; output?.push(BigInt(index)); }
      previous = value;
    };
    while (position < end) {
      const blockOffset = position % PACKED_STAGE_BLOCK_BYTES;
      const group = Math.floor(blockOffset / PACKED_STAGE_GROUP_SAMPLES), groupStart = group * PACKED_STAGE_GROUP_SAMPLES;
      if (summaries && blockOffset === groupStart && position + PACKED_STAGE_GROUP_SAMPLES <= end) {
        const blockIndex = Math.floor(position / PACKED_STAGE_BLOCK_BYTES), summary = summaries[blockIndex]!;
        const ones = (summary.ones[group]! & bit) !== 0, zeros = (summary.zeros[group]! & bit) !== 0;
        if (!(ones && zeros)) {
          const value = ones ? 1 : 0;
          if (value !== previous) { count++; output?.push(BigInt(position)); }
          previous = value; position += PACKED_STAGE_GROUP_SAMPLES; continue;
        }
        const stop = position + PACKED_STAGE_GROUP_SAMPLES;
        while (position < stop) sample(position++);
        continue;
      }
      sample(position++);
    }
    return count;
  }
  noteGap(start: SampleInput, end: SampleInput): void {
    const s = sampleIndex(start), e = sampleIndex(end); assertGapBounds(s, e, this.length); this.gapList = mergeGap(this.gapList, s, e);
  }
  gaps(): GapSpan[] { return this.gapList.map(g => ({...g})); }
  sampleAt(channel: number, input: SampleInput): number {
    const index = sampleIndex(input); if (index >= this.length) throw new RangeError(`sample ${index} out of range`);
    if (this.stagedPackedBlocks) {
      if (!Number.isInteger(channel) || channel < 0 || channel >= this.channelCount) throw new RangeError('channel out of range');
      return this.packedValue(channel, Number(index));
    }
    return this.segments[localNumber(index / SEGMENT)]!.sampleAt(channel, Number(index % SEGMENT));
  }
  private bounds(start: SampleInput, end: SampleInput): [bigint, bigint] {
    return [maxSample(0n, sampleFloor(start)), minSample(this.length, sampleCeil(end))];
  }
  private parts(start: bigint, end: bigint, visit: (segment: LocalPlanarSampleStore, a: number, b: number, origin: bigint) => void): void {
    for (let position = start; position < end;) {
      const origin = position / SEGMENT * SEGMENT, next = minSample(end, origin + SEGMENT);
      visit(this.segments[localNumber(position / SEGMENT)]!, Number(position - origin), Number(next - origin), origin);
      position = next;
    }
  }
  query(channel: number, startSample: SampleInput, endSample: SampleInput, bins: number): ColumnView {
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.channelCount) throw new RangeError('channel out of range');
    if (!Number.isSafeInteger(bins) || bins < 1) throw new RangeError('bins must be a positive integer');
    const [start, end] = this.bounds(startSample, endSample);
    if (start >= end) throw new RangeError('empty query range');
    if (this.stagedPackedBlocks) return this.queryPacked(channel, start, end, bins);
    let view: ColumnView;
    if (start / SEGMENT === (end - 1n) / SEGMENT) {
      const origin = start / SEGMENT * SEGMENT, segment = this.segments[localNumber(start / SEGMENT)]!;
      segment.snapColumns = this.snapColumns; segment.coreBins = this.coreBins;
      const local = segment.query(channel, Number(start - origin), Number(end - origin), bins);
      view = {...local, startSample: start, endSample: end};
      if (!this.gapList.length && (start % SEGMENT !== 0n || start === 0n)) return view;
    } else {
      if (this.scratch.low.length !== bins) this.scratch = {low: new Uint8Array(bins), high: new Uint8Array(bins), edge: new Uint8Array(bins), packed: new Uint8Array(bins)};
      const {low, high, edge, packed} = this.scratch, width = end - start, divisor = BigInt(bins);
      for (let i = 0; i < bins; i++) {
        const a = start + width * BigInt(i) / divisor, b = minSample(end, maxSample(a + 1n, start + width * BigInt(i + 1) / divisor));
        let lo = 1, hi = 0, ev = 0;
        this.parts(a, b, (segment, s, e, origin) => {
          const v = segment.query(channel, s, e, 1); lo &= v.low[0]!; hi |= v.high[0]!; ev |= v.edge[0]!;
          if (s === 0 && origin > 0n && this.sampleAt(channel, origin - 1n) !== segment.sampleAt(channel, 0)) ev = 1;
        });
        low[i] = lo; high[i] = hi; edge[i] = ev; packed[i] = hi | lo << 1 | ev << 2;
      }
      view = {channel, startSample: start, endSample: end, bins, low, high, edge, packed};
    }
    const width = end - start, divisor = BigInt(bins);
    for (let i = 0, gap = 0; i < bins; i++) {
      const a = start + width * BigInt(i) / divisor, b = minSample(end, maxSample(a + 1n, start + width * BigInt(i + 1) / divisor));
      if (a > 0n && a % SEGMENT === 0n && this.sampleAt(channel, a - 1n) !== this.sampleAt(channel, a)) { view.edge[i] = 1; view.packed[i] |= 4; }
      while (gap < this.gapList.length && this.gapList[gap]!.endSample <= a) gap++;
      if (gap < this.gapList.length && this.gapList[gap]!.startSample < b) view.packed[i] |= GAP_BIT;
    }
    return view;
  }
  edges(channel: number, startSample: SampleInput, endSample: SampleInput): bigint[] {
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.channelCount) throw new RangeError('channel out of range');
    const [start, end] = this.bounds(startSample, endSample), out: bigint[] = [];
    if (this.stagedPackedBlocks) {
      for (const [a, b] of splitAroundGaps(this.gapList, maxSample(1n, start), end)) {
        this.scanPackedEdges(channel, Number(a), Number(b), out);
      }
      return out;
    }
    for (const [a, b] of splitAroundGaps(this.gapList, maxSample(1n, start), end)) this.parts(a, b, (segment, s, e, origin) => {
      if (!s && origin > 0n && this.sampleAt(channel, origin - 1n) !== segment.sampleAt(channel, 0)) out.push(origin);
      for (const edge of segment.edges(channel, s, e)) out.push(origin + BigInt(edge));
    });
    return out;
  }
  edgeCount(channel: number, startSample: SampleInput, endSample: SampleInput): number {
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.channelCount) throw new RangeError('channel out of range');
    const [start, end] = this.bounds(startSample, endSample); let count = 0;
    if (this.stagedPackedBlocks) {
      for (const [a, b] of splitAroundGaps(this.gapList, maxSample(1n, start), end)) {
        count += this.scanPackedEdges(channel, Number(a), Number(b));
      }
      return count;
    }
    for (const [a, b] of splitAroundGaps(this.gapList, maxSample(1n, start), end)) this.parts(a, b, (segment, s, e, origin) => {
      count += segment.edgeCount(channel, s, e);
      if (!s && origin > 0n && this.sampleAt(channel, origin - 1n) !== segment.sampleAt(channel, 0)) count++;
    });
    return count;
  }
  packRange(startSample: SampleInput, endSample: SampleInput, channels = this.channelCount): Uint8Array {
    const start = sampleIndex(startSample), end = sampleIndex(endSample);
    if (end < start || end > this.length) throw new RangeError('invalid packed range');
    const stride = Math.ceil(channels / 8), out = new Uint8Array(localNumber(end - start, 2 ** 26) * stride); let offset = 0;
    if (this.stagedPackedBlocks) {
      if (stride !== 1) throw new RangeError('packed capture supports at most 8 channels');
      const mask = (1 << channels) - 1;
      for (let index = Number(start); index < Number(end); index++) out[index - Number(start)] = this.stagedPackedBlocks[Math.floor(index / PACKED_STAGE_BLOCK_BYTES)]![index % PACKED_STAGE_BLOCK_BYTES]! & mask;
      return out;
    }
    this.parts(start, end, (segment, a, b) => { const chunk = segment.packRange(a, b, channels); out.set(chunk, offset); offset += chunk.length; });
    return out;
  }
  channelRange(channel: number, startSample: SampleInput, endSample: SampleInput): Uint8Array {
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.channelCount) throw new RangeError('channel out of range');
    const start = sampleIndex(startSample), end = sampleIndex(endSample);
    if (end < start || end > this.length || end - start > BigInt(2 ** 26)) throw new RangeError('invalid channel range');
    const output = new Uint8Array(Number(end - start));
    if (!this.stagedPackedBlocks) {
      const packed = this.packRange(start, end, channel + 1);
      for (let index = 0; index < output.length; index++) output[index] = (packed[index]! >>> channel) & 1;
      return output;
    } else {
      const mask = 1 << channel;
      for (let index = Number(start); index < Number(end); index++) output[index - Number(start)] = (this.stagedPackedBlocks[Math.floor(index / PACKED_STAGE_BLOCK_BYTES)]![index % PACKED_STAGE_BLOCK_BYTES]! & mask) ? 1 : 0;
      return output;
    }
  }
  memory(): MemoryReport {
    let baseBytes = 0, pyramidBytes = 0, totalBytes = 0, slackBytes = 0;
    for (const segment of this.segments) { const m = segment.memory(); baseBytes += m.baseBytes; pyramidBytes += m.pyramidBytes; totalBytes += m.totalBytes; slackBytes += m.slackBytes; }
    const stagedBytes = (this.stagedPackedBlocks ?? []).reduce((n, block) => n + (block?.byteLength ?? 0), 0);
    const summaryBytes = (this.packedSummaryBlocks ?? []).reduce((n, block) => n + block.buffer.byteLength, 0);
    baseBytes += stagedBytes; pyramidBytes += summaryBytes; totalBytes += stagedBytes + summaryBytes;
    if (this.stagedPackedBlocks) slackBytes += Math.max(0, stagedBytes - Number(this.sampleCount));
    totalBytes += Object.values(this.scratch).reduce((n, a) => n + a.byteLength, 0);
    return {baseBytes, pyramidBytes, totalBytes, slackBytes, overhead: baseBytes ? pyramidBytes / baseBytes : 0};
  }
}
