import { createPWMBatchReader } from './batch.js';
import { createPWMScanEngine } from './engine.js';
import type { PWMScanBatch } from './engine.js';
import { PWMFrameStore } from './frame-store.js';
import type { PWMFrame } from './frame-store.js';
import type { PWMOptions } from './index.js';
import type { Annotation, DecodeFrame, DecodeRuntime, DecodeRuntimeContext, DecodeRuntimeResult } from '../definition.js';

class PWMRuntime implements DecodeRuntime {
  private readonly host: DecodeRuntimeContext['host'];
  private readonly store = new PWMFrameStore();
  private readonly engine;
  private readonly reader;
  private readonly pagedRequested: boolean;
  private readonly pagedAutomatic: boolean;
  private paged = false;
  private progress = 0;
  private rawPages: Uint8Array[] = [];
  private rawLength = 0;
  private rawOffset = 0;
  constructor(context: DecodeRuntimeContext) {
    this.host = context.host;
    this.store.setRate(context.sampleRate);
    this.reader = createPWMBatchReader(context.sampleRate);
    this.pagedRequested = context.paged === 'always';
    this.pagedAutomatic = context.paged === 'auto';
    this.engine = createPWMScanEngine({
      sampleRate: context.sampleRate, options: context.options as unknown as PWMOptions, channels: { data: 'data' }, instanceId: 'pwm-ui',
      sink: { write: (batch: PWMScanBatch) => this.consume(batch) },
    });
  }
  get frameCount(): number { return this.store.length; }
  get annotationCount(): number { return this.store.length * 3; }
  get resultBytes(): number { return this.store.reservedBytes + this.rawLength; }
  async push(window: Parameters<DecodeRuntime['push']>[0], progress: number): Promise<void> { this.progress = progress; await this.engine.push(window); }
  async flush(): Promise<void> { const pending = this.engine.flush(); if (pending) await pending; }
  reset(): void { this.engine.reset(); }
  async finish(progress: number): Promise<DecodeRuntimeResult> {
    this.progress = progress; await this.engine.flush();
    const raw = this.raw(), averageDutyCycle = this.engine.averageDuty, frames = this.engine.frames, annotations = frames * 3;
    if (!this.paged) this.store.clear();
    return { binaries: { raw }, values: { averageDutyCycle }, frames, annotations, truncated: false, binaryTruncated: false };
  }
  queryAnnotations(start: bigint, end: bigint, maxResults: number): Annotation[] { return this.paged ? this.store.queryAnnotations(start, end, maxResults) : []; }
  readFrames(offset: number, count: number): DecodeFrame[] { return this.paged ? this.store.readFrames(offset, count) : []; }
  private consume(batch: PWMScanBatch): void | Promise<void> {
    this.store.append(batch.cycles, batch.averages); this.appendRaw(batch.raw);
    const frames = this.store.length, annotations = frames * 3;
    if (!this.pagedRequested && !this.paged && (!this.pagedAutomatic || frames <= 16_384)) {
      const message = this.reader({ cycles: batch.cycles, averages: batch.averages, progress: this.progress, annotations: batch.raw.length * 3 });
      return this.host.postBatch(message);
    }
    if (!this.paged) { this.paged = true; this.host.postPaged(frames, annotations, this.resultBytes); }
  }
  private appendRaw(values: Uint8Array): void {
    let offset = 0;
    while (offset < values.length) {
      let page = this.rawPages.at(-1);
      if (!page || this.rawOffset === page.length) { page = new Uint8Array(65_536); this.rawPages.push(page); this.rawOffset = 0; }
      const length = Math.min(page.length - this.rawOffset, values.length - offset);
      page.set(values.subarray(offset, offset + length), this.rawOffset);
      this.rawOffset += length; this.rawLength += length; offset += length;
    }
  }
  private raw(): Uint8Array {
    const output = new Uint8Array(this.rawLength); let offset = 0;
    for (const page of this.rawPages) {
      const length = Math.min(page.length, this.rawLength - offset);
      output.set(page.subarray(0, length), offset); offset += length;
      if (offset === this.rawLength) break;
    }
    return output;
  }
}

export function createPWMRuntime(context: DecodeRuntimeContext): DecodeRuntime { return new PWMRuntime(context); }
export type { PWMFrame };
