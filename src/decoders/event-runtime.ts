import { OUTPUT_ANN } from '../libhakeidecode/index.js';
import { BinaryStore } from './binary-store.js';
import { resultMemory } from './definition.js';
import type { DecoderEngine, DecoderPlugin, OutputEvent, SignalWindow } from '../libhakeidecode/index.js';
import type {
  Annotation,
  DecodeFrame,
  DecodeRuntime,
  DecodeRuntimeContext,
  DecodeRuntimeResult,
} from './definition.js';

export interface EventRuntimeApi<F extends DecodeFrame> {
  addFrame(frame: F): void;
  addBinary(key: string, bytes: Uint8Array): void;
  addValue(key: string, value: number): void;
}
export interface EventRuntimeHandler<F extends DecodeFrame> {
  event(event: OutputEvent, api: EventRuntimeApi<F>): void;
  finish?(api: EventRuntimeApi<F>): void;
  reset?(api: EventRuntimeApi<F>): void;
}

const MAX_RETAINED_ANNOTATIONS = 5_000_000;
const MAX_RETAINED_FRAMES = 2_000_000;
const MAX_RETAINED_BINARY_BYTES = 64 * 1024 * 1024;

export class EventRuntime<F extends DecodeFrame = DecodeFrame> implements DecodeRuntime, EventRuntimeApi<F> {
  private readonly engine: DecoderEngine<readonly OutputEvent[]>;
  private readonly host: DecodeRuntimeContext['host'];
  private readonly publish: DecodeRuntimeContext['publish'];
  private readonly pagedMode: DecodeRuntimeContext['paged'];
  private readonly handler: EventRuntimeHandler<F>;
  private annotations: Annotation[] = [];
  private frames: F[] = [];
  private readonly binaries = new BinaryStore();
  private readonly values = new Map<string, number>();
  private annotationsCount = 0;
  private framesCount = 0;
  private eventEnd = 0n;
  private retained = false;
  private retainedStart = 0n;
  private truncated = false;
  private binaryTruncated = false;

  constructor(plugin: DecoderPlugin<any, any>, context: DecodeRuntimeContext, handler: EventRuntimeHandler<F>) {
    this.host = context.host;
    this.publish = context.publish;
    this.pagedMode = context.paged;
    this.handler = handler;
    const channels = Object.fromEntries(context.channels.map((channel) => [channel, channel]));
    this.engine = plugin.createEngine({
      sampleRate: context.sampleRate,
      options: context.options,
      channels,
      instanceId: plugin.descriptor.id,
      sink: { write: (batch: readonly OutputEvent[]) => this.consume(batch) },
    });
  }
  get frameCount(): number {
    return this.framesCount;
  }
  get annotationCount(): number {
    return this.annotationsCount;
  }
  memory() {
    return resultMemory(0, 0, this.binaries.reservedBytes);
  }
  addFrame(frame: F): void {
    if (this.retained && frame.es <= this.retainedStart) return;
    if (this.pagedMode === 'always' && this.framesCount >= MAX_RETAINED_FRAMES) {
      this.truncated = true;
      return;
    }
    this.frames.push(frame);
    this.framesCount++;
  }
  addBinary(key: string, bytes: Uint8Array): void {
    if (this.retained && this.eventEnd <= this.retainedStart) return;
    if (this.pagedMode === 'always' && this.binaries.reservedBytes + bytes.byteLength > MAX_RETAINED_BINARY_BYTES) {
      this.binaryTruncated = true;
      return;
    }
    this.binaries.append(key, bytes, this.retained ? this.eventEnd : undefined);
  }
  addValue(key: string, value: number): void {
    if (Number.isFinite(value)) this.values.set(key, value);
  }
  async push(window: SignalWindow, progress: number): Promise<void> {
    if (this.pagedMode === 'always' && this.truncated && !this.publish) return;
    await this.engine.push(window);
    await this.flush(progress);
  }
  async flush(progress: number): Promise<void> {
    if (!this.annotations.length && !this.frames.length) return;
    const annotations = this.annotations,
      frames = this.frames;
    this.annotations = [];
    this.frames = [];
    await this.host.postBatch({ type: 'batch', progress, annotations, frames });
  }
  reset(): void {
    this.annotations = [];
    this.frames = [];
    this.handler.reset?.(this);
    this.engine.reset();
    this.truncated = false;
    this.binaryTruncated = false;
  }
  retain(startSample: bigint): void {
    this.retained = true;
    this.retainedStart = startSample;
    const counts = this.host.retain?.(startSample);
    if (!counts) throw new Error('Rolling result storage is unavailable');
    this.framesCount = counts.frames;
    this.annotationsCount = counts.annotations;
    if (this.annotationsCount < MAX_RETAINED_ANNOTATIONS && this.framesCount < MAX_RETAINED_FRAMES)
      this.truncated = false;
    this.binaries.discardBefore(startSample);
  }
  async finish(progress: number): Promise<DecodeRuntimeResult> {
    await this.engine.finish();
    this.handler.finish?.(this);
    await this.flush(progress);
    return {
      binaries: this.binaries.finish(),
      values: { ...Object.fromEntries(this.values) },
      frames: this.framesCount,
      annotations: this.annotationsCount,
      truncated: this.truncated,
      binaryTruncated: this.binaryTruncated,
    };
  }
  private consume(events: readonly OutputEvent[]): void {
    const bounded = this.pagedMode === 'always';
    for (const event of events) {
      this.publish?.(event);
      this.eventEnd = event.es;
      if (event.type === OUTPUT_ANN) {
        if (this.retained && event.es <= this.retainedStart) continue;
        if (bounded && this.annotationsCount >= MAX_RETAINED_ANNOTATIONS) {
          this.truncated = true;
          continue;
        }
        const data = event.data as readonly [number, readonly string[], number?];
        this.annotations.push({ ss: event.ss, es: event.es, classIndex: data[0], texts: data[1], value: data[2] });
        this.annotationsCount++;
      } else this.handler.event(event, this);
    }
  }
}
