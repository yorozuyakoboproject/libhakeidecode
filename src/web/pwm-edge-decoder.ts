import type { PackedPWMBatch, PWMPosition } from './protocol.js';
import type { PWMOptions } from '../decoders/pwm.js';

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export class PWMStreamDecoder {
  private readonly active: 0 | 1;
  private level: 0 | 1 | null = null;
  private activeStart: bigint | null = null;
  private activeEnd: bigint | null = null;
  private fastStart: number | null = null;
  private fastEnd: number | null = null;
  private cycles: PWMPosition[] = [];
  private averages: number[] = [];
  private batchAnnotations = 0;
  private cycleCount = 0;
  private totalDuty = 0;
  private frameCount = 0;
  private annotationCount = 0;
  private rawPages: Uint8Array[] = [];
  private rawLength = 0;
  private rawOffset = 0;
  get rawBytes(): number { return this.rawLength; }
  private truncated = false;
  private binaryTruncated = false;
  constructor(sampleRate: number, options: Partial<PWMOptions>, private readonly emit: (message: PackedPWMBatch, transfer?: Transferable[]) => void | Promise<void>) {
    if (!(sampleRate > 0)) throw new Error('Cannot decode without samplerate.');
    this.active = options.polarity === 'active-low' ? 0 : 1;
  }
  async push(startSample: bigint, data: Uint8Array, progress: number): Promise<void> {
    if (!data.length) return;
    if (this.level === null) { this.level = data[0]! as 0 | 1; await this.scan(startSample, data, 1, progress); }
    else await this.scan(startSample, data, 0, progress);
    await this.flushIfFull(progress);
  }
  async pushPacked(startSample: bigint, data: Uint8Array, bit: number, progress: number): Promise<void> {
    if (!data.length) return;
    if (!Number.isInteger(bit) || bit < 0 || bit > 7) throw new RangeError('Invalid packed PWM channel bit');
    if (startSample < 0n || startSample + BigInt(data.length) > BigInt(Number.MAX_SAFE_INTEGER)) {
      await this.pushPackedBigint(startSample, data, bit, progress); return;
    }
    const start = Number(startSample);
    let offset = 0;
    if (this.level === null) { this.level = ((data[0]! >>> bit) & 1) as 0 | 1; offset = 1; }
    if (offset === 0) {
      const next = ((data[0]! >>> bit) & 1) as 0 | 1;
      if (next !== this.level) this.transitionNumber(start);
      this.level = next; offset = 1;
    }
    while (offset < data.length && ((data.byteOffset + offset) & 3) !== 0) {
      const next = ((data[offset]! >>> bit) & 1) as 0 | 1;
      if (next !== this.level) this.transitionNumber(start + offset);
      this.level = next; offset++;
    }
    if (LITTLE_ENDIAN) {
      const wordCount = (data.length - offset) >>> 2;
      if (wordCount) {
        const words = new Uint32Array(data.buffer, data.byteOffset + offset, wordCount);
        for (let index = 0; index < wordCount; index++) {
          const value = words[index]!, bits = (value >>> bit) & 0x01010101;
          const wordPosition = start + offset + index * 4;
          if ((bits & 1) !== this.level) this.transitionNumber(wordPosition);
          let changes = (bits ^ (bits << 8)) & 0x01010100;
          while (changes) {
            const changeBit = 31 - Math.clz32(changes);
            this.transitionNumber(wordPosition + (changeBit >>> 3));
            changes &= ~(1 << changeBit);
          }
          this.level = ((bits >>> 24) & 1) as 0 | 1;
        }
        offset += wordCount * 4;
      }
    }
    while (offset < data.length) {
      const next = ((data[offset]! >>> bit) & 1) as 0 | 1;
      if (next !== this.level) this.transitionNumber(start + offset);
      this.level = next; offset++;
    }
    await this.flush(progress);
  }
  private async pushPackedBigint(startSample: bigint, data: Uint8Array, bit: number, progress: number): Promise<void> {
    this.promoteFast();
    let offset = 0;
    if (this.level === null) { this.level = ((data[0]! >>> bit) & 1) as 0 | 1; offset = 1; }
    let level = this.level;
    for (; offset < data.length; offset++) {
      const next = ((data[offset]! >>> bit) & 1) as 0 | 1;
      if (next === level) continue;
      level = next; this.level = level;
      this.transition(startSample + BigInt(offset));
      if (this.cycles.length >= 3 * 128) await this.flush(progress);
    }
    this.level = level;
    await this.flush(progress);
  }
  async pushEdges(startSample: bigint, initial: 0 | 1, edges: readonly bigint[], progress: number): Promise<void> {
    const fresh = this.level === null;
    if (fresh) this.level = initial;
    for (const position of edges) {
      if (position < startSample || fresh && position === startSample) continue;
      this.transition(position);
      if (this.cycles.length >= 3 * 128) await this.flush(progress);
    }
    await this.flushIfFull(progress);
  }
  reset(): void {
    this.level = null; this.activeStart = null; this.activeEnd = null; this.fastStart = null; this.fastEnd = null;
    this.totalDuty = 0; this.cycleCount = 0;
  }
  private async scan(startSample: bigint, data: Uint8Array, first: number, progress: number): Promise<void> {
    let level = this.level!;
    for (let offset = first; offset < data.length; offset++) {
      const next = data[offset]! as 0 | 1;
      if (next === level) continue;
      level = next;
      const position = startSample + BigInt(offset);
      this.transition(position);
      if (this.cycles.length >= 3 * 128) await this.flush(progress);
    }
    this.level = level;
  }
  private transition(position: bigint): void {
    const level = this.level! ^ 1;
    this.level = level as 0 | 1;
    if (level === this.active) {
      if (this.activeStart !== null && this.activeEnd !== null) this.complete(this.activeStart, position, this.activeEnd - this.activeStart);
      this.activeStart = position; this.activeEnd = null;
    } else if (this.activeStart !== null) this.activeEnd = position;
  }
  private transitionNumber(position: number): void {
    const level = this.level! ^ 1;
    this.level = level as 0 | 1;
    if (level === this.active) {
      if (this.fastStart !== null && this.fastEnd !== null) this.completeNumber(this.fastStart, position, this.fastEnd - this.fastStart);
      this.fastStart = position; this.fastEnd = null;
    } else if (this.fastStart !== null) this.fastEnd = position;
  }
  private promoteFast(): void {
    if (this.fastStart !== null) this.activeStart = BigInt(this.fastStart);
    if (this.fastEnd !== null) this.activeEnd = BigInt(this.fastEnd);
    this.fastStart = null; this.fastEnd = null;
  }
  private complete(ss: bigint, es: bigint, activeSamples: bigint): void {
    if (es <= ss || activeSamples < 0n) return;
    const periodSamples = es - ss, duty = Number(activeSamples) / Number(periodSamples);
    this.recordCycle(ss, es, activeSamples, duty);
  }
  private completeNumber(ss: number, es: number, activeSamples: number): void {
    if (es <= ss || activeSamples < 0) return;
    const periodSamples = es - ss, duty = activeSamples / periodSamples;
    this.recordCycle(ss, es, activeSamples, duty);
  }
  private recordCycle(ss: PWMPosition, es: PWMPosition, activeSamples: PWMPosition, duty: number): void {
    this.totalDuty += duty * 100; this.cycleCount++; const average = this.totalDuty / this.cycleCount;
    this.pushRaw(Math.trunc(duty * 256));
    this.cycles.push(ss, es, activeSamples); this.averages.push(average); this.frameCount++;
    this.batchAnnotations += 3; this.annotationCount += 3;
  }
  private pushRaw(value: number): void {
    let page = this.rawPages.at(-1);
    if (!page || this.rawOffset === page.length) { page = new Uint8Array(65_536); this.rawPages.push(page); this.rawOffset = 0; }
    page[this.rawOffset++] = value & 0xff; this.rawLength++;
  }
  private async flushIfFull(progress: number): Promise<void> { if (this.cycles.length >= 3 * 128) await this.flush(progress); }
  async flush(progress: number): Promise<void> {
    if (!this.cycles.length && !this.batchAnnotations) return;
    const averages = Float64Array.from(this.averages);
    await this.emit({ type: 'pwm-batch', progress, cycles: this.cycles, averages, annotations: this.batchAnnotations }, [averages.buffer]);
    this.cycles = []; this.averages = []; this.batchAnnotations = 0;
  }
  result(): { rx: Uint8Array; tx: Uint8Array; pwm: Uint8Array; pwmAverage: number | null; frames: number; annotations: number; truncated: boolean; binaryTruncated: boolean } {
    const raw = new Uint8Array(this.rawLength); let offset = 0;
    for (const page of this.rawPages) { const length = Math.min(page.length, this.rawLength - offset); raw.set(page.subarray(0, length), offset); offset += length; if (offset === this.rawLength) break; }
    return { rx: new Uint8Array(), tx: new Uint8Array(), pwm: raw, pwmAverage: this.cycleCount ? this.totalDuty / this.cycleCount : null,
      frames: this.frameCount, annotations: this.annotationCount, truncated: this.truncated, binaryTruncated: this.binaryTruncated };
  }
}
