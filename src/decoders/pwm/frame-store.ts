import { sampleRatio } from '../../libhakei/sample-index.js';
import type { Annotation, DecodeFrame } from '../definition.js';
import { formatPWMDuty, formatPWMFrequency, formatPWMPeriod } from './format.js';

const PAGE_SIZE = 65_536;
const UINT32_MAX = 0xffff_ffffn;
type Position = number | bigint;
type PositionArray = Uint32Array | BigUint64Array;
type PositionPage = {
  base: bigint;
  baseNumber: number;
  count: number;
  starts: PositionArray;
  active: PositionArray;
  periods: PositionArray;
  averages: Float64Array;
};
export interface PWMFrame extends DecodeFrame {
  activeSamples: bigint;
  periodSamples: bigint;
  dutyCycle: number;
  periodSeconds: number;
  frequencyHz: number;
  averageDutyCycle: number;
}

export class PWMFrameStore {
  private readonly pages: PositionPage[] = [];
  private count = 0;
  private sampleRate = 1;

  get length(): number {
    return this.count;
  }
  get rate(): number {
    return this.sampleRate;
  }
  get reservedBytes(): number {
    return this.pages.reduce(
      (sum, page) =>
        sum + page.starts.byteLength + page.active.byteLength + page.periods.byteLength + page.averages.byteLength,
      0,
    );
  }
  setRate(sampleRate: number): void {
    if (Number.isSafeInteger(sampleRate) && sampleRate > 0) this.sampleRate = sampleRate;
  }
  clear(): void {
    this.pages.length = 0;
    this.count = 0;
  }

  append(cycles: readonly Position[], averages: ArrayLike<number>): void {
    if (cycles.length % 3 !== 0 || averages.length !== cycles.length / 3)
      throw new RangeError('Invalid packed PWM page');
    if (!cycles.length) return;
    if (typeof cycles[0] === 'number') this.appendNumbers(cycles as readonly number[], averages);
    else this.appendBigints(cycles as readonly bigint[], averages);
  }

  private appendNumbers(cycles: readonly number[], averages: ArrayLike<number>): void {
    let page = this.pages.at(-1),
      pageCount = page?.count ?? 0;
    let lastStart = pageCount ? page!.baseNumber + Number(page!.starts[pageCount - 1]!) : 0;
    let big = page?.starts instanceof BigUint64Array,
      added = 0,
      averageIndex = 0;
    for (let index = 0; index < cycles.length; index += 3) {
      const ss = cycles[index]!,
        es = cycles[index + 1]!,
        active = cycles[index + 2]!,
        period = es - ss;
      if (
        !Number.isSafeInteger(ss) ||
        !Number.isSafeInteger(es) ||
        ss < 0 ||
        es <= ss ||
        !Number.isSafeInteger(active) ||
        active < 0 ||
        active > period
      )
        throw new RangeError('Invalid PWM cycle');
      if (!page || pageCount === PAGE_SIZE) {
        if (page) page.count = pageCount;
        page = {
          base: BigInt(ss),
          baseNumber: ss,
          count: 0,
          starts: new Uint32Array(PAGE_SIZE),
          active: new Uint32Array(PAGE_SIZE),
          periods: new Uint32Array(PAGE_SIZE),
          averages: new Float64Array(PAGE_SIZE),
        };
        this.pages.push(page);
        pageCount = 0;
        lastStart = ss;
        big = false;
      }
      const offset = ss - page.baseNumber;
      if (!Number.isSafeInteger(offset) || offset < 0 || (pageCount && ss < lastStart))
        throw new Error('PWM cycle positions are not ordered');
      if (offset > 0xffff_ffff || active > 0xffff_ffff || period > 0xffff_ffff) {
        this.promote(page, pageCount);
        big = true;
      }
      if (big) {
        page.starts[pageCount] = BigInt(offset);
        page.active[pageCount] = BigInt(active);
        page.periods[pageCount] = BigInt(period);
      } else {
        page.starts[pageCount] = offset;
        page.active[pageCount] = active;
        page.periods[pageCount] = period;
      }
      page.averages[pageCount] = Number(averages[averageIndex++]!);
      pageCount++;
      added++;
      lastStart = ss;
    }
    if (page) page.count = pageCount;
    this.count += added;
  }

  private appendBigints(cycles: readonly bigint[], averages: ArrayLike<number>): void {
    let page = this.pages.at(-1),
      pageCount = page?.count ?? 0;
    let lastStart = pageCount ? page!.base + BigInt(page!.starts[pageCount - 1]!) : 0n;
    let big = page?.starts instanceof BigUint64Array,
      added = 0,
      averageIndex = 0;
    for (let index = 0; index < cycles.length; index += 3) {
      const ss = cycles[index]!,
        es = cycles[index + 1]!,
        active = cycles[index + 2]!,
        period = es - ss;
      if (ss < 0n || es <= ss || active < 0n || active > period) throw new RangeError('Invalid PWM cycle');
      if (!page || pageCount === PAGE_SIZE) {
        if (page) page.count = pageCount;
        page = {
          base: ss,
          baseNumber: Number(ss),
          count: 0,
          starts: new Uint32Array(PAGE_SIZE),
          active: new Uint32Array(PAGE_SIZE),
          periods: new Uint32Array(PAGE_SIZE),
          averages: new Float64Array(PAGE_SIZE),
        };
        this.pages.push(page);
        pageCount = 0;
        lastStart = ss;
        big = false;
      }
      const offset = ss - page.base;
      if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PWM cycle offset is out of range');
      if (pageCount && ss < lastStart) throw new Error('PWM cycle positions are not ordered');
      if (offset > UINT32_MAX || active > UINT32_MAX || period > UINT32_MAX) {
        this.promote(page, pageCount);
        big = true;
      }
      if (big) {
        page.starts[pageCount] = offset;
        page.active[pageCount] = active;
        page.periods[pageCount] = period;
      } else {
        page.starts[pageCount] = Number(offset);
        page.active[pageCount] = Number(active);
        page.periods[pageCount] = Number(period);
      }
      page.averages[pageCount] = Number(averages[averageIndex++]!);
      pageCount++;
      added++;
      lastStart = ss;
    }
    if (page) page.count = pageCount;
    this.count += added;
  }

  queryAnnotations(start: bigint, end: bigint, maxResults: number, sampleRate = this.sampleRate): Annotation[] {
    if (
      start < 0n ||
      end < start ||
      !Number.isSafeInteger(maxResults) ||
      maxResults < 1 ||
      !Number.isSafeInteger(sampleRate) ||
      sampleRate < 1
    )
      throw new RangeError('Invalid PWM annotation query');
    const [first, after] = this.range(start, end),
      count = after - first;
    if (!count) return [];
    const limit = Math.max(1, Math.floor(maxResults / 3)),
      stride = count > limit ? count / limit : 1,
      output: Annotation[] = [];
    for (let bucket = 0; bucket < Math.min(count, limit); bucket++) {
      const index = first + (count > limit ? Math.floor((bucket + 0.5) * stride) : bucket),
        frame = this.frameAt(index, sampleRate);
      output.push(
        { ss: frame.ss, es: frame.es, classIndex: 0, texts: [formatPWMDuty(frame.dutyCycle)], value: frame.dutyCycle },
        {
          ss: frame.ss,
          es: frame.es,
          classIndex: 1,
          texts: [formatPWMPeriod(frame.periodSeconds)],
          value: frame.periodSeconds,
        },
        {
          ss: frame.ss,
          es: frame.es,
          classIndex: 2,
          texts: [formatPWMFrequency(frame.periodSeconds)],
          value: frame.frequencyHz,
        },
      );
    }
    return output;
  }

  readFrames(offset: number, count: number, sampleRate = this.sampleRate): PWMFrame[] {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      offset + count > this.count
    )
      throw new RangeError('Invalid PWM frame page');
    const frames = new Array<PWMFrame>(count);
    for (let index = 0; index < count; index++) frames[index] = this.frameAt(offset + index, sampleRate);
    return frames;
  }

  frameAt(index: number, sampleRate = this.sampleRate): PWMFrame {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count)
      throw new RangeError('Invalid PWM frame index');
    const page = this.pages[Math.floor(index / PAGE_SIZE)]!,
      offset = index % PAGE_SIZE,
      ss = page.base + BigInt(page.starts[offset]!);
    const activeSamples = BigInt(page.active[offset]!),
      periodSamples = BigInt(page.periods[offset]!),
      es = ss + periodSamples;
    return {
      ss,
      es,
      activeSamples,
      periodSamples,
      dutyCycle: sampleRatio(activeSamples, periodSamples) * 100,
      periodSeconds: Number(periodSamples) / sampleRate,
      frequencyHz: sampleRate / Number(periodSamples),
      averageDutyCycle: page.averages[offset]!,
    };
  }

  private positionAt(index: number): bigint {
    const page = this.pages[Math.floor(index / PAGE_SIZE)]!,
      offset = index % PAGE_SIZE;
    return page.base + BigInt(page.starts[offset]!);
  }
  private range(start: bigint, end: bigint): [number, number] {
    let low = 0,
      high = this.count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.positionAt(mid) < start) low = mid + 1;
      else high = mid;
    }
    let first = low;
    if (first > 0 && this.frameAt(first - 1).es >= start) first--;
    low = first;
    high = this.count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.positionAt(mid) <= end) low = mid + 1;
      else high = mid;
    }
    return [first, low];
  }
  private promote(page: PositionPage, count = page.count): void {
    if (page.starts instanceof BigUint64Array) return;
    const starts = new BigUint64Array(PAGE_SIZE),
      active = new BigUint64Array(PAGE_SIZE),
      periods = new BigUint64Array(PAGE_SIZE);
    for (let index = 0; index < count; index++) {
      starts[index] = BigInt(page.starts[index]!);
      active[index] = BigInt(page.active[index]!);
      periods[index] = BigInt(page.periods[index]!);
    }
    page.starts = starts;
    page.active = active;
    page.periods = periods;
  }
}
