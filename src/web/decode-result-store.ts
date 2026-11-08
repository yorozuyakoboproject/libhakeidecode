import { resultMemory } from '../decoders/definition.js';
import type { DecodeBatch, DecodeFrame, DecodeResultMemory } from '../decoders/definition.js';
import { AnnotationIndex } from './event-index.js';
import { SampleColumn } from './sample-column.js';

const PAGE_SIZE = 4096;

function valueBytes(value: unknown, seen = new Set<unknown>()): number {
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'bigint') return Math.ceil(value.toString(16).length / 2);
  if (value === null || typeof value !== 'object' || seen.has(value)) return 8;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return valueBytes(value.buffer, seen);
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return value.byteLength;
  if (value instanceof Map)
    return [...value].reduce((sum, [key, item]) => sum + valueBytes(key, seen) + valueBytes(item, seen), 0);
  if (value instanceof Set) return [...value].reduce((sum, item) => sum + valueBytes(item, seen), 0);
  return Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + valueBytes(item, seen), 0);
}

class FrameColumn {
  private readonly tags = new Uint8Array(PAGE_SIZE);
  private numbers: Float64Array | null = null;
  private readonly other = new Map<number, unknown>();
  private otherBytes = 0;

  get reservedBytes(): number {
    return this.tags.byteLength + (this.numbers?.byteLength ?? 0) + this.otherBytes;
  }

  set(index: number, value: unknown): void {
    if (typeof value === 'number') {
      this.numbers ??= new Float64Array(PAGE_SIZE);
      this.numbers[index] = value;
      this.tags[index] = 1;
    } else if (value === true) this.tags[index] = 2;
    else if (value === false) this.tags[index] = 3;
    else if (value === null) this.tags[index] = 4;
    else if (value === undefined) this.tags[index] = 5;
    else {
      this.tags[index] = 6;
      this.other.set(index, value);
      this.otherBytes += 4 + valueBytes(value);
    }
  }

  has(index: number): boolean {
    return this.tags[index] !== 0;
  }

  get(index: number): unknown {
    switch (this.tags[index]) {
      case 1:
        return this.numbers![index];
      case 2:
        return true;
      case 3:
        return false;
      case 4:
        return null;
      case 5:
        return undefined;
      case 6:
        return this.other.get(index);
      default:
        return undefined;
    }
  }
}

type FramePage = { starts: SampleColumn; ends: SampleColumn; columns: Map<string, FrameColumn> };

export class DecodeResultStore {
  readonly annotations = new AnnotationIndex();
  private readonly pages: FramePage[] = [];
  private frameCount = 0;
  private head = 0;
  private lastFrame: DecodeFrame | null = null;
  private ordered = true;
  private binaries: Record<string, Uint8Array> = {};
  private binaryBytes = 0;

  constructor(private readonly compare: (a: DecodeFrame, b: DecodeFrame) => number) {}

  get length(): number {
    return this.frameCount - this.head;
  }
  discardBefore(start: bigint): { frames: number; annotations: number } {
    this.annotations.discardBefore(start);
    while (this.head < this.frameCount) {
      const page = this.pages[Math.floor(this.head / PAGE_SIZE)]!;
      if (page.ends.get(this.head % PAGE_SIZE) > start) break;
      this.head++;
    }
    while (this.head >= PAGE_SIZE) {
      this.pages.shift();
      this.head -= PAGE_SIZE;
      this.frameCount -= PAGE_SIZE;
    }
    return { frames: this.length, annotations: this.annotations.length };
  }
  append(batch: DecodeBatch): void {
    this.annotations.append(batch.annotations);
    for (const frame of batch.frames) this.appendFrame(frame);
  }

  private appendFrame(frame: DecodeFrame): void {
    if (this.lastFrame && this.compare(this.lastFrame, frame) > 0) this.ordered = false;
    this.lastFrame = frame;
    const index = this.frameCount++,
      pageIndex = Math.floor(index / PAGE_SIZE),
      offset = index % PAGE_SIZE;
    let page = this.pages[pageIndex];
    if (!page)
      page = this.pages[pageIndex] = {
        starts: new SampleColumn(frame.ss, PAGE_SIZE),
        ends: new SampleColumn(frame.ss, PAGE_SIZE),
        columns: new Map(),
      };
    page.starts.set(offset, frame.ss);
    page.ends.set(offset, frame.es);
    for (const [key, value] of Object.entries(frame)) {
      if (key === 'ss' || key === 'es') continue;
      let column = page.columns.get(key);
      if (!column) page.columns.set(key, (column = new FrameColumn()));
      column.set(offset, value);
    }
  }

  readFrames(offset: number, count: number): DecodeFrame[] {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 0)
      throw new RangeError('Invalid frame page');
    const frames: DecodeFrame[] = [];
    for (let index = this.head + offset; index < Math.min(this.frameCount, this.head + offset + count); index++) {
      const page = this.pages[Math.floor(index / PAGE_SIZE)]!,
        local = index % PAGE_SIZE;
      const frame = { ss: page.starts.get(local), es: page.ends.get(local) } as DecodeFrame & Record<string, unknown>;
      for (const [key, column] of page.columns) {
        if (!column.has(local)) continue;
        if (key === '__proto__')
          Object.defineProperty(frame, key, {
            value: column.get(local),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        else frame[key] = column.get(local);
      }
      frames.push(frame);
    }
    return frames;
  }

  finish(binaries: Record<string, Uint8Array>): void {
    if (!this.ordered) {
      const frames = this.readFrames(0, this.length).sort(this.compare);
      this.pages.length = 0;
      this.frameCount = this.head = 0;
      this.lastFrame = null;
      this.ordered = true;
      for (const frame of frames) this.appendFrame(frame);
    }
    this.lastFrame = null;
    this.annotations.finalize();
    this.binaries = binaries;
    this.binaryBytes = [...new Set(Object.values(binaries).map((data) => data.buffer))].reduce(
      (sum, buffer) => sum + buffer.byteLength,
      0,
    );
  }

  readBinary(key: string): Blob | null {
    if (!Object.hasOwn(this.binaries, key)) return null;
    const data = this.binaries[key]!;
    const bytes =
      data.buffer instanceof ArrayBuffer
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    return new Blob([bytes], { type: 'application/octet-stream' });
  }

  memory(runtime: DecodeResultMemory): DecodeResultMemory {
    const framesBytes = this.pages.reduce(
      (sum, page) =>
        sum +
        page.starts.reservedBytes +
        page.ends.reservedBytes +
        [...page.columns.values()].reduce((bytes, column) => bytes + column.reservedBytes, 0),
      0,
    );
    return resultMemory(
      this.annotations.reservedBytes + runtime.annotationsBytes,
      framesBytes + runtime.framesBytes,
      this.binaryBytes + runtime.binaryBytes,
    );
  }
}
