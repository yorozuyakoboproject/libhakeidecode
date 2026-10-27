import { restoreComponentError } from '../components.js';
import type { Capture, SharedCaptureConsumerSource } from './capture.js';
import { SharedWorkerSampleStore } from './shared-sample-store.js';
import { WorkerCaptureStore } from './worker-store.js';
import type { Annotation, DecodeMessage, DecoderId, Frame, WorkerDecodeMessage } from './protocol.js';
import { decoderDefinition } from '../decoders/index.js';
import type { OptionValue } from '../libhakeidecode/index.js';
import { t, UIError } from './i18n.js';
export type DecodeResult = Extract<DecodeMessage, { type: 'done' }>;
const DECODE_EDGE_WINDOW_LIMIT = 100_000;
type ChannelMapping = Record<string, number | undefined>;
type QueryResult = Annotation[] | Frame[] | string | Blob | null;
function mappedChannels(decoder: DecoderId, mapping: ChannelMapping): [string, number][] {
  const definition = decoderDefinition(decoder),
    entries = definition.ui.inputs.flatMap((input) => {
      const index = mapping[input.key];
      return index === undefined ? [] : [[input.key, index] as [string, number]];
    });
  const mode = definition.ui.inputRequirement ?? 'all';
  if (
    !entries.length ||
    (mode === 'all' && definition.ui.inputs.some((input) => !input.optional && mapping[input.key] === undefined))
  )
    throw new UIError('error.noMapping');
  return entries;
}
export interface LiveDecodeSession {
  advance(capture: Capture): Promise<void>;
  finish(capture: Capture): Promise<DecodeResult>;
}
export class DecodeClient {
  private worker: Worker | null = null;
  private reject: ((error: Error) => void) | null = null;
  private acknowledge: (() => void) | null = null;
  private generation = 0;
  private requestId = 0;
  private readonly pendingQueries = new Map<
    number,
    { resolve(value: QueryResult): void; reject(error: Error): void }
  >();
  cancel(): void {
    this.generation++;
    this.acknowledge?.();
    this.acknowledge = null;
    this.worker?.terminate();
    this.worker = null;
    const reject = this.reject;
    this.reject = null;
    reject?.(new DOMException(t('error.cancelled'), 'AbortError'));
    for (const pending of this.pendingQueries.values())
      pending.reject(new DOMException(t('error.cancelled'), 'AbortError'));
    this.pendingQueries.clear();
  }
  queryAnnotations(start: bigint, end: bigint, maxResults: number): Promise<Annotation[]> {
    return this.query({
      type: 'decode-query-annotations',
      requestId: this.nextRequestId(),
      start,
      end,
      maxResults,
    }) as Promise<Annotation[]>;
  }
  readFrames(offset: number, count: number): Promise<Frame[]> {
    return this.query({ type: 'decode-read-frames', requestId: this.nextRequestId(), offset, count }) as Promise<
      Frame[]
    >;
  }
  readCsv(
    offset: number,
    count: number,
    sampleRate: number,
    triggerSample: bigint,
    includeHeader: boolean,
  ): Promise<string> {
    return this.query({
      type: 'decode-read-csv',
      requestId: this.nextRequestId(),
      offset,
      count,
      sampleRate,
      triggerSample,
      includeHeader,
    }) as Promise<string>;
  }
  readBinary(key: string): Promise<Blob | null> {
    return this.query({ type: 'decode-read-binary', requestId: this.nextRequestId(), key }) as Promise<Blob | null>;
  }
  private nextRequestId(): number {
    return ++this.requestId;
  }
  private query(
    request:
      | { type: 'decode-query-annotations'; requestId: number; start: bigint; end: bigint; maxResults: number }
      | { type: 'decode-read-frames'; requestId: number; offset: number; count: number }
      | {
          type: 'decode-read-csv';
          requestId: number;
          offset: number;
          count: number;
          sampleRate: number;
          triggerSample: bigint;
          includeHeader: boolean;
        }
      | { type: 'decode-read-binary'; requestId: number; key: string },
  ): Promise<QueryResult> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('Decoder Worker is unavailable'));
    return new Promise((resolve, reject) => {
      this.pendingQueries.set(request.requestId, { resolve, reject });
      worker.postMessage(request);
    });
  }
  private routeAuxMessage(message: WorkerDecodeMessage): boolean {
    if (
      message.type === 'decode-query-annotations-result' ||
      message.type === 'decode-read-frames-result' ||
      message.type === 'decode-read-csv-result' ||
      message.type === 'decode-read-binary-result'
    ) {
      const pending = this.pendingQueries.get(message.requestId);
      if (!pending) return true;
      this.pendingQueries.delete(message.requestId);
      pending.resolve(
        message.type === 'decode-query-annotations-result'
          ? message.annotations
          : message.type === 'decode-read-frames-result'
            ? message.frames
            : message.type === 'decode-read-csv-result'
              ? message.csv
              : message.blob,
      );
      return true;
    }
    return false;
  }
  startLive(
    capture: Capture,
    options: Record<string, OptionValue>,
    mapping: ChannelMapping,
    decoder: DecoderId,
    sharedSource?: SharedCaptureConsumerSource,
    onProgress?: (progress: number, frames: number, annotations: number, resultBytes: number) => void,
  ): LiveDecodeSession {
    this.cancel();
    if (!sharedSource && !(capture.store instanceof WorkerCaptureStore)) throw new UIError('error.worker');
    const channelIndexes = mappedChannels(decoder, mapping),
      edgeInput = decoderDefinition(decoder).ui.edgeInput;
    const worker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
    this.worker = worker;
    let failure: Error | null = null,
      finishPosted = false,
      settled = false;
    let resolveResult!: (result: DecodeResult) => void, rejectResult!: (error: Error) => void;
    const result = new Promise<DecodeResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    void result.catch(() => {});
    const cleanup = (): void => {
      worker.terminate();
      if (this.worker === worker) {
        this.worker = null;
        this.reject = null;
        this.acknowledge = null;
      }
    };
    const reject = (error: Error): void => {
      if (settled) return;
      failure = error;
      settled = true;
      this.acknowledge?.();
      this.acknowledge = null;
      cleanup();
      rejectResult(error);
    };
    this.reject = reject;
    worker.onmessage = (event: MessageEvent<WorkerDecodeMessage>) => {
      if (this.worker !== worker) return;
      if (this.routeAuxMessage(event.data)) return;
      if (event.data.type === 'decode-ack') {
        this.acknowledge?.();
        this.acknowledge = null;
      } else if (event.data.type === 'decode-progress')
        onProgress?.(event.data.progress, event.data.frames, event.data.annotations, event.data.memory.totalBytes);
      else if (event.data.type === 'done') {
        if (settled) return;
        settled = true;
        this.acknowledge?.();
        this.acknowledge = null;
        if (this.worker === worker) this.reject = null;
        resolveResult(event.data);
      } else if (event.data.type === 'error') {
        const error = restoreComponentError(event.data);
        if (settled) {
          cleanup();
          for (const pending of this.pendingQueries.values()) pending.reject(error);
          this.pendingQueries.clear();
        } else reject(error);
      }
    };
    worker.onerror = () => reject(new UIError('error.worker'));
    const target = capture.acquisition?.targetSamples ?? capture.store.length;
    worker.postMessage({
      type: 'decode-start',
      decoder,
      sampleRate: capture.store.samplerate,
      length: target,
      channels: channelIndexes.map(([key]) => key),
      gaps: [],
      options,
      paged: 'always',
    });
    if (sharedSource) {
      const channel = new MessageChannel();
      worker.postMessage(
        {
          type: 'decode-shared-start',
          port: channel.port1,
          channelCount: capture.logicChannelCount ?? capture.store.channelCount,
          channels: Object.fromEntries(channelIndexes),
        },
        [channel.port1],
      );
      try {
        sharedSource.connectConsumer(channel.port2);
      } catch (error) {
        channel.port2.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const workerStore = capture.store instanceof WorkerCaptureStore ? capture.store : null;
    if (workerStore) {
      const channel = new MessageChannel();
      worker.postMessage(
        {
          type: 'decode-worker-reader-start',
          port: channel.port1,
          channels: Object.fromEntries(channelIndexes),
          ...(edgeInput === undefined ? {} : { edgeInput }),
          edgeLimit: DECODE_EDGE_WINDOW_LIMIT,
        },
        [channel.port1],
      );
      workerStore.connectDecodeReader(channel.port2);
    }

    return {
      advance: () => (failure ? Promise.reject(failure) : Promise.resolve()),
      finish: (nextCapture) => {
        if (failure) return Promise.reject(failure);
        if (!settled && !finishPosted) {
          finishPosted = true;
          worker.postMessage({ type: 'decode-finish', length: nextCapture.store.length });
        }
        return result;
      },
    };
  }

  run(
    capture: Capture,
    options: Record<string, OptionValue>,
    mapping: ChannelMapping,
    decoder: DecoderId,
    sampleLimit?: bigint,
    onProgress?: (progress: number, frames: number, annotations: number, resultBytes: number) => void,
  ): Promise<DecodeResult> {
    this.cancel();
    const packedStore = capture.store instanceof SharedWorkerSampleStore ? capture.store : null;
    const workerStore = capture.store instanceof WorkerCaptureStore ? capture.store : null;
    if (!packedStore && !workerStore) throw new UIError('error.worker');
    if (packedStore && sampleLimit !== undefined) throw new UIError('error.worker');
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      void (async () => {
        let activeWorker: Worker | null = null;
        try {
          const availableLength = capture.store.length;
          const length =
            sampleLimit === undefined
              ? availableLength
              : sampleLimit < 0n
                ? 0n
                : sampleLimit < availableLength
                  ? sampleLimit
                  : availableLength;
          const channelIndexes = mappedChannels(decoder, mapping),
            edgeInput = decoderDefinition(decoder).ui.edgeInput;
          if (generation !== this.generation) return;
          const worker = (activeWorker = new Worker(new URL('./decode-worker.js', import.meta.url), {
            type: 'module',
          }));
          this.worker = worker;
          this.reject = reject;
          const cleanup = (): void => {
            worker.terminate();
            if (this.worker === worker) {
              this.worker = null;
              this.reject = null;
            }
          };
          worker.onmessage = (event: MessageEvent<WorkerDecodeMessage>) => {
            if (this.worker !== worker) return;
            if (this.routeAuxMessage(event.data)) return;
            if (event.data.type === 'decode-ack') {
              this.acknowledge?.();
              this.acknowledge = null;
            } else if (event.data.type === 'decode-progress')
              onProgress?.(
                event.data.progress,
                event.data.frames,
                event.data.annotations,
                event.data.memory.totalBytes,
              );
            else if (event.data.type === 'done') {
              this.acknowledge?.();
              this.acknowledge = null;
              if (this.worker === worker) this.reject = null;
              resolve(event.data);
            } else if (event.data.type === 'error') {
              this.acknowledge?.();
              this.acknowledge = null;
              cleanup();
              const error = restoreComponentError(event.data);
              for (const pending of this.pendingQueries.values()) pending.reject(error);
              this.pendingQueries.clear();
              reject(error);
            }
          };
          worker.onerror = () => {
            this.acknowledge?.();
            this.acknowledge = null;
            cleanup();
            reject(new UIError('error.worker'));
          };
          const gaps = capture.store
            .gaps()
            .flatMap((gap) =>
              gap.startSample >= length
                ? []
                : [{ startSample: gap.startSample, endSample: gap.endSample > length ? length : gap.endSample }],
            );
          worker.postMessage({
            type: 'decode-start',
            decoder,
            sampleRate: capture.store.samplerate,
            length,
            channels: channelIndexes.map(([key]) => key),
            gaps,
            options,
            paged: 'always',
          });
          if (packedStore) {
            const channel = new MessageChannel();
            worker.postMessage(
              {
                type: 'decode-packed-reader-start',
                port: channel.port1,
                channelCount: capture.logicChannelCount ?? capture.store.channelCount,
                channels: Object.fromEntries(channelIndexes),
              },
              [channel.port1],
            );
            packedStore.connectPackedReader(channel.port2);
            worker.postMessage({ type: 'decode-finish' });
            return;
          }
          if (workerStore) {
            const channel = new MessageChannel();
            worker.postMessage(
              {
                type: 'decode-worker-reader-start',
                port: channel.port1,
                channels: Object.fromEntries(channelIndexes),
                ...(edgeInput === undefined ? {} : { edgeInput }),
                edgeLimit: DECODE_EDGE_WINDOW_LIMIT,
              },
              [channel.port1],
            );
            workerStore.connectDecodeReader(channel.port2);
            worker.postMessage({ type: 'decode-finish', length });
            return;
          }
        } catch (error) {
          if (generation !== this.generation) return;
          activeWorker?.terminate();
          if (this.worker === activeWorker) this.worker = null;
          this.reject = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }
}
