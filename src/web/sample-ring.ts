import type { ColumnView } from './data/types.js';
import type { MemoryBudget } from './memory.js';
const SMALL_PAGE_SAMPLES = 65536;
const LARGE_PAGE_SAMPLES = 262144;
const LARGE_RING_THRESHOLD = 4_194_304;
const GROUP_SAMPLES = 256;
const FANOUT = 16;
const MAX_VIEW_COW_BYTES = 64 * 1024 * 1024;
const MAX_COW_POOL_PAGES = 16;
type DigitalValues = Uint8Array | Uint16Array | Uint32Array;
type Values = DigitalValues | Float32Array;
type SummaryArray = Uint32Array | Float64Array;
type Level = { step: number; count: number; offset: number };
type Page = { values: Values; words?: Uint32Array | null; summary: SummaryArray; levels: Level[]; version: number };
export type IndexedPage = Page & { index: number };
export type RingSnapshot = {
  capacity: number;
  digital: boolean;
  bytesPerSample: 1 | 2 | 4;
  pageSamples: number;
  cursor: number;
  length: number;
  pages: IndexedPage[];
};
function summaryLevels(size: number, stride: number): Level[] {
  const levels: Level[] = [];
  let step = GROUP_SAMPLES,
    count = Math.ceil(size / step),
    offset = 0;
  while (true) {
    levels.push({ step, count, offset });
    if (count === 1) return levels;
    offset += count * stride;
    step *= FANOUT;
    count = Math.ceil(count / FANOUT);
  }
}
export class SampleRing {
  readonly viewMetrics = { copiedBytes: 0, peakHeldBytes: 0 };
  readonly pageSamples: number;
  readonly bytesPerSample: 1 | 2 | 4;
  private readonly summaryStride: 2 | 3;
  private readonly pages = new Map<number, Page>();
  private readonly cowPool: Page[] = [];
  private allocatedBytes = 0;
  private cursor = 0;
  private columns?: {
    revision: number;
    start: number;
    end: number;
    bins: number;
    low: Uint32Array;
    high: Uint32Array;
    edge: Uint32Array;
  };
  private readonly changed = new Map<number, Page>();
  private viewId = 0;
  private view?: { id: number; held: Page[]; bytes: number; cancel: () => void };
  length = 0;
  total = 0n;
  revision = 0;
  constructor(
    readonly capacity: number,
    private readonly digital: boolean,
    private readonly budget?: MemoryBudget,
    bytesPerSample: 1 | 2 | 4 = 4,
    pageSamples?: number,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid rolling window capacity');
    this.bytesPerSample = digital ? bytesPerSample : 4;
    this.summaryStride = digital ? 2 : 3;
    this.pageSamples =
      pageSamples ?? (digital && capacity > LARGE_RING_THRESHOLD ? LARGE_PAGE_SAMPLES : SMALL_PAGE_SAMPLES);
  }
  get offset(): bigint {
    return this.total - BigInt(this.length);
  }
  append(values: ArrayLike<number>): void {
    const count = values.length;
    const pageSamples = this.pageSamples;
    const stride = this.summaryStride;
    let offset = Math.max(0, count - this.capacity);
    this.cursor = (this.cursor + offset) % this.capacity;
    while (offset < count) {
      const index = Math.floor(this.cursor / pageSamples),
        local = this.cursor % pageSamples;
      let page = this.pages.get(index);
      if (!page) {
        page = this.allocate(Math.min(pageSamples, this.capacity - index * pageSamples));
        this.pages.set(index, page);
        this.changed.set(index, page);
      } else if (this.view && page.version !== this.view.id) {
        const bytes = page.values.byteLength + page.summary.byteLength;
        if (this.view.bytes + bytes > MAX_VIEW_COW_BYTES) this.view.cancel();
        if (this.view) {
          const original = page;
          page = this.allocate(original.values.length);
          page.values.set(original.values);
          page.summary.set(original.summary);
          this.view.held.push(original);
          this.view.bytes += bytes;
          this.viewMetrics.copiedBytes += bytes;
          this.viewMetrics.peakHeldBytes = Math.max(this.viewMetrics.peakHeldBytes, this.view.bytes);
          this.pages.set(index, page);
          this.changed.set(index, page);
        }
      }
      const take = Math.min(count - offset, page.values.length - local);
      if (ArrayBuffer.isView(values) && 'subarray' in values)
        page.values.set((values as Values).subarray(offset, offset + take), local);
      else for (let i = 0; i < take; i++) page.values[local + i] = values[offset + i]!;
      const firstGroup = Math.floor(local / GROUP_SAMPLES),
        afterGroup = Math.ceil((local + take) / GROUP_SAMPLES);
      if (this.digital) {
        const pageVals = page.values as DigitalValues;
        const summary = page.summary as Uint32Array;
        if (this.bytesPerSample === 1) {
          const bytes = pageVals as Uint8Array;
          const words = (page.words ??= new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2));
          for (let group = firstGroup; group < afterGroup; group++) {
            const start = group * GROUP_SAMPLES;
            const end = Math.min(bytes.length, start + GROUP_SAMPLES);
            let low32 = -1,
              high32 = 0;
            const wordStart = start >>> 2;
            const wordEnd = end >>> 2;
            for (let w = wordStart; w < wordEnd; w++) {
              const v = words[w]!;
              low32 &= v;
              high32 |= v;
            }
            let low = low32 & (low32 >>> 8) & (low32 >>> 16) & (low32 >>> 24) & 0xff;
            let high = (high32 | (high32 >>> 8) | (high32 >>> 16) | (high32 >>> 24)) & 0xff;
            for (let i = wordEnd << 2; i < end; i++) {
              const value = bytes[i]!;
              low &= value;
              high |= value;
            }
            const summaryOffset = group * 2;
            summary[summaryOffset] = low >>> 0;
            summary[summaryOffset + 1] = high >>> 0;
          }
        } else if (this.bytesPerSample === 2) {
          const shorts = pageVals as Uint16Array;
          const words = (page.words ??= new Uint32Array(shorts.buffer, shorts.byteOffset, shorts.length >>> 1));
          for (let group = firstGroup; group < afterGroup; group++) {
            const start = group * GROUP_SAMPLES;
            const end = Math.min(shorts.length, start + GROUP_SAMPLES);
            let low32 = -1,
              high32 = 0;
            const wordStart = start >>> 1;
            const wordEnd = end >>> 1;
            for (let w = wordStart; w < wordEnd; w++) {
              const v = words[w]!;
              low32 &= v;
              high32 |= v;
            }
            let low = low32 & (low32 >>> 16) & 0xffff;
            let high = (high32 | (high32 >>> 16)) & 0xffff;
            for (let i = wordEnd << 1; i < end; i++) {
              const value = shorts[i]!;
              low &= value;
              high |= value;
            }
            const summaryOffset = group * 2;
            summary[summaryOffset] = low >>> 0;
            summary[summaryOffset + 1] = high >>> 0;
          }
        } else {
          for (let group = firstGroup; group < afterGroup; group++) {
            let low = -1,
              high = 0;
            const end = Math.min(pageVals.length, (group + 1) * GROUP_SAMPLES);
            for (let i = group * GROUP_SAMPLES; i < end; i++) {
              const value = pageVals[i]!;
              low &= value;
              high |= value;
            }
            const summaryOffset = group * 2;
            summary[summaryOffset] = low >>> 0;
            summary[summaryOffset + 1] = high >>> 0;
          }
        }
      } else {
        const pageVals = page.values as Float32Array;
        const summary = page.summary as Float64Array;
        for (let group = firstGroup; group < afterGroup; group++) {
          let low = Infinity,
            high = -Infinity,
            sum = 0;
          const end = Math.min(pageVals.length, (group + 1) * GROUP_SAMPLES);
          for (let i = group * GROUP_SAMPLES; i < end; i++) {
            const value = pageVals[i]!;
            low = Math.min(low, value);
            high = Math.max(high, value);
            sum += value;
          }
          const summaryOffset = group * 3;
          summary[summaryOffset] = low;
          summary[summaryOffset + 1] = high;
          summary[summaryOffset + 2] = sum;
        }
      }
      let first = Math.floor(local / GROUP_SAMPLES),
        after = Math.ceil((local + take) / GROUP_SAMPLES);
      for (let level = 1; level < page.levels.length; level++) {
        first = Math.floor(first / FANOUT);
        after = Math.ceil(after / FANOUT);
        const previous = page.levels[level - 1]!,
          current = page.levels[level]!;
        for (let group = first; group < after; group++) {
          let low = this.digital ? 0xffffffff : Infinity,
            high = this.digital ? 0 : -Infinity,
            sum = 0;
          for (let child = group * FANOUT; child < Math.min(previous.count, (group + 1) * FANOUT); child++) {
            const childOffset = previous.offset + child * stride;
            if (this.digital) {
              low &= page.summary[childOffset]!;
              high |= page.summary[childOffset + 1]!;
            } else {
              low = Math.min(low, page.summary[childOffset]!);
              high = Math.max(high, page.summary[childOffset + 1]!);
              sum += page.summary[childOffset + 2]!;
            }
          }
          const targetOffset = current.offset + group * stride;
          page.summary[targetOffset] = this.digital ? low >>> 0 : low;
          page.summary[targetOffset + 1] = this.digital ? high >>> 0 : high;
          if (!this.digital) page.summary[targetOffset + 2] = sum;
        }
      }
      this.cursor = (this.cursor + take) % this.capacity;
      offset += take;
    }
    this.total += BigInt(count);
    this.length = Math.min(this.capacity, this.length + count);
    this.revision++;
  }
  private position(index: number): number {
    const position = this.cursor - this.length + index;
    return position < 0 ? position + this.capacity : position;
  }
  at(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length)
      throw new RangeError('Sample outside rolling window');
    const position = this.position(index);
    return this.pages.get(Math.floor(position / this.pageSamples))!.values[position % this.pageSamples]!;
  }
  aggregate(start: number, end: number): [number, number, number] {
    if (start < 0 || end > this.length || start >= end) throw new RangeError('Invalid rolling sample range');
    const pageSamples = this.pageSamples;
    const stride = this.summaryStride;
    let low = this.digital ? 0xffffffff : Infinity,
      high = this.digital ? 0 : -Infinity,
      sum = 0;
    for (let index = start; index < end;) {
      const position = this.position(index),
        page = this.pages.get(Math.floor(position / pageSamples))!,
        local = position % pageSamples;
      let a = this.digital ? 0xffffffff : Infinity,
        b = this.digital ? 0 : -Infinity,
        total = 0,
        take = 0;
      for (let level = page.levels.length - 1; level >= 0; level--) {
        const summary = page.levels[level]!,
          count = Math.min(summary.step, page.values.length - local);
        if (local % summary.step === 0 && end - index >= count) {
          const offset = summary.offset + Math.floor(local / summary.step) * stride;
          a = page.summary[offset]!;
          b = page.summary[offset + 1]!;
          total = this.digital ? 0 : page.summary[offset + 2]!;
          take = count;
          break;
        }
      }
      if (!take) {
        take = Math.min(end - index, page.values.length - local, GROUP_SAMPLES - (local % GROUP_SAMPLES));
        for (let i = 0; i < take; i++) {
          const value = page.values[local + i]!;
          if (this.digital) {
            a &= value;
            b |= value;
          } else {
            a = Math.min(a, value);
            b = Math.max(b, value);
            total += value;
          }
        }
      }
      if (this.digital) {
        low &= a;
        high |= b;
      } else {
        low = Math.min(low, a);
        high = Math.max(high, b);
        sum += total;
      }
      index += take;
    }
    return [this.digital ? low >>> 0 : low, this.digital ? high >>> 0 : high, sum];
  }
  query(channel: number, start: number, end: number, bins: number, digital = true): ColumnView {
    if (start < 0 || end > this.length || end <= start || !Number.isSafeInteger(bins) || bins < 1)
      throw new RangeError('Invalid rolling viewport');
    let columns = this.columns;
    if (
      !columns ||
      columns.revision !== this.revision ||
      columns.start !== start ||
      columns.end !== end ||
      columns.bins !== bins
    ) {
      columns = {
        revision: this.revision,
        start,
        end,
        bins,
        low: new Uint32Array(bins),
        high: new Uint32Array(bins),
        edge: new Uint32Array(bins),
      };
      const first = Number(start),
        span = Number(end - start);
      for (let i = 0; i < bins; i++) {
        const a = first + Math.floor((span * i) / bins),
          b = Math.min(Number(end), Math.max(a + 1, first + Math.floor((span * (i + 1)) / bins)));
        const [low, high] = digital ? this.aggregate(a, b) : [0, 0];
        columns.low[i] = low!;
        columns.high[i] = high!;
        columns.edge[i] = (low! ^ high!) | (digital && a ? this.at(a) ^ this.at(a - 1) : 0);
      }
      this.columns = columns;
    }
    const low = new Uint8Array(bins),
      high = new Uint8Array(bins),
      edge = new Uint8Array(bins),
      packed = new Uint8Array(bins);
    for (let i = 0; i < bins; i++) {
      low[i] = (columns.low[i]! >>> channel) & 1;
      high[i] = (columns.high[i]! >>> channel) & 1;
      edge[i] = (columns.edge[i]! >>> channel) & 1;
      packed[i] = high[i]! | (low[i]! << 1) | (edge[i]! << 2);
    }
    return { channel, startSample: BigInt(start), endSample: BigInt(end), bins, low, high, edge, packed };
  }
  copy(start = 0, end = this.length): Values {
    const count = end - start;
    const output: Values = !this.digital
      ? new Float32Array(count)
      : this.bytesPerSample === 1
        ? new Uint8Array(count)
        : this.bytesPerSample === 2
          ? new Uint16Array(count)
          : new Uint32Array(count);
    const pageSamples = this.pageSamples;
    for (let index = start; index < end;) {
      const position = this.position(index),
        page = this.pages.get(Math.floor(position / pageSamples))!,
        local = position % pageSamples,
        take = Math.min(end - index, page.values.length - local);
      output.set(page.values.subarray(local, local + take), index - start);
      index += take;
    }
    return output;
  }
  copyPacked(start: number, end: number, sampleBytes: number): Uint8Array {
    const count = end - start;
    const output = new Uint8Array(count * sampleBytes);
    const pageSamples = this.pageSamples;
    if (this.digital && sampleBytes === this.bytesPerSample) {
      for (let index = start; index < end;) {
        const position = this.position(index),
          page = this.pages.get(Math.floor(position / pageSamples))!,
          local = position % pageSamples,
          take = Math.min(end - index, page.values.length - local);
        const bytes = new Uint8Array(
          page.values.buffer,
          page.values.byteOffset + local * sampleBytes,
          take * sampleBytes,
        );
        output.set(bytes, (index - start) * sampleBytes);
        index += take;
      }
      return output;
    }
    for (let index = start; index < end;) {
      const position = this.position(index),
        page = this.pages.get(Math.floor(position / pageSamples))!,
        local = position % pageSamples,
        take = Math.min(end - index, page.values.length - local);
      let dst = (index - start) * sampleBytes;
      for (let i = 0; i < take; i++) {
        const value = page.values[local + i]!;
        for (let b = 0; b < sampleBytes; b++) output[dst++] = (value >>> (b * 8)) & 0xff;
      }
      index += take;
    }
    return output;
  }
  channelRange(channel: number, start: number, end: number): Uint8Array {
    const output = new Uint8Array(end - start);
    const pageSamples = this.pageSamples;
    for (let index = start; index < end;) {
      const position = this.position(index),
        page = this.pages.get(Math.floor(position / pageSamples))!,
        local = position % pageSamples,
        take = Math.min(end - index, page.values.length - local);
      for (let i = 0; i < take; i++) output[index - start + i] = (page.values[local + i]! >>> channel) & 1;
      index += take;
    }
    return output;
  }
  channelEdges(channel: number, start: number, end: number, limit: number): bigint[] | null {
    const edges: bigint[] = [],
      mask = 1 << channel,
      pageSamples = this.pageSamples,
      stride = this.summaryStride;
    let previous = this.at(start > 0 ? start - 1 : start) & mask;
    for (let index = start; index < end;) {
      const position = this.position(index),
        page = this.pages.get(Math.floor(position / pageSamples))!,
        local = position % pageSamples;
      let take = Math.min(end - index, page.values.length - local, GROUP_SAMPLES - (local % GROUP_SAMPLES)),
        uniform: number | undefined;
      for (let level = page.levels.length - 1; level >= 0; level--) {
        const summary = page.levels[level]!,
          offset = summary.offset + Math.floor(local / summary.step) * stride;
        const low = page.summary[offset]! & mask,
          high = page.summary[offset + 1]! & mask;
        if (low === high) {
          uniform = low;
          take = Math.min(end - index, page.values.length - local, summary.step - (local % summary.step));
          break;
        }
      }
      if (uniform !== undefined) {
        if (previous !== uniform) edges.push(BigInt(index));
        previous = uniform;
      } else {
        for (let i = 0; i < take; i++) {
          const level = page.values[local + i]! & mask;
          if (level !== previous) {
            edges.push(BigInt(index + i));
            if (edges.length > limit) return null;
          }
          previous = level;
        }
      }
      if (edges.length > limit) return null;
      index += take;
    }
    return edges;
  }
  private allocate(size: number): Page {
    if (!this.budget) throw new Error('Read-only sample ring');
    if (size === this.pageSamples && this.cowPool.length) {
      const reused = this.cowPool.pop()!;
      reused.version = this.view?.id ?? 0;
      return reused;
    }
    const allocate = (bytes: number, label: string) =>
      this.digital ? this.budget!.allocateShared(bytes, label) : this.budget!.allocate(bytes, label);
    const values = allocate(size * this.bytesPerSample, 'rolling samples'),
      levels = summaryLevels(size, this.summaryStride);
    try {
      const last = levels.at(-1)!;
      const summaryElements = last.offset + last.count * this.summaryStride;
      const summary = this.digital
        ? new Uint32Array(allocate(summaryElements * 4, 'rolling summary'))
        : new Float64Array(allocate(summaryElements * 8, 'rolling summary'));
      const typedValues: Values = !this.digital
        ? new Float32Array(values)
        : this.bytesPerSample === 1
          ? new Uint8Array(values)
          : this.bytesPerSample === 2
            ? new Uint16Array(values)
            : new Uint32Array(values);
      this.allocatedBytes += typedValues.byteLength + summary.byteLength;
      return {
        values: typedValues,
        summary,
        levels,
        version: this.view?.id ?? 0,
      };
    } catch (error) {
      this.budget.release(values);
      throw error;
    }
  }
  private releasePage(page: Page, pool = false): void {
    if (pool && this.digital && page.values.length === this.pageSamples && this.cowPool.length < MAX_COW_POOL_PAGES) {
      this.cowPool.push(page);
      return;
    }
    this.allocatedBytes -= page.values.byteLength + page.summary.byteLength;
    this.budget?.release(page.values.buffer);
    this.budget?.release(page.summary.buffer);
  }
  private changes(): IndexedPage[] {
    const pages = [...this.changed].map(([index, { words: _words, ...page }]) => ({ index, ...page }));
    this.changed.clear();
    return pages;
  }
  pin(cancel: () => void): RingSnapshot {
    if (this.view) throw new Error('Waveform view is already reading');
    this.view = { id: ++this.viewId, held: [], bytes: 0, cancel };
    return {
      capacity: this.capacity,
      digital: this.digital,
      bytesPerSample: this.bytesPerSample,
      pageSamples: this.pageSamples,
      cursor: this.cursor,
      length: this.length,
      pages: this.changes(),
    };
  }
  unpin(): IndexedPage[] {
    for (const page of this.view?.held ?? []) this.releasePage(page, true);
    this.view = undefined;
    return this.changes();
  }
  accept(snapshot: RingSnapshot): void {
    this.patch(snapshot.pages);
    this.cursor = snapshot.cursor;
    this.length = snapshot.length;
    this.revision++;
  }
  patch(pages: readonly IndexedPage[]): void {
    for (const { index, ...page } of pages) this.pages.set(index, page);
  }
  republish(): void {
    for (const [index, page] of this.pages) this.changed.set(index, page);
  }
  memory(): number {
    return this.allocatedBytes;
  }
  dispose(): void {
    for (const page of this.view?.held ?? []) this.releasePage(page, false);
    this.view = undefined;
    for (const page of this.cowPool.splice(0)) this.releasePage(page, false);
    for (const page of this.pages.values()) this.releasePage(page, false);
    this.changed.clear();
    this.pages.clear();
    this.allocatedBytes = 0;
    this.length = this.cursor = 0;
    this.total = 0n;
  }
}
