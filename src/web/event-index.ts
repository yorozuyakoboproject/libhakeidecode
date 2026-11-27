import { samplePosition, maxSample, compareSamples, type SampleInput } from '../libhakei/sample-index.js';
import type { Annotation } from './protocol.js';
import { SampleColumn } from './sample-column.js';

const PAGE_SIZE = 65_536;
const PENDING_FLUSH_SIZE = 4096;
const TAIL_SPLICE_LIMIT = 8192;
function textsCacheKey(texts: readonly string[]): string {
  return texts.length === 1 ? '\u0001' + texts[0]! : JSON.stringify(texts);
}
function compareAnnotation(a: Annotation, b: Annotation): number {
  return compareSamples(a.ss, b.ss) || compareSamples(a.es, b.es);
}
function comparePair(ssA: bigint, esA: bigint, ssB: bigint, esB: bigint): number {
  return compareSamples(ssA, ssB) || compareSamples(esA, esB);
}
function annotationBytes(record: Annotation): number {
  const texts = record.texts;
  if (texts.length === 1) return 42 + texts[0]!.length * 2;
  let bytes = 40;
  for (let i = 0; i < texts.length; i++) bytes += 2 + texts[i]!.length * 2;
  return bytes;
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
  private overflow: Annotation[] = [];
  private overflowMaxEnd: bigint[] = [];
  private overflowDirty = false;
  private overflowBytes = 0;
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
      this.overflowBytes +
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
    return this.count - this.head + this.overflow.length + this.pending.length;
  }

  sampleAtFraction(fraction: number): bigint | null {
    this.finalize();
    const total = this.count - this.head;
    if (total <= 0) {
      if (!this.overflow.length) return null;
      const idx = Math.min(this.overflow.length - 1, Math.max(0, Math.floor(this.overflow.length * fraction)));
      return this.overflow[idx]!.es;
    }
    const idx = this.head + Math.min(total - 1, Math.max(0, Math.floor(total * fraction)));
    return this.part(idx, 'es');
  }

  append(records: Annotation[]): void {
    for (const input of records) {
      const record: Annotation =
        typeof input.ss === 'bigint' && typeof input.es === 'bigint'
          ? input
          : { ...input, ss: samplePosition(input.ss), es: samplePosition(input.es) };
      this.pending.push(record);
      this.pendingBytes += annotationBytes(record);
    }
    if (this.pending.length >= PENDING_FLUSH_SIZE) this.flushPending();
  }

  clear(): void {
    this.pages = [];
    this.count = this.head = 0;
    this.pending = [];
    this.overflow = [];
    this.overflowMaxEnd = [];
    this.overflowDirty = false;
    this.overflowBytes = 0;
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
    if (this.head < this.count && this.part(this.head, 'end') <= start) {
      const after = this.lowerBoundEnd(start + 1n);
      this.releaseTextRange(this.head, after);
      this.head = after;
      while (this.head >= PAGE_SIZE) {
        this.pages.shift();
        this.head -= PAGE_SIZE;
        this.count -= PAGE_SIZE;
      }
      if (this.head === this.count) {
        this.pages = [];
        this.head = this.count = 0;
        this.lastSs = -1n;
        this.lastEs = -1n;
        this.maximumEnd = -1n;
      }
    }
    if (this.overflow.length && this.overflowMaxEnd[0]! <= start) {
      const cut = this.overflowLowerBoundEnd(start + 1n);
      if (cut > 0) {
        if (cut >= this.overflow.length) {
          this.overflow = [];
          this.overflowMaxEnd = [];
          this.overflowBytes = 0;
        } else {
          for (let i = 0; i < cut; i++) this.overflowBytes -= annotationBytes(this.overflow[i]!);
          this.overflow = this.overflow.slice(cut);
          this.overflowMaxEnd = this.overflowMaxEnd.slice(cut);
        }
      }
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
    const mainCount = after - low;

    if (!this.overflow.length) {
      return this.sampleMain(low, mainCount, start, maxResults);
    }

    let oLow = this.overflowLowerBoundEnd(start),
      oAfter = this.overflowUpperBoundStart(end);
    if (oAfter < oLow) oAfter = oLow;
    const overCount = oAfter - oLow;

    if (!overCount) return this.sampleMain(low, mainCount, start, maxResults);
    if (!mainCount) return this.sampleOverflow(oLow, overCount, start, maxResults);

    const total = mainCount + overCount;
    if (total <= maxResults) {
      const out: Annotation[] = [];
      let mi = low,
        oi = oLow;
      let mRec: Annotation | null = null;
      while (mi < after && oi < oAfter) {
        mRec ??= this.recordAt(mi);
        const oRec = this.overflow[oi]!;
        if (compareAnnotation(mRec, oRec) <= 0) {
          if (mRec.es >= start) out.push(mRec);
          mi++;
          mRec = null;
        } else {
          if (oRec.es >= start) out.push(oRec);
          oi++;
        }
      }
      while (mi < after) {
        mRec ??= this.recordAt(mi);
        if (mRec.es >= start) out.push(mRec);
        mi++;
        mRec = null;
      }
      while (oi < oAfter) {
        const oRec = this.overflow[oi++]!;
        if (oRec.es >= start) out.push(oRec);
      }
      return out;
    }

    const overCap = Math.max(1, Math.min(overCount, Math.round((maxResults * overCount) / total)));
    const mainCap = Math.max(1, maxResults - overCap);
    const merged = [
      ...this.sampleMain(low, mainCount, start, mainCap),
      ...this.sampleOverflow(oLow, overCount, start, overCap),
    ];
    merged.sort(compareAnnotation);
    return merged.length > maxResults ? merged.slice(0, maxResults) : merged;
  }

  private sampleMain(low: number, count: number, start: bigint, maxResults: number): Annotation[] {
    if (count <= 0) return [];
    const stride = count > maxResults ? count / maxResults : 1;
    const limit = Math.min(count, maxResults);
    const out: Annotation[] = [];
    for (let bucket = 0; bucket < limit; bucket++) {
      const index = low + (count > maxResults ? Math.floor((bucket + 0.5) * stride) : bucket);
      const record = this.recordAt(index);
      if (record.es >= start) out.push(record);
    }
    return out;
  }

  private sampleOverflow(low: number, count: number, start: bigint, maxResults: number): Annotation[] {
    if (count <= 0) return [];
    const stride = count > maxResults ? count / maxResults : 1;
    const limit = Math.min(count, maxResults);
    const out: Annotation[] = [];
    for (let bucket = 0; bucket < limit; bucket++) {
      const index = low + (count > maxResults ? Math.floor((bucket + 0.5) * stride) : bucket);
      const record = this.overflow[index]!;
      if (record.es >= start) out.push(record);
    }
    return out;
  }

  private releaseTextRange(from: number, to: number): void {
    for (let index = from; index < to; index++) {
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
  }

  private flushPending(): void {
    if (!this.pending.length) return;
    const pending = this.pending;
    this.pending = [];
    this.pendingBytes = 0;

    let sorted = true;
    for (let i = 1; i < pending.length; i++) {
      if (compareAnnotation(pending[i - 1]!, pending[i]!) > 0) {
        sorted = false;
        break;
      }
    }
    if (!sorted) pending.sort(compareAnnotation);

    const first = pending[0]!;
    if (this.count === this.head || comparePair(first.ss, first.es, this.lastSs, this.lastEs) >= 0) {
      for (let i = 0; i < pending.length; i++) this.write(pending[i]!);
      return;
    }

    const floorIndex = Math.max(this.head, this.count - TAIL_SPLICE_LIMIT);
    const floorSs = this.part(floorIndex, 'ss'),
      floorEs = this.part(floorIndex, 'es');
    let nearStart = 0;
    while (
      nearStart < pending.length &&
      comparePair(pending[nearStart]!.ss, pending[nearStart]!.es, floorSs, floorEs) < 0
    ) {
      const item = pending[nearStart++]!;
      this.overflow.push(item);
      this.overflowBytes += annotationBytes(item);
      this.overflowDirty = true;
    }
    if (nearStart >= pending.length) return;

    const firstNear = pending[nearStart]!;
    if (comparePair(firstNear.ss, firstNear.es, this.lastSs, this.lastEs) >= 0) {
      for (let i = nearStart; i < pending.length; i++) this.write(pending[i]!);
      return;
    }

    const spliceAt = this.lowerBoundPair(floorIndex, this.count, firstNear.ss, firstNear.es);
    const tailLen = this.count - spliceAt;
    const tail: Annotation[] = new Array(tailLen);
    for (let i = 0; i < tailLen; i++) tail[i] = this.recordAt(spliceAt + i);
    this.releaseTextRange(spliceAt, this.count);
    this.count = spliceAt;
    const neededPages = Math.ceil(this.count / PAGE_SIZE);
    if (this.pages.length > neededPages) this.pages.length = neededPages;
    if (this.count > this.head) {
      this.lastSs = this.part(this.count - 1, 'ss');
      this.lastEs = this.part(this.count - 1, 'es');
      this.maximumEnd = this.part(this.count - 1, 'end');
    } else {
      this.lastSs = -1n;
      this.lastEs = -1n;
      this.maximumEnd = -1n;
    }

    let ti = 0,
      pi = nearStart;
    while (ti < tailLen && pi < pending.length) {
      const tRec = tail[ti]!,
        pRec = pending[pi]!;
      if (compareAnnotation(tRec, pRec) <= 0) {
        this.write(tRec);
        ti++;
      } else {
        this.write(pRec);
        pi++;
      }
    }
    while (ti < tailLen) this.write(tail[ti++]!);
    while (pi < pending.length) this.write(pending[pi++]!);
  }

  private syncOverflow(): void {
    if (!this.overflowDirty) return;
    this.overflow.sort(compareAnnotation);
    this.overflowMaxEnd = new Array(this.overflow.length);
    let maxEnd = -1n;
    for (let i = 0; i < this.overflow.length; i++) {
      const es = this.overflow[i]!.es;
      if (es > maxEnd) maxEnd = es;
      this.overflowMaxEnd[i] = maxEnd;
    }
    this.overflowDirty = false;
  }

  finalize(): void {
    this.flushPending();
    this.syncOverflow();
  }

  private write(record: Annotation): void {
    const index = this.count++,
      pageIndex = Math.floor(index / PAGE_SIZE),
      offset = index % PAGE_SIZE;
    let page = this.pages[pageIndex];
    if (!page) page = this.pages[pageIndex] = emptyPage(record.ss);
    const end = maxSample(this.maximumEnd, record.es);
    this.maximumEnd = end;
    this.lastSs = record.ss;
    this.lastEs = record.es;
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
    } else if (page.hasValue) {
      page.hasValue[offset >>> 3] &= ~(1 << (offset & 7));
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

  private lowerBoundPair(lowStart: number, highEnd: number, ss: bigint, es: bigint): number {
    let low = lowStart,
      high = highEnd;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (comparePair(this.part(mid, 'ss'), this.part(mid, 'es'), ss, es) < 0) low = mid + 1;
      else high = mid;
    }
    return low;
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

  private overflowLowerBoundEnd(value: bigint): number {
    let low = 0,
      high = this.overflowMaxEnd.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.overflowMaxEnd[mid]! < value) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private overflowUpperBoundStart(value: bigint): number {
    let low = 0,
      high = this.overflow.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.overflow[mid]!.ss <= value) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}
