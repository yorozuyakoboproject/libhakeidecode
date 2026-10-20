import { sampleRatio } from '../libhakei/sample-index.js';
import type { PackedPWMBatch } from './protocol.js';
import type { PWMOptions } from '../decoders/pwm.js';

export class PWMStreamDecoder {
  private readonly active: 0 | 1;
  private level: 0 | 1 | null = null;
  private activeStart: bigint | null = null;
  private activeEnd: bigint | null = null;
  private cycles: bigint[] = [];
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
    this.level = null; this.activeStart = null; this.activeEnd = null; this.totalDuty = 0; this.cycleCount = 0;
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
  private complete(ss: bigint, es: bigint, activeSamples: bigint): void {
    if (es <= ss || activeSamples < 0n) return;
    const periodSamples = es - ss, duty = sampleRatio(activeSamples, periodSamples);
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
