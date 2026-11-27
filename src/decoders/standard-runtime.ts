import { DecoderRunner } from '../libhakeidecode/runner.js';
import {
  OUTPUT_ANN,
  OUTPUT_BINARY,
  OUTPUT_META,
  OUTPUT_PROTOCOL,
  SRD_CONF_SAMPLERATE,
} from '../libhakeidecode/outputs.js';
import { OutputStreams } from '../libhakeidecode/outputs.js';
import { BinaryStore } from './binary-store.js';
import { resultMemory } from './definition.js';
import type {
  Annotation,
  DecodeBatch,
  DecodeFrame,
  DecodeRuntime,
  DecodeRuntimeContext,
  DecodeRuntimeResult,
} from './definition.js';
import type {
  DecoderContext,
  DecoderLifecycle,
  LogicDecoder,
  OutputEvent,
  ProtocolDecoder,
  SignalWindow,
} from '../libhakeidecode/types.js';

export interface StandardDecoderClass {
  new (options?: never): DecoderLifecycle;
}

interface StandardFrame extends DecodeFrame {
  readonly protoId: string;
  readonly kind: 'protocol' | 'summary';
  readonly data?: unknown;
  readonly annotations?: number;
}

const MAX_RETAINED_ANNOTATIONS = 5_000_000;
const MAX_RETAINED_FRAMES = 2_000_000;
const MAX_RETAINED_BINARY_BYTES = 64 * 1024 * 1024;

export class StandardRuntime implements DecodeRuntime {
  private readonly context: DecodeRuntimeContext;
  private readonly decoder: DecoderLifecycle;
  private readonly mode: 'logic' | 'protocol';
  private runner: DecoderRunner | null = null;
  private outputs: OutputStreams | null = null;
  private annotations: Annotation[] = [];
  private frames: StandardFrame[] = [];
  private binaries = new BinaryStore();
  private values = new Map<string, number>();
  private annotationsCount = 0;
  private framesCount = 0;
  private retained = false;
  private retainedStart = 0n;
  private finished = false;
  private truncated = false;
  private binaryTruncated = false;
  private rangeStart: bigint | null = null;
  private rangeEnd: bigint | null = null;

  constructor(DecoderClass: StandardDecoderClass, context: DecodeRuntimeContext, mode: 'logic' | 'protocol') {
    this.context = context;
    this.mode = mode;
    this.decoder = new DecoderClass(context.options as never);
    this.initialize();
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

  private initialize(): void {
    const instanceId = this.context.instanceId;
    const onEvent = (event: OutputEvent): void => this.consume(event);
    if (this.mode === 'logic') {
      this.runner = new DecoderRunner(this.decoder as LogicDecoder, {
        channels: Object.fromEntries(this.context.channels.map((channel) => [channel, channel])),
        instanceId,
        onEvent,
      });
      this.runner.start(this.context.sampleRate);
      return;
    }
    this.outputs = new OutputStreams(this.decoder, {
      instanceId,
      onEvent,
    });
    const decoder = this.decoder;
    const context: DecoderContext = {
      register: (...args) => this.outputs!.register(...args),
      put: (...args) => this.outputs!.put(...args),
      hasChannel: () => false,
      channelValue: () => undefined,
      get currentSample() {
        return decoder.samplenum;
      },
    };
    this.decoder.ctx = context;
    this.decoder.start(context);
    this.decoder.metadata(SRD_CONF_SAMPLERATE, this.context.sampleRate);
  }

  private consume(event: OutputEvent): void {
    this.context.publish?.(event);
    this.updateRange(event.ss, event.es);
    if (this.retained && event.es <= this.retainedStart) return;
    const bounded = !this.retained && this.context.paged === 'always';
    if (event.type === OUTPUT_ANN) {
      if (bounded && this.annotationsCount >= MAX_RETAINED_ANNOTATIONS) {
        this.truncated = true;
        return;
      }
      const data = event.data as readonly [number, readonly string[], number?];
      const annotation: Annotation = {
        ss: event.ss,
        es: event.es,
        classIndex: data[0],
        texts: data[1],
        ...(data[2] === undefined ? {} : { value: data[2] }),
      };
      this.annotations.push(annotation);
      this.annotationsCount++;
    } else if (event.type === OUTPUT_PROTOCOL) {
      if (bounded && this.framesCount >= MAX_RETAINED_FRAMES) {
        this.truncated = true;
        return;
      }
      this.frames.push({
        ss: event.ss,
        es: event.es,
        protoId: event.protoId,
        kind: 'protocol',
        data: event.data,
      });
      this.framesCount++;
    } else if (event.type === OUTPUT_BINARY) {
      const [index, bytes] = event.data as readonly [number, Uint8Array];
      if (bounded && this.binaries.reservedBytes + bytes.byteLength > MAX_RETAINED_BINARY_BYTES) {
        this.binaryTruncated = true;
        return;
      }
      const key = this.decoder.descriptor.binary?.[index]?.[0];
      if (key) this.binaries.append(key, bytes, this.retained ? event.es : undefined);
    } else if (event.type === OUTPUT_META) {
      const name = event.meta?.[1];
      if (name) this.values.set(name, event.data as number);
    }
  }

  async push(window: SignalWindow, progress: number): Promise<void> {
    if (this.mode !== 'logic' || !this.runner) throw new Error('Decoder node does not accept logic input');
    if (!this.retained && this.context.paged === 'always' && this.truncated && !this.context.publish) return;
    this.updateRange(window.startSample, window.endSample);
    this.runner.pushWindow(window);
    await this.flush(progress);
  }

  decodeProtocol(ss: bigint, es: bigint, data: unknown): void {
    if (this.mode !== 'protocol') throw new Error('Decoder node does not accept protocol input');
    this.updateRange(ss, es);
    const decoder = this.decoder as ProtocolDecoder;
    if (typeof decoder.decode !== 'function') throw new Error('Protocol decoder has no decode method');
    decoder.samplenum = es;
    decoder.decode(ss, es, data);
    decoder.flush?.();
  }

  async flush(progress: number): Promise<void> {
    if (!this.annotations.length && !this.frames.length) return;
    const batch: DecodeBatch = {
      type: 'batch',
      progress,
      annotations: this.annotations,
      frames: this.frames,
    };
    this.annotations = [];
    this.frames = [];
    await this.context.host.postBatch(batch);
  }

  reset(): void {
    if (this.runner) this.runner.reset();
    else {
      const streams = this.outputs?.streams;
      this.decoder.reset?.();
      this.decoder.samplenum = 0n;
      this.decoder.matched = null;
      if (this.outputs && streams) this.outputs.streams = streams;
    }
    this.annotations = [];
    this.frames = [];
    this.binaries = new BinaryStore();
    this.values.clear();
    this.annotationsCount = 0;
    this.framesCount = 0;
    this.retained = false;
    this.retainedStart = 0n;
    this.finished = false;
    this.truncated = false;
    this.binaryTruncated = false;
    this.rangeStart = null;
    this.rangeEnd = null;
  }

  retain(startSample: bigint): void {
    this.retained = true;
    this.retainedStart = startSample;
    const counts = this.context.host.retain?.(startSample);
    if (!counts) throw new Error('Rolling result storage is unavailable');
    this.framesCount = counts.frames;
    this.annotationsCount = counts.annotations;
    this.binaries.discardBefore(startSample);
  }

  async finish(progress: number): Promise<DecodeRuntimeResult> {
    if (this.finished) throw new Error('Decoder runtime already finished');
    this.finished = true;
    if (this.runner) this.runner.finish();
    else {
      this.decoder.onEof?.({ sample: this.decoder.samplenum });
      this.decoder.flush?.();
    }
    if (!this.framesCount) {
      this.frames.push({
        ss: this.rangeStart ?? 0n,
        es: this.rangeEnd ?? this.decoder.samplenum,
        protoId: this.decoder.descriptor.id,
        kind: 'summary',
        annotations: this.annotationsCount,
      });
      this.framesCount++;
    }
    await this.flush(progress);
    return {
      binaries: this.binaries.finish(),
      values: Object.fromEntries(this.values),
      frames: this.framesCount,
      annotations: this.annotationsCount,
      truncated: this.truncated,
      binaryTruncated: this.binaryTruncated,
    };
  }

  observeRange(ss: bigint, es: bigint): void {
    this.updateRange(ss, es);
  }

  private updateRange(ss: bigint, es: bigint): void {
    if (this.rangeStart === null || ss < this.rangeStart) this.rangeStart = ss;
    if (this.rangeEnd === null || es > this.rangeEnd) this.rangeEnd = es;
  }
}

export function standardCsvRow(frame: DecodeFrame, sampleRate: number, triggerSample: bigint): string {
  const item = frame as StandardFrame;
  return [
    item.ss,
    item.es,
    Number(item.ss - triggerSample) / sampleRate,
    item.protoId,
    item.kind,
    item.annotations ?? '',
    item.data === undefined
      ? ''
      : JSON.stringify(item.data, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
  ]
    .join(',')
    .replaceAll('\n', ' ');
}

export function standardCompareFrames(left: DecodeFrame, right: DecodeFrame): number {
  if (left.ss !== right.ss) return left.ss < right.ss ? -1 : 1;
  if (left.es !== right.es) return left.es < right.es ? -1 : 1;
  return (left as StandardFrame).protoId.localeCompare((right as StandardFrame).protoId);
}

export const STANDARD_CSV_HEADER = 'start_sample,end_sample,time_s,protocol,kind,annotations,data';

export { OUTPUT_PROTOCOL };
