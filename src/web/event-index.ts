import { samplePosition, maxSample, compareSamples, type SampleInput } from '../libhakei/sample-index.js';
import type { Annotation } from './protocol.js';

const PAGE_SIZE = 65_536;
const MAX_OFFSET = (1n << 64n) - 1n;
type AnnotationPage = {
  base: bigint;
  ssLo: Uint32Array; ssHi: Uint32Array; esLo: Uint32Array; esHi: Uint32Array;
  endLo: Uint32Array; endHi: Uint32Array; classes: Uint8Array; textIds: Uint32Array;
  values: Float64Array; hasValue: Uint8Array;
  wideSs: Map<number, bigint>; wideEs: Map<number, bigint>; wideEnd: Map<number, bigint>;
};
const emptyPage = (base: bigint): AnnotationPage => ({
  base,
  ssLo: new Uint32Array(PAGE_SIZE), ssHi: new Uint32Array(PAGE_SIZE),
  esLo: new Uint32Array(PAGE_SIZE), esHi: new Uint32Array(PAGE_SIZE),
  endLo: new Uint32Array(PAGE_SIZE), endHi: new Uint32Array(PAGE_SIZE),
  classes: new Uint8Array(PAGE_SIZE), textIds: new Uint32Array(PAGE_SIZE),
  values: new Float64Array(PAGE_SIZE), hasValue: new Uint8Array(PAGE_SIZE),
  wideSs: new Map(), wideEs: new Map(), wideEnd: new Map(),
});
const low32 = (value: bigint): number => Number(value & 0xffff_ffffn) >>> 0;
const high32 = (value: bigint): number => Number((value >> 32n) & 0xffff_ffffn) >>> 0;
const fromParts = (hi: number, lo: number): bigint => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);

export class AnnotationIndex {
  private pages: AnnotationPage[] = [];
  private count = 0;
  private pending: Annotation[] = [];
  private ordered = true;
  private lastSs = -1n;
  private lastEs = -1n;
  private maximumEnd = -1n;
  private byteReservation = 0;
  private readonly textPool: (readonly string[])[] = [];
  private readonly textIds = new Map<string, number>();

  get reservedBytes(): number { return this.byteReservation; }
  get length(): number { return this.count + this.pending.length; }

  append(records: Annotation[]): void {
    for (const input of records) {
      const record: Annotation = typeof input.ss === 'bigint' && typeof input.es === 'bigint'
        ? input
        : { ...input, ss: samplePosition(input.ss), es: samplePosition(input.es) };
      if (record.ss < this.lastSs || record.ss === this.lastSs && record.es < this.lastEs) this.ordered = false;
      this.pending.push(record);
      this.lastSs = record.ss; this.lastEs = record.es;
      this.byteReservation += 40 + record.texts.reduce((bytes, text) => bytes + 2 + text.length * 2, 0);
    }
    if (this.pending.length >= 1024) this.flushPending();
  }

  clear(): void {
    this.pages = []; this.count = 0; this.pending = []; this.ordered = true;
    this.lastSs = -1n; this.lastEs = -1n; this.maximumEnd = -1n; this.byteReservation = 0;
    this.textPool.length = 0; this.textIds.clear();
  }

  async prepareView(_start: SampleInput, _end: SampleInput, _maxResults: number): Promise<void> {}

  query(startInput: SampleInput, endInput: SampleInput, maxResults = Number.MAX_SAFE_INTEGER): Annotation[] {
    if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new RangeError('maxResults must be a positive safe integer');
    const start = samplePosition(startInput), end = samplePosition(endInput);
    this.flushPending();
    if (!this.ordered) this.rebuildOrdered();
    let low = this.lowerBoundEnd(start), after = this.upperBoundStart(end);
    if (after < low) after = low;
    const count = after - low, stride = count > maxResults ? count / maxResults : 1;
    const out: Annotation[] = [];
    for (let bucket = 0; bucket < Math.min(count, maxResults); bucket++) {
      const index = low + (count > maxResults ? Math.floor((bucket + .5) * stride) : bucket);
      const record = this.recordAt(index);
      if (record.es >= start) out.push(record);
    }
    return out;
  }

  private flushPending(): void {
    if (!this.pending.length) return;
    const pending = this.pending; this.pending = [];
    for (const record of pending) this.write(record);
  }

  private write(record: Annotation): void {
    const index = this.count++, pageIndex = Math.floor(index / PAGE_SIZE), offset = index % PAGE_SIZE;
    let page = this.pages[pageIndex];
    if (!page) page = this.pages[pageIndex] = emptyPage(record.ss);
    const end = maxSample(this.maximumEnd, record.es); this.maximumEnd = end;
    this.writePosition(page, offset, 'ss', record.ss);
    this.writePosition(page, offset, 'es', record.es);
    this.writePosition(page, offset, 'end', end);
    page.classes[offset] = record.classIndex & 0xff;
    page.textIds[offset] = this.textId(record.texts);
    if (record.value !== undefined) { page.values[offset] = record.value; page.hasValue[offset] = 1; }
  }

  private writePosition(page: AnnotationPage, offset: number, kind: 'ss' | 'es' | 'end', value: bigint): void {
    const relative = value - page.base;
    const lo = kind === 'ss' ? page.ssLo : kind === 'es' ? page.esLo : page.endLo;
    const hi = kind === 'ss' ? page.ssHi : kind === 'es' ? page.esHi : page.endHi;
    const wide = kind === 'ss' ? page.wideSs : kind === 'es' ? page.wideEs : page.wideEnd;
    if (relative < 0n || relative > MAX_OFFSET) { wide.set(offset, value); return; }
    lo[offset] = low32(relative); hi[offset] = high32(relative);
  }

  private textId(texts: readonly string[]): number {
    const key = JSON.stringify(texts), existing = this.textIds.get(key);
    if (existing !== undefined) return existing;
    const id = this.textPool.length; this.textPool.push(texts); this.textIds.set(key, id); return id;
  }

  private part(index: number, kind: 'ss' | 'es' | 'end'): bigint {
    const page = this.pages[Math.floor(index / PAGE_SIZE)]!, offset = index % PAGE_SIZE;
    const wide = kind === 'ss' ? page.wideSs : kind === 'es' ? page.wideEs : page.wideEnd;
    const value = wide.get(offset);
    if (value !== undefined) return value;
    const lo = kind === 'ss' ? page.ssLo : kind === 'es' ? page.esLo : page.endLo;
    const hi = kind === 'ss' ? page.ssHi : kind === 'es' ? page.esHi : page.endHi;
    return page.base + fromParts(hi[offset]!, lo[offset]!);
  }

  private recordAt(index: number): Annotation {
    const page = this.pages[Math.floor(index / PAGE_SIZE)]!, offset = index % PAGE_SIZE;
    const record: Annotation = {
      ss: this.part(index, 'ss'),
      es: this.part(index, 'es'),
      classIndex: page.classes[offset]!,
      texts: this.textPool[page.textIds[offset]!]!,
    };
    if (page.hasValue[offset]) record.value = page.values[offset]!;
    return record;
  }

  private lowerBoundEnd(value: bigint): number {
    let low = 0, high = this.count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.part(mid, 'end') < value) low = mid + 1; else high = mid;
    }
    return low;
  }

  private upperBoundStart(value: bigint): number {
    let low = 0, high = this.count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.part(mid, 'ss') <= value) low = mid + 1; else high = mid;
    }
    return low;
  }

  private rebuildOrdered(): void {
    const records: Annotation[] = [];
    for (let index = 0; index < this.count; index++) records.push(this.recordAt(index));
    records.sort((a, b) => compareSamples(a.ss, b.ss) || compareSamples(a.es, b.es));
    const bytes = this.byteReservation;
    this.pages = [];
    this.count = 0;
    this.maximumEnd = -1n;
    this.ordered = true;
    this.lastSs = -1n;
    this.lastEs = -1n;
    for (const record of records) { this.lastSs = record.ss; this.lastEs = record.es; this.write(record); }
    this.byteReservation = bytes;
  }
}
