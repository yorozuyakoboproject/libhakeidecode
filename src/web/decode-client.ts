import { channelStoreRange, type Capture, type SharedCaptureConsumerSource } from './capture.js';
import { SharedWorkerSampleStore } from './shared-sample-store.js';
import type { Annotation, DecodeBatchMessage, DecodeMessage, DecoderId, Frame, WorkerDecodeMessage } from './protocol.js';
import { decoderDefinition } from '../decoders/index.js';
import type { OptionValue } from '../libhakeidecode/index.js';
import { t, UIError } from './i18n.js';
export type DecodeResult = Extract<DecodeMessage, { type: 'done' }>;
const DECODE_SAMPLE_WINDOW = 8_000_000n;
const LIVE_DECODE_SAMPLE_WINDOW = 1_000_000n;
const DECODE_EDGE_WINDOW_LIMIT = 100_000;
const yieldTask = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
type ChannelMapping = Record<string, number | undefined>;
function mappedChannels(decoder: DecoderId, mapping: ChannelMapping): [string, number][] {
  const definition = decoderDefinition(decoder), entries = definition.ui.inputs.flatMap(input => {
    const index = mapping[input.key]; return index === undefined ? [] : [[input.key, index] as [string, number]];
  });
  const mode = definition.ui.inputRequirement ?? 'all';
  if (!entries.length || mode === 'all' && definition.ui.inputs.some(input => !input.optional && mapping[input.key] === undefined)) throw new UIError('error.noMapping');
  return entries;
}
export interface LiveDecodeSession {

  readonly mainThreadBatches: { count: number; frames: number; annotations: number; restoreTotalMs: number; restoreMaxMs: number; callbackTotalMs: number; callbackMaxMs: number; totalMs: number; maxMs: number };
  advance(capture: Capture): Promise<void>;
  finish(capture: Capture): Promise<DecodeResult>;
}
export class DecodeClient {
  private worker: Worker | null = null;
  private reject: ((error: Error) => void) | null = null;
  private acknowledge: (() => void) | null = null;
  private generation = 0;
  private requestId = 0;
  private readonly pendingQueries = new Map<number, { resolve(value: Annotation[] | Frame[]): void; reject(error: Error): void }>();
  cancel(): void {
    this.generation++;
    this.acknowledge?.(); this.acknowledge = null;
    this.worker?.terminate(); this.worker = null;
    const reject = this.reject; this.reject = null; reject?.(new DOMException(t('error.cancelled'), 'AbortError'));
    for (const pending of this.pendingQueries.values()) pending.reject(new DOMException(t('error.cancelled'), 'AbortError')); this.pendingQueries.clear();
  }
  queryAnnotations(start: bigint, end: bigint, maxResults: number): Promise<Annotation[]> {
    return this.query({ type: 'decode-query-annotations', requestId: this.nextRequestId(), start, end, maxResults }) as Promise<Annotation[]>;
  }
  readFrames(offset: number, count: number): Promise<Frame[]> {
    return this.query({ type: 'decode-read-frames', requestId: this.nextRequestId(), offset, count }) as Promise<Frame[]>;
  }
  private nextRequestId(): number { return ++this.requestId; }
  private query(request: { type: 'decode-query-annotations'; requestId: number; start: bigint; end: bigint; maxResults: number } | { type: 'decode-read-frames'; requestId: number; offset: number; count: number }): Promise<Annotation[] | Frame[]> {
    const worker = this.worker;
    if (!worker) return Promise.resolve([]);
    return new Promise((resolve, reject) => { this.pendingQueries.set(request.requestId, { resolve, reject }); worker.postMessage(request); });
  }
  private routeAuxMessage(message: WorkerDecodeMessage): boolean {
    if (message.type === 'decode-query-annotations-result' || message.type === 'decode-read-frames-result') {
      const pending = this.pendingQueries.get(message.requestId); if (!pending) return true;
      this.pendingQueries.delete(message.requestId); pending.resolve(message.type === 'decode-query-annotations-result' ? message.annotations : message.frames); return true;
    }
    return false;
  }
  startLive(capture: Capture, options: Record<string, OptionValue>, mapping: ChannelMapping, onBatch: (message: DecodeBatchMessage) => void, decoder: DecoderId, sharedSource?: SharedCaptureConsumerSource, onProgress?: (progress: number, frames: number, annotations: number, resultBytes: number) => void, onPaged?: (frames: number, annotations: number, resultBytes: number) => void): LiveDecodeSession {
    this.cancel();
    const generation = this.generation;
    const channelIndexes = mappedChannels(decoder, mapping), edgeInput = decoderDefinition(decoder).ui.edgeInput;
    const worker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
    this.worker = worker;
    const mainThreadBatches = { count: 0, frames: 0, annotations: 0, restoreTotalMs: 0, restoreMaxMs: 0, callbackTotalMs: 0, callbackMaxMs: 0, totalMs: 0, maxMs: 0 };
    const deliverBatch = (batch: DecodeBatchMessage, restoreMs = 0): void => {
      const callbackStarted = performance.now();
      try { onBatch(batch); }
      finally { worker.postMessage({ type: 'decode-output-ack' });
        const callbackMs = performance.now() - callbackStarted, elapsed = restoreMs + callbackMs;
        mainThreadBatches.count++;
        mainThreadBatches.frames += batch.frames.length;
        mainThreadBatches.annotations += batch.annotations.length;
        mainThreadBatches.restoreTotalMs += restoreMs;
        mainThreadBatches.restoreMaxMs = Math.max(mainThreadBatches.restoreMaxMs, restoreMs);
        mainThreadBatches.callbackTotalMs += callbackMs;
        mainThreadBatches.callbackMaxMs = Math.max(mainThreadBatches.callbackMaxMs, callbackMs);
        mainThreadBatches.totalMs += elapsed;
        mainThreadBatches.maxMs = Math.max(mainThreadBatches.maxMs, elapsed);
      }
    };
    let cursor = 0n, desired = 0n, currentCapture = capture;
    let pumping: Promise<void> | null = null, failure: Error | null = null, finishRequested = false, finishPosted = false, settled = false, keepWorker = false;
    let resolveResult!: (result: DecodeResult) => void, rejectResult!: (error: Error) => void;
    const result = new Promise<DecodeResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    void result.catch(() => {});
    const cleanup = (): void => { worker.terminate(); if (this.worker === worker) { this.worker = null; this.reject = null; this.acknowledge = null; } };
    const reject = (error: Error): void => {
      if (settled) return;
      failure = error; settled = true; this.acknowledge?.(); this.acknowledge = null; cleanup(); rejectResult(error);
    };
    this.reject = reject;
    worker.onmessage = (event: MessageEvent<WorkerDecodeMessage>) => {
      if (this.worker !== worker) return;
      if (this.routeAuxMessage(event.data)) return;
      if (event.data.type === 'decode-ack') { this.acknowledge?.(); this.acknowledge = null; }
      else if (event.data.type === 'decode-progress') onProgress?.(event.data.progress, event.data.frames, event.data.annotations, event.data.resultBytes);
      else if (event.data.type === 'decode-output-mode') { keepWorker = true; onPaged?.(event.data.frames, event.data.annotations, event.data.resultBytes); }
      else if (event.data.type === 'batch') deliverBatch(event.data);
      else if (event.data.type === 'done') {
        if (settled) return;
        settled = true; this.acknowledge?.(); this.acknowledge = null; if (keepWorker) { if (this.worker === worker) this.reject = null; } else cleanup(); resolveResult(event.data);
      } else if (event.data.type === 'error') {
        const error = new Error(event.data.message);
        if (settled) { cleanup(); for (const pending of this.pendingQueries.values()) pending.reject(error); this.pendingQueries.clear(); }
        else reject(error);
      }
    };
    worker.onerror = () => reject(new UIError('error.worker'));
    const target = capture.acquisition?.targetSamples ?? capture.store.length;
    worker.postMessage({ type: 'decode-start', decoder, sampleRate: capture.store.samplerate, length: target, channels: channelIndexes.map(([key]) => key), gaps: [], options, paged: 'auto' });
    if (sharedSource) {
      const channel = new MessageChannel();
      worker.postMessage({ type: 'decode-shared-start', port: channel.port1, channelCount: capture.logicChannelCount ?? capture.store.channelCount, channels: Object.fromEntries(channelIndexes) }, [channel.port1]);
      try { sharedSource.connectConsumer(channel.port2); } catch (error) { channel.port2.close(); reject(error instanceof Error ? error : new Error(String(error))); }
    }

    const postChunk = (message: { type: 'decode-chunk' | 'decode-edge-chunk'; startSample: bigint; [key: string]: unknown }, transfer: Transferable[] = []): Promise<void> => new Promise((resolve, rejectChunk) => {
      this.acknowledge = resolve;
      try { worker.postMessage(message, transfer); }
      catch (error) { this.acknowledge = null; rejectChunk(error); }
    });
    const sendKnown = async (source: Capture, start: bigint, end: bigint): Promise<void> => {
      const edgeIndex = edgeInput === undefined ? undefined : mapping[edgeInput];
      if (edgeInput !== undefined && edgeIndex !== undefined) {
        const index = edgeIndex;
        const edgeCount = source.store.edgeCount(index, start, end);
        if (edgeCount <= DECODE_EDGE_WINDOW_LIMIT) {
          const edges = source.store.edges(index, start, end);
          await postChunk({ type: 'decode-edge-chunk', startSample: start, endSample: end,
            parts: [{ startSample: start, endSample: end, initial: source.store.sampleAt(index, start) as 0 | 1, edges }] });
          return;
        }
        const data = channelStoreRange(source.store, index, start, end);
        await postChunk({ type: 'decode-chunk', startSample: start, sampleRate: source.store.samplerate, channels: { [edgeInput]: data } }, [data.buffer]);
        return;
      }
      const channels: Record<string, Uint8Array> = {};
      for (const [key, index] of channelIndexes) channels[key] = channelStoreRange(source.store, index, start, end);
      await postChunk({ type: 'decode-chunk', startSample: start, sampleRate: source.store.samplerate, channels }, Object.values(channels).map(data => data.buffer));
    };
    const pump = (): Promise<void> => {
      if (sharedSource) return Promise.resolve();
      if (pumping) return pumping;
      const task = (async (): Promise<void> => {
        while (!failure && generation === this.generation && cursor < desired) {
          const source = currentCapture, available = source.store.length < desired ? source.store.length : desired;
          if (cursor >= available) break;
          const gap = source.store.gaps().find(item => item.endSample > cursor && item.startSample < available);
          if (gap && gap.startSample <= cursor) {
            const end = gap.endSample < available ? gap.endSample : available;
            worker.postMessage({ type: 'decode-gap', startSample: cursor, endSample: end }); cursor = end;
          } else {
            let end = cursor + LIVE_DECODE_SAMPLE_WINDOW;
            if (end > available) end = available;
            if (gap && gap.startSample < end) end = gap.startSample;
            if (end <= cursor) throw new Error('Live decoder made no progress');
            await sendKnown(source, cursor, end); cursor = end;
          }
          await yieldTask();
        }
        if (!failure && generation === this.generation && finishRequested && !finishPosted && cursor >= desired) {
          finishPosted = true; worker.postMessage({ type: 'decode-finish' });
        }
      })().catch(error => {
        const normalized = error instanceof Error ? error : new Error(String(error)); reject(normalized); throw normalized;
      }).finally(() => {
        if (pumping === task) pumping = null;
        if (!failure && generation === this.generation && !settled && (cursor < desired || finishRequested && !finishPosted)) void pump().catch(() => {});
      });
      pumping = task;
      return task;
    };
    const update = (nextCapture: Capture): void => {
      currentCapture = nextCapture;
      const targetSamples = nextCapture.acquisition?.targetSamples ?? nextCapture.store.length;
      desired = nextCapture.store.length < targetSamples ? nextCapture.store.length : targetSamples;
    };
    return {
      mainThreadBatches,
      advance: nextCapture => { if (failure) return Promise.reject(failure); if (settled) return Promise.resolve(); update(nextCapture); return pump(); },
      finish: nextCapture => {
        if (failure) return Promise.reject(failure);
        if (!settled) { update(nextCapture); finishRequested = true; if (sharedSource) { if (!finishPosted) { finishPosted = true; worker.postMessage({ type: 'decode-finish' }); } } else void pump().catch(() => {}); }
        return result;
      },
    };
  }
  run(capture: Capture, options: Record<string, OptionValue>, mapping: ChannelMapping, onBatch: (message: DecodeBatchMessage) => void, decoder: DecoderId, sampleLimit?: bigint, _sharedSource?: SharedCaptureConsumerSource, onProgress?: (progress: number, frames: number, annotations: number, resultBytes: number) => void, onPaged?: (frames: number, annotations: number, resultBytes: number) => void, pageLargeResults = false): Promise<DecodeResult> {
    this.cancel();
    const packedStore = capture.store instanceof SharedWorkerSampleStore ? capture.store : null;
    if (packedStore && sampleLimit !== undefined) throw new UIError('error.worker');
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      void (async () => {
        let activeWorker: Worker | null = null;
        try {
          const availableLength = capture.store.length;
          const length = sampleLimit === undefined ? availableLength : sampleLimit < 0n ? 0n : sampleLimit < availableLength ? sampleLimit : availableLength;
          const channelIndexes = mappedChannels(decoder, mapping), edgeInput = decoderDefinition(decoder).ui.edgeInput;
          if (generation !== this.generation) return;
          const worker = activeWorker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
          this.worker = worker; this.reject = reject;
          const cleanup = (): void => { worker.terminate(); if (this.worker === worker) { this.worker = null; this.reject = null; } };
          const postChunk = (message: { type: 'decode-chunk' | 'decode-edge-chunk' } & Record<string, unknown>, transfer: Transferable[] = []): Promise<void> => new Promise((resolve, rejectChunk) => {
            this.acknowledge = resolve;
            try { worker.postMessage(message, transfer); }
            catch (error) { this.acknowledge = null; rejectChunk(error); }
          });
          let keepWorker = false;
          worker.onmessage = (event: MessageEvent<WorkerDecodeMessage>) => {
            if (this.worker !== worker) return;
            if (this.routeAuxMessage(event.data)) return;
            if (event.data.type === 'decode-ack') { this.acknowledge?.(); this.acknowledge = null; }
            else if (event.data.type === 'decode-progress') onProgress?.(event.data.progress, event.data.frames, event.data.annotations, event.data.resultBytes);
            else if (event.data.type === 'decode-output-mode') { keepWorker = true; onPaged?.(event.data.frames, event.data.annotations, event.data.resultBytes); }
            else if (event.data.type === 'batch') { try { onBatch(event.data); } finally { worker.postMessage({ type: 'decode-output-ack' }); } }
            else if (event.data.type === 'done') { this.acknowledge?.(); this.acknowledge = null; if (keepWorker) { if (this.worker === worker) this.reject = null; } else cleanup(); resolve(event.data); }
            else if (event.data.type === 'error') {
              this.acknowledge?.(); this.acknowledge = null; cleanup(); const error = new Error(event.data.message);
              for (const pending of this.pendingQueries.values()) pending.reject(error); this.pendingQueries.clear(); reject(error);
            }
          };
          worker.onerror = () => { this.acknowledge?.(); this.acknowledge = null; cleanup(); reject(new UIError('error.worker')); };
          const gaps = capture.store.gaps().flatMap(gap => gap.startSample >= length ? [] : [{ startSample: gap.startSample, endSample: gap.endSample > length ? length : gap.endSample }]);
          worker.postMessage({ type: 'decode-start', decoder, sampleRate: capture.store.samplerate, length, channels: channelIndexes.map(([key]) => key), gaps, options, paged: pageLargeResults ? 'auto' : 'never' });
          if (packedStore) {
            const channel = new MessageChannel();
            worker.postMessage({ type: 'decode-packed-reader-start', port: channel.port1, channelCount: capture.logicChannelCount ?? capture.store.channelCount, channels: Object.fromEntries(channelIndexes) }, [channel.port1]);
            packedStore.connectPackedReader(channel.port2);
            worker.postMessage({ type: 'decode-finish' });
            return;
          }
          const sendKnown = async (start: bigint, end: bigint): Promise<void> => {
            const window = DECODE_SAMPLE_WINDOW;
            for (let offset = start; offset < end; offset += window) {
              if (generation !== this.generation) return;
              const chunkEnd = offset + window < end ? offset + window : end;
              const edgeIndex = edgeInput === undefined ? undefined : mapping[edgeInput];
              if (edgeInput !== undefined && edgeIndex !== undefined) {
                const index = edgeIndex;
                const edgeCount = capture.store.edgeCount(index, offset, chunkEnd);
                if (edgeCount <= DECODE_EDGE_WINDOW_LIMIT) {
                  const edges = capture.store.edges(index, offset, chunkEnd);
                  await postChunk({ type: 'decode-edge-chunk', startSample: offset, endSample: chunkEnd,
                    parts: [{ startSample: offset, endSample: chunkEnd, initial: capture.store.sampleAt(index, offset) as 0 | 1, edges }] });
                  if (generation !== this.generation) return;
                  continue;
                }
                const data = channelStoreRange(capture.store, index, offset, chunkEnd);
                await postChunk({ type: 'decode-chunk', startSample: offset, sampleRate: capture.store.samplerate, channels: { [edgeInput]: data } }, [data.buffer]);
              } else {
                const channels: Record<string, Uint8Array> = {};
                for (const [key, index] of channelIndexes) channels[key] = channelStoreRange(capture.store, index, offset, chunkEnd);
                await postChunk({ type: 'decode-chunk', startSample: offset, sampleRate: capture.store.samplerate, channels }, Object.values(channels).map(data => data.buffer));
              }
              if (generation !== this.generation) return;
            }
          };
          let cursor = 0n;
          for (const gap of gaps) {
            const start = gap.startSample > cursor ? gap.startSample : cursor;
            if (cursor < start) { await sendKnown(cursor, start); cursor = start; }
            const end = gap.endSample < length ? gap.endSample : length;
            if (end > cursor) { worker.postMessage({ type: 'decode-gap', startSample: cursor, endSample: end }); await yieldTask(); cursor = end; }
            if (cursor >= length) break;
          }
          if (cursor < length) await sendKnown(cursor, length);
          if (generation !== this.generation) return;
          worker.postMessage({ type: 'decode-finish' });
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
