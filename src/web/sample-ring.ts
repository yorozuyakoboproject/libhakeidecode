import type { ColumnView } from './data/types.js';
import type { MemoryBudget } from './memory.js';
const PAGE_SAMPLES = 65536;
const GROUP_SAMPLES = 256;
const FANOUT = 16;
type Values = Uint32Array | Float32Array;
type Level = { step: number; count: number; offset: number };
type Page = { values: Values; summary: Float64Array; levels: Level[]; version: number };
export type IndexedPage = Page & { index: number };
export type RingSnapshot = { capacity: number; digital: boolean; cursor: number; length: number; pages: IndexedPage[] };
function summaryLevels(size: number): Level[] {
  const levels: Level[] = [];
  let step = GROUP_SAMPLES,
    count = Math.ceil(size / step),
    offset = 0;
  while (true) {
    levels.push({ step, count, offset });
    if (count === 1) return levels;
    offset += count * 3;
    step *= FANOUT;
    count = Math.ceil(count / FANOUT);
  }
}
export class SampleRing {
  readonly viewMetrics = { copiedBytes: 0, peakHeldBytes: 0 };
  private readonly pages = new Map<number, Page>();
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
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid rolling window capacity');
  }
  get offset(): bigint {
    return this.total - BigInt(this.length);
  }
  append(values: ArrayLike<number>): void {
    const count = values.length;
    let offset = Math.max(0, count - this.capacity);
    this.cursor = (this.cursor + offset) % this.capacity;
    while (offset < count) {
      const index = Math.floor(this.cursor / PAGE_SAMPLES),
        local = this.cursor % PAGE_SAMPLES;
      let page = this.pages.get(index);
      if (!page) {
        page = this.allocate(Math.min(PAGE_SAMPLES, this.capacity - index * PAGE_SAMPLES));
        this.pages.set(index, page);
        this.changed.set(index, page);
      } else if (this.view && page.version !== this.view.id) {
        const bytes = page.values.byteLength + page.summary.byteLength;
        if (this.view.bytes + bytes > 32 * 1024 * 1024) this.view.cancel();
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
      for (let group = Math.floor(local / GROUP_SAMPLES); group < Math.ceil((local + take) / GROUP_SAMPLES); group++) {
        let low = this.digital ? 0xffffffff : Infinity,
          high = this.digital ? 0 : -Infinity,
          sum = 0;
        const end = Math.min(page.values.length, (group + 1) * GROUP_SAMPLES);
        for (let i = group * GROUP_SAMPLES; i < end; i++) {
          const value = page.values[i]!;
          if (this.digital) {
            low &= value;
            high |= value;
          } else {
            low = Math.min(low, value);
            high = Math.max(high, value);
            sum += value;
          }
        }
        const summaryOffset = group * 3;
        page.summary[summaryOffset] = this.digital ? low >>> 0 : low;
        page.summary[summaryOffset + 1] = this.digital ? high >>> 0 : high;
        page.summary[summaryOffset + 2] = sum;
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
            const offset = previous.offset + child * 3;
            if (this.digital) {
              low &= page.summary[offset]!;
              high |= page.summary[offset + 1]!;
            } else {
              low = Math.min(low, page.summary[offset]!);
              high = Math.max(high, page.summary[offset + 1]!);
              sum += page.summary[offset + 2]!;
            }
          }
          const offset = current.offset + group * 3;
          page.summary[offset] = this.digital ? low >>> 0 : low;
          page.summary[offset + 1] = this.digital ? high >>> 0 : high;
          page.summary[offset + 2] = sum;
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
    return this.pages.get(Math.floor(position / PAGE_SAMPLES))!.values[position % PAGE_SAMPLES]!;
  }
  aggregate(start: number, end: number): [number, number, number] {
    if (start < 0 || end > this.length || start >= end) throw new RangeError('Invalid rolling sample range');
    let low = this.digital ? 0xffffffff : Infinity,
      high = this.digital ? 0 : -Infinity,
      sum = 0;
    for (let index = start; index < end;) {
      const position = this.position(index),
        page = this.pages.get(Math.floor(position / PAGE_SAMPLES))!,
        local = position % PAGE_SAMPLES;
      let a = this.digital ? 0xffffffff : Infinity,
        b = this.digital ? 0 : -Infinity,
        total = 0,
        take = 0;
      for (let level = page.levels.length - 1; level >= 0; level--) {
        const summary = page.levels[level]!,
          count = Math.min(summary.step, page.values.length - local);
        if (local % summary.step === 0 && end - index >= count) {
          const offset = summary.offset + Math.floor(local / summary.step) * 3;
          a = page.summary[offset]!;
          b = page.summary[offset + 1]!;
          total = page.summary[offset + 2]!;
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
    const output = this.digital ? new Uint32Array(end - start) : new Float32Array(end - start);
    for (let index = start; index < end;) {
      const position = this.position(index),
        page = this.pages.get(Math.floor(position / PAGE_SAMPLES))!,
        local = position % PAGE_SAMPLES,
        take = Math.min(end - index, page.values.length - local);
      output.set(page.values.subarray(local, local + take), index - start);
      index += take;
    }
    return output;
  }
  channelRange(channel: number, start: number, end: number): Uint8Array {
    const output = new Uint8Array(end - start);
    for (let index = start; index < end;) {
      const position = this.position(index),
        page = this.pages.get(Math.floor(position / PAGE_SAMPLES))!,
        local = position % PAGE_SAMPLES,
        take = Math.min(end - index, page.values.length - local);
      for (let i = 0; i < take; i++) output[index - start + i] = (page.values[local + i]! >>> channel) & 1;
      index += take;
    }
    return output;
  }
  channelEdges(channel: number, start: number, end: number, limit: number): bigint[] | null {
    const edges: bigint[] = [],
      mask = 1 << channel;
    let previous = this.at(start > 0 ? start - 1 : start) & mask;
    for (let index = start; index < end;) {
      const position = this.position(index),
        page = this.pages.get(Math.floor(position / PAGE_SAMPLES))!,
        local = position % PAGE_SAMPLES;
      let take = Math.min(end - index, page.values.length - local, GROUP_SAMPLES - (local % GROUP_SAMPLES)),
        uniform: number | undefined;
      for (let level = page.levels.length - 1; level >= 0; level--) {
        const summary = page.levels[level]!,
          offset = summary.offset + Math.floor(local / summary.step) * 3;
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
    const allocate = (bytes: number, label: string) =>
      this.digital ? this.budget!.allocateShared(bytes, label) : this.budget!.allocate(bytes, label);
    const values = allocate(size * 4, 'rolling samples'),
      levels = summaryLevels(size);
    try {
      const last = levels.at(-1)!;
      const summary = new Float64Array(allocate((last.offset + last.count * 3) * 8, 'rolling summary'));
      return {
        values: this.digital ? new Uint32Array(values) : new Float32Array(values),
        summary,
        levels,
        version: this.view?.id ?? 0,
      };
    } catch (error) {
      this.budget.release(values);
      throw error;
    }
  }
  private changes(): IndexedPage[] {
    const pages = [...this.changed].map(([index, page]) => ({ index, ...page }));
    this.changed.clear();
    return pages;
  }
  pin(cancel: () => void): RingSnapshot {
    if (this.view) throw new Error('Waveform view is already reading');
    this.view = { id: ++this.viewId, held: [], bytes: 0, cancel };
    return {
      capacity: this.capacity,
      digital: this.digital,
      cursor: this.cursor,
      length: this.length,
      pages: this.changes(),
    };
  }
  unpin(): IndexedPage[] {
    for (const page of this.view?.held ?? []) {
      this.budget?.release(page.values.buffer);
      this.budget?.release(page.summary.buffer);
    }
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
    let bytes = 0;
    for (const page of this.pages.values()) bytes += page.values.byteLength + page.summary.byteLength;
    return bytes;
  }
  dispose(): void {
    this.unpin();
    for (const page of this.pages.values()) {
      this.budget?.release(page.values.buffer);
      this.budget?.release(page.summary.buffer);
    }
    this.changed.clear();
    this.pages.clear();
    this.length = this.cursor = 0;
    this.total = 0n;
  }
}
