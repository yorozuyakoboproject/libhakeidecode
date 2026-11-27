import { samplePosition, maxSample, compareSamples, type SampleInput } from '../libhakei/sample-index.js';
import type { Annotation } from './protocol.js';
import { SampleColumn } from './sample-column.js';

const PAGE_SIZE = 65_536;
function textsCacheKey(texts: readonly string[]): string {
  return texts.length === 1 ? '\u0001' + texts[0]! : JSON.stringify(texts);
}
type AnnotationPage = {
  ss: SampleColumn;
  es: SampleColumn;
  end: SampleColumn;
  classes: Uint8Array;
  textIds: Uint32Array;
  values: Float64Array | null;
  hasValue: Uint8Array | null;
};
const emptyPage = (base: bigint): AnnotationPage => ({
  ss: new SampleColumn(base, PAGE_SIZE),
  es: new SampleColumn(base, PAGE_SIZE),
  end: new SampleColumn(base, PAGE_SIZE),
  classes: new Uint8Array(PAGE_SIZE),
  textIds: new Uint32Array(PAGE_SIZE),
  values: null,
  hasValue: null,
});

export class AnnotationIndex {
  private pages: AnnotationPage[] = [];
  private count = 0;
  private head = 0;
  private pending: Annotation[] = [];
  private ordered = true;
  private lastSs = -1n;
  private lastEs = -1n;
  private maximumEnd = -1n;
  private pendingBytes = 0;
  private textBytes = 0;
  private readonly textPool: (readonly string[] | undefined)[] = [];
  private readonly textUses: number[] = [];
  private readonly freeTextIds: number[] = [];
  private readonly textIds = new Map<string, number>();

  get reservedBytes(): number {
    return (
      this.pendingBytes +
      this.textBytes +
      this.pages.reduce(
        (sum, page) =>
          sum +
          page.ss.reservedBytes +
          page.es.reservedBytes +
          page.end.reservedBytes +
          page.classes.byteLength +
          page.textIds.byteLength +
          (page.values?.byteLength ?? 0) +
          (page.hasValue?.byteLength ?? 0),
        0,
      )
    );
  }
  get length(): number {
    return this.count - this.head + this.pending.length;
  }

  append(records: Annotation[]): void {
    for (const input of records) {
      const record: Annotation =
        typeof input.ss === 'bigint' && typeof input.es === 'bigint'
          ? input
          : { ...input, ss: samplePosition(input.ss), es: samplePosition(input.es) };
      if (record.ss < this.lastSs || (record.ss === this.lastSs && record.es < this.lastEs)) this.ordered = false;
      this.pending.push(record);
      this.lastSs = record.ss;
      this.lastEs = record.es;
      this.pendingBytes += 40 + record.texts.reduce((bytes, text) => bytes + 2 + text.length * 2, 0);
    }
    if (this.pending.length >= 1024) this.flushPending();
  }

  clear(): void {
    this.pages = [];
    this.count = this.head = 0;
    this.pending = [];
    this.ordered = true;
    this.lastSs = -1n;
    this.lastEs = -1n;
    this.maximumEnd = -1n;
    this.pendingBytes = 0;
    this.textBytes = 0;
    this.textPool.length = 0;
    this.textIds.clear();
    this.textUses.length = this.freeTextIds.length = 0;
  }

  discardBefore(start: bigint): void {
    this.finalize();
    const after = this.lowerBoundEnd(start + 1n);
    for (let index = this.head; index < after; index++) {
      const page = this.pages[Math.floor(index / PAGE_SIZE)]!,
        id = page.textIds[index % PAGE_SIZE]!;
      if (--this.textUses[id]! === 0) {
        const texts = this.textPool[id]!,
          key = textsCacheKey(texts);
        this.textIds.delete(key);
        this.textBytes -= key.length * 2 + texts.length * 8 + texts.reduce((bytes, text) => bytes + text.length * 2, 0);
        this.textPool[id] = undefined;
        this.freeTextIds.push(id);
      }
    }
    this.head = after;
    while (this.head >= PAGE_SIZE) {
      this.pages.shift();
      this.head -= PAGE_SIZE;
      this.count -= PAGE_SIZE;
    }
  }
  async prepareView(_start: SampleInput, _end: SampleInput, _maxResults: number): Promise<void> {}

  query(startInput: SampleInput, endInput: SampleInput, maxResults = Number.MAX_SAFE_INTEGER): Annotation[] {
    if (!Number.isSafeInteger(maxResults) || maxResults < 1)
      throw new RangeError('maxResults must be a positive safe integer');
    const start = samplePosition(startInput),
      end = samplePosition(endInput);
    this.finalize();
    let low = this.lowerBoundEnd(start),
      after = this.upperBoundStart(end);
    if (after < low) after = low;
    const count = after - low,
      stride = count > maxResults ? count / maxResults : 1;
    const out: Annotation[] = [];
    for (let bucket = 0; bucket < Math.min(count, maxResults); bucket++) {
      const index = low + (count > maxResults ? Math.floor((bucket + 0.5) * stride) : bucket);
      const record = this.recordAt(index);
      if (record.es >= start) out.push(record);
    }
    return out;
  }

  private flushPending(): void {
    if (!this.pending.length) return;
    const pending = this.pending;
    this.pending = [];
    for (const record of pending) this.write(record);
    this.pendingBytes = 0;
  }

  finalize(): void {
    this.flushPending();
    if (!this.ordered) this.rebuildOrdered();
  }

  private write(record: Annotation): void {
    const index = this.count++,
      pageIndex = Math.floor(index / PAGE_SIZE),
      offset = index % PAGE_SIZE;
    let page = this.pages[pageIndex];
    if (!page) page = this.pages[pageIndex] = emptyPage(record.ss);
    const end = maxSample(this.maximumEnd, record.es);
    this.maximumEnd = end;
    page.ss.set(offset, record.ss);
    page.es.set(offset, record.es);
    page.end.set(offset, end);
    page.classes[offset] = record.classIndex & 0xff;
    page.textIds[offset] = this.textId(record.texts);
    if (record.value !== undefined) {
      page.values ??= new Float64Array(PAGE_SIZE);
      page.hasValue ??= new Uint8Array(PAGE_SIZE / 8);
      page.values[offset] = record.value;
      page.hasValue[offset >>> 3] |= 1 << (offset & 7);
    }
  }

  private textId(texts: readonly string[]): number {
    const key = textsCacheKey(texts),
      existing = this.textIds.get(key);
    if (existing !== undefined) {
      this.textUses[existing] = this.textUses[existing]! + 1;
      return existing;
    }
    const id = this.freeTextIds.pop() ?? this.textPool.length;
    this.textPool[id] = texts;
    this.textUses[id] = 1;
    this.textIds.set(key, id);
    this.textBytes += key.length * 2 + texts.length * 8 + texts.reduce((bytes, text) => bytes + text.length * 2, 0);
    return id;
  }

  private part(index: number, kind: 'ss' | 'es' | 'end'): bigint {
    const page = this.pages[Math.floor(index / PAGE_SIZE)]!,
      offset = index % PAGE_SIZE;
    return page[kind].get(offset);
  }

  private recordAt(index: number): Annotation {
    const page = this.pages[Math.floor(index / PAGE_SIZE)]!,
      offset = index % PAGE_SIZE;
    const record: Annotation = {
      ss: this.part(index, 'ss'),
      es: this.part(index, 'es'),
      classIndex: page.classes[offset]!,
      texts: this.textPool[page.textIds[offset]!]!,
    };
    if (page.hasValue && page.hasValue[offset >>> 3]! & (1 << (offset & 7))) record.value = page.values![offset]!;
    return record;
  }

  private lowerBoundEnd(value: bigint): number {
    let low = this.head,
      high = this.count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.part(mid, 'end') < value) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private upperBoundStart(value: bigint): number {
    let low = this.head,
      high = this.count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.part(mid, 'ss') <= value) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private rebuildOrdered(): void {
    const records: Annotation[] = [];
    for (let index = this.head; index < this.count; index++) records.push(this.recordAt(index));
    records.sort((a, b) => compareSamples(a.ss, b.ss) || compareSamples(a.es, b.es));
    this.pages = [];
    this.count = this.head = 0;
    this.textPool.length = this.textUses.length = this.freeTextIds.length = 0;
    this.textIds.clear();
    this.textBytes = 0;
    this.maximumEnd = -1n;
    this.ordered = true;
    this.lastSs = -1n;
    this.lastEs = -1n;
    for (const record of records) {
      this.lastSs = record.ss;
      this.lastEs = record.es;
      this.write(record);
    }
  }
}
