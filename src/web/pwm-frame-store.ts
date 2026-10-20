import { sampleRatio } from '../libhakei/sample-index.js';
import { formatPWMDuty, formatPWMPeriod, formatPWMFrequency } from '../decoders/pwm.js';
import type { Annotation, PWMFrame } from './protocol.js';

const PAGE_SIZE = 65_536;
const UINT32_MAX = 0xffff_ffffn;
type PositionArray = Uint32Array | BigUint64Array;
type PositionPage = {
  base: bigint;
  count: number;
  starts: PositionArray;
  active: PositionArray;
  periods: PositionArray;
  averages: Float64Array;
};

export class PWMFrameStore {
  private readonly pages: PositionPage[] = [];
  private count = 0;
  private sampleRate = 1;

  get length(): number { return this.count; }
  get rate(): number { return this.sampleRate; }
  get reservedBytes(): number { return this.pages.reduce((sum, page) => sum + page.starts.byteLength + page.active.byteLength + page.periods.byteLength + page.averages.byteLength, 0); }
  setRate(sampleRate: number): void { if (Number.isSafeInteger(sampleRate) && sampleRate > 0) this.sampleRate = sampleRate; }

  clear(): void { this.pages.length = 0; this.count = 0; }

  append(cycles: readonly bigint[], averages: ArrayLike<number>): void {
    if (cycles.length % 3 !== 0 || averages.length !== cycles.length / 3) throw new RangeError('Invalid packed PWM page');
    for (let index = 0; index < cycles.length; index += 3) {
      const ss = cycles[index]!, es = cycles[index + 1]!, active = cycles[index + 2]!, period = es - ss;
      if (ss < 0n || es <= ss || active < 0n || active > period) throw new RangeError('Invalid PWM cycle');
      let page = this.pages.at(-1);
      if (!page || page.count === PAGE_SIZE) {
        page = { base: ss, count: 0, starts: new Uint32Array(PAGE_SIZE), active: new Uint32Array(PAGE_SIZE), periods: new Uint32Array(PAGE_SIZE), averages: new Float64Array(PAGE_SIZE) };
        this.pages.push(page);
      }
      const offset = ss - page.base;
      if (offset < 0n || (page.count && ss < page.base + BigInt(page.starts[page.count - 1]!))) throw new Error('PWM cycle positions are not ordered');
      if (offset > UINT32_MAX || active > UINT32_MAX || period > UINT32_MAX) this.promote(page);
      page.starts[page.count] = page.starts instanceof BigUint64Array ? offset : Number(offset);
      page.active[page.count] = page.active instanceof BigUint64Array ? active : Number(active);
      page.periods[page.count] = page.periods instanceof BigUint64Array ? period : Number(period);
      page.averages[page.count] = Number(averages[index / 3]!);
      page.count++;
      this.count++;
    }
  }

  queryAnnotations(start: bigint, end: bigint, maxResults: number, sampleRate = this.sampleRate): Annotation[] {
    if (start < 0n || end < start || !Number.isSafeInteger(maxResults) || maxResults < 1 || !Number.isSafeInteger(sampleRate) || sampleRate < 1) throw new RangeError('Invalid PWM annotation query');
    const [first, after] = this.range(start, end);
    const count = after - first;
    if (!count) return [];
    const limit = Math.max(1, Math.floor(maxResults / 3));
    const stride = count > limit ? count / limit : 1;
    const output: Annotation[] = [];
    for (let bucket = 0; bucket < Math.min(count, limit); bucket++) {
      const index = first + (count > limit ? Math.floor((bucket + .5) * stride) : bucket);
      const frame = this.frameAt(index, sampleRate), duty = frame.dutyCycle, period = frame.periodSeconds;
      output.push(
        { ss: frame.ss, es: frame.es, classIndex: 0, texts: [formatPWMDuty(duty)], value: duty },
        { ss: frame.ss, es: frame.es, classIndex: 1, texts: [formatPWMPeriod(period)], value: period },
        { ss: frame.ss, es: frame.es, classIndex: 2, texts: [formatPWMFrequency(period)], value: frame.frequencyHz },
      );
    }
    return output;
  }

  readFrames(offset: number, count: number, sampleRate = this.sampleRate): PWMFrame[] {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 0 || offset + count > this.count) throw new RangeError('Invalid PWM frame page');
    const frames = new Array<PWMFrame>(count);
    for (let index = 0; index < count; index++) frames[index] = this.frameAt(offset + index, sampleRate);
    return frames;
  }

  frameAt(index: number, sampleRate = this.sampleRate): PWMFrame {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) throw new RangeError('Invalid PWM frame index');
    const page = this.pages[Math.floor(index / PAGE_SIZE)]!, offset = index % PAGE_SIZE;
    const ss = page.base + BigInt(page.starts[offset]!);
    const activeSamples = BigInt(page.active[offset]!);
    const periodSamples = BigInt(page.periods[offset]!);
    const es = ss + periodSamples, periodSeconds = Number(periodSamples) / sampleRate;
    return { protocol: 'pwm', ss, es, activeSamples, periodSamples, dutyCycle: sampleRatio(activeSamples, periodSamples) * 100,
      periodSeconds, frequencyHz: sampleRate / Number(periodSamples), averageDutyCycle: page.averages[offset]! };
  }

  private positionAt(index: number): bigint {
    const page = this.pages[Math.floor(index / PAGE_SIZE)]!, offset = index % PAGE_SIZE;
    return page.base + BigInt(page.starts[offset]!);
  }

  private range(start: bigint, end: bigint): [number, number] {
    let low = 0, high = this.count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.positionAt(mid) < start) low = mid + 1; else high = mid;
    }
    let first = low;
    if (first > 0 && this.frameAt(first - 1).es >= start) first--;
    low = first; high = this.count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.positionAt(mid) <= end) low = mid + 1; else high = mid;
    }
    return [first, low];
  }

  private promote(page: PositionPage): void {
    if (page.starts instanceof BigUint64Array) return;
    const starts = new BigUint64Array(PAGE_SIZE), active = new BigUint64Array(PAGE_SIZE), periods = new BigUint64Array(PAGE_SIZE);
    for (let index = 0; index < page.count; index++) { starts[index] = BigInt(page.starts[index]!); active[index] = BigInt(page.active[index]!); periods[index] = BigInt(page.periods[index]!); }
    page.starts = starts; page.active = active; page.periods = periods;
  }
}
