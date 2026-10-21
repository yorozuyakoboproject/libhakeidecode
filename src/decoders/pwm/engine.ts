import { DecodeError } from '../../libhakeidecode/errors.js';
import type { DecoderEngine, DecoderEngineContext, DecoderEngineContext as Context, LogicLevel, LogicWindow, SignalWindow } from '../../libhakeidecode/index.js';
import type { PWMOptions } from './index.js';

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const FLUSH_CYCLES = 4096;

export type PWMPosition = number | bigint;
export interface PWMScanBatch {
  cycles: PWMPosition[];
  averages: Float64Array;
  raw: Uint8Array;
}

export class PWMScanEngine implements DecoderEngine<PWMScanBatch> {
  private readonly active: 0 | 1;
  private readonly sink: Context<PWMOptions, PWMScanBatch>['sink'];
  private level: 0 | 1 | null = null;
  private activeStart: bigint | null = null;
  private activeEnd: bigint | null = null;
  private fastStart: number | null = null;
  private fastEnd: number | null = null;
  private cycles: PWMPosition[] = [];
  private averages: number[] = [];
  private rawValues: number[] = [];
  private totalDuty = 0;
  private cycleCount = 0;
  private frameCount = 0;
  constructor(context: DecoderEngineContext<PWMOptions, PWMScanBatch>) {
    if (!(context.sampleRate > 0)) throw new DecodeError('Cannot decode without samplerate.');
    this.active = context.options.polarity === 'active-low' ? 0 : 1;
    this.sink = context.sink;
  }
  get frames(): number { return this.frameCount; }
  get averageDuty(): number | null { return this.cycleCount ? this.totalDuty / this.cycleCount : null; }
  async push(window: SignalWindow): Promise<void> {
    const view = window.channel('data');
    if (!view) throw new DecodeError('PWM requires a data channel.');
    if (view.kind === 'packed' && view.data) await this.pushPacked(window.startSample, view.data as Uint8Array, view.bit ?? 0);
    else if (view.kind === 'edges') await this.pushEdges(window.startSample, view.initial ?? 0, view.edges ?? []);
    else await this.pushValues(window, view);
    await this.flush();
  }
  private async pushPacked(startSample: bigint, data: Uint8Array, bit: number): Promise<void> {
    if (!data.length) return;
    if (!Number.isInteger(bit) || bit < 0 || bit > 7) throw new RangeError('Invalid packed PWM channel bit');
    if (startSample < 0n || startSample + BigInt(data.length) > BigInt(Number.MAX_SAFE_INTEGER)) {
      await this.pushPackedBigint(startSample, data, bit); return;
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
            const changeBit = 31 - Math.clz32(changes & -changes);
            this.transitionNumber(wordPosition + (changeBit >>> 3));
            changes &= changes - 1;
          }
          this.level = ((bits >>> 24) & 1) as 0 | 1;
          if (this.cycles.length >= 3 * FLUSH_CYCLES) { const pending = this.flush(); if (pending) await pending; }
        }
        offset += wordCount * 4;
      }
    }
    while (offset < data.length) {
      const next = ((data[offset]! >>> bit) & 1) as 0 | 1;
      if (next !== this.level) this.transitionNumber(start + offset);
      this.level = next; offset++;
      if (this.cycles.length >= 3 * FLUSH_CYCLES) { const pending = this.flush(); if (pending) await pending; }
    }
  }
  private async pushPackedBigint(startSample: bigint, data: Uint8Array, bit: number): Promise<void> {
    this.promoteFast();
    let offset = 0;
    if (this.level === null) { this.level = ((data[0]! >>> bit) & 1) as 0 | 1; offset = 1; }
    let level = this.level;
    for (; offset < data.length; offset++) {
      const next = ((data[offset]! >>> bit) & 1) as 0 | 1;
      if (next === level) continue;
      level = next; this.level = level;
      this.transition(startSample + BigInt(offset));
      if (this.cycles.length >= 3 * FLUSH_CYCLES) { const pending = this.flush(); if (pending) await pending; }
    }
    this.level = level;
  }
  private async pushValues(window: SignalWindow, view: LogicWindow): Promise<void> {
    if (!view.length) return;
    let offset = 0;
    if (this.level === null) { this.level = view.at(0) as 0 | 1; offset = 1; }
    if (offset === 0) {
      const next = view.at(0) as 0 | 1;
      if (next !== this.level) await this.transitionAt(window.startSample, 0);
      this.level = next; offset = 1;
    }
    for (; offset < view.length; offset++) {
      const next = view.at(offset) as 0 | 1;
      if (next === this.level) continue;
      await this.transitionAt(window.startSample, offset);
      this.level = next;
      if (this.cycles.length >= 3 * FLUSH_CYCLES) { const pending = this.flush(); if (pending) await pending; }
    }
  }
  private async transitionAt(startSample: bigint, offset: number): Promise<void> {
    if (startSample + BigInt(offset) <= BigInt(Number.MAX_SAFE_INTEGER)) this.transitionNumber(Number(startSample) + offset);
    else { this.promoteFast(); this.transition(startSample + BigInt(offset)); }
  }
  private async pushEdges(startSample: bigint, initial: LogicLevel, edges: readonly (number | bigint)[]): Promise<void> {
    const fresh = this.level === null;
    if (fresh) this.level = initial;
    for (const edge of edges) {
      const position = typeof edge === 'bigint' ? edge : BigInt(edge);
      if (position < startSample || fresh && position === startSample) continue;
      this.promoteFast();
      this.transition(position);
      if (this.cycles.length >= 3 * FLUSH_CYCLES) { const pending = this.flush(); if (pending) await pending; }
    }
  }
  flush(): void | Promise<void> {
    if (!this.cycles.length) return;
    const batch: PWMScanBatch = { cycles: this.cycles, averages: Float64Array.from(this.averages), raw: Uint8Array.from(this.rawValues) };
    this.cycles = []; this.averages = []; this.rawValues = [];
    return this.sink.write(batch);
  }
  async finish(): Promise<void> { const pending = this.flush(); if (pending) await pending; }
  reset(): void {
    this.level = null; this.activeStart = null; this.activeEnd = null; this.fastStart = null; this.fastEnd = null;
    this.totalDuty = 0; this.cycleCount = 0;
  }
  cancel(): void { this.reset(); }
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
    this.totalDuty += duty * 100; this.cycleCount++;
    this.cycles.push(ss, es, activeSamples);
    this.averages.push(this.totalDuty / this.cycleCount);
    this.rawValues.push(Math.trunc(duty * 256));
    this.frameCount++;
  }
}

export function createPWMScanEngine(context: DecoderEngineContext<PWMOptions, PWMScanBatch>): PWMScanEngine {
  return new PWMScanEngine(context);
}
