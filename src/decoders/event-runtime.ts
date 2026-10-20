import { OUTPUT_ANN, registry } from '../libhakeidecode/index.js';
import type { DecoderEngine, OutputEvent, SignalWindow } from '../libhakeidecode/index.js';
import type { Annotation, DecodeBatch, DecodeFrame, DecodeRuntime, DecodeRuntimeContext, DecodeRuntimeResult } from './definition.js';

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

export class EventRuntime<F extends DecodeFrame = DecodeFrame> implements DecodeRuntime, EventRuntimeApi<F> {
  private readonly engine: DecoderEngine<readonly OutputEvent[]>;
  private readonly host: DecodeRuntimeContext['host'];
  private readonly handler: EventRuntimeHandler<F>;
  private annotations: Annotation[] = [];
  private frames: F[] = [];
  private readonly binaryChunks = new Map<string, number[]>();
  private readonly values = new Map<string, number>();
  private annotationsCount = 0;
  private framesCount = 0;
  private binaryBytes = 0;

  constructor(decoder: string, context: DecodeRuntimeContext, handler: EventRuntimeHandler<F>) {
    this.host = context.host; this.handler = handler;
    const channels = Object.fromEntries(context.channels.map(channel => [channel, channel]));
    this.engine = registry.getPlugin(decoder).createEngine({
      sampleRate: context.sampleRate, options: context.options, channels, instanceId: decoder + '-ui',
      sink: { write: (batch: readonly OutputEvent[]) => this.consume(batch) },
    });
  }
  get frameCount(): number { return this.framesCount; }
  get annotationCount(): number { return this.annotationsCount; }
  get resultBytes(): number { return this.binaryBytes; }
  addFrame(frame: F): void { this.frames.push(frame); this.framesCount++; }
  addBinary(key: string, bytes: Uint8Array): void {
    let chunks = this.binaryChunks.get(key);
    if (!chunks) { chunks = []; this.binaryChunks.set(key, chunks); }
    for (let index = 0; index < bytes.length; index++) chunks.push(bytes[index]!);
    this.binaryBytes += bytes.length;
  }
  addValue(key: string, value: number): void { if (Number.isFinite(value)) this.values.set(key, value); }
  async push(window: SignalWindow): Promise<void> { await this.engine.push(window); }
  async flush(progress: number): Promise<void> {
    if (!this.annotations.length && !this.frames.length) return;
    const annotations = this.annotations, frames = this.frames;
    this.annotations = []; this.frames = [];
    await this.host.postBatch({ type: 'batch', progress, annotations, frames });
  }
  reset(): void { this.handler.reset?.(this); this.engine.reset(); }
  async finish(progress: number): Promise<DecodeRuntimeResult> {
    await this.engine.finish(); this.handler.finish?.(this); await this.flush(progress);
    const binaries: Record<string, Uint8Array> = {};
    for (const [key, chunks] of this.binaryChunks) binaries[key] = Uint8Array.from(chunks);
    return { binaries, values: { ...Object.fromEntries(this.values) }, frames: this.framesCount, annotations: this.annotationsCount,
      truncated: false, binaryTruncated: false };
  }
  private consume(events: readonly OutputEvent[]): void {
    for (const event of events) {
      if (event.type === OUTPUT_ANN) {
        const data = event.data as readonly [number, readonly string[]];
        this.annotations.push({ ss: event.ss, es: event.es, classIndex: data[0], texts: data[1] }); this.annotationsCount++;
      } else this.handler.event(event, this);
    }
  }
}
