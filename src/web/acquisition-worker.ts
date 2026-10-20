import type { AcquisitionChunk, DeviceConfiguration, SampleDevice } from '../libhakei/device.js';
import type { SharedChunkProducer, SharedPublisherMetrics } from './shared-chunks.js';
import type { SharedChunkAllocator } from './shared-chunk-allocator.js';
export type AcquisitionRequest =
  | { type: 'start'; moduleUrl: string; exportName: string; initialization?: unknown; configuration: DeviceConfiguration; chunkSamples: number; buffers: ArrayBuffer[]; sharedSampleCount?: bigint; sharedChunkBytes?: number }
  | { type: 'subscribe'; port: MessagePort }
  | { type: 'recycle'; buffer: ArrayBuffer } | { type: 'stop' };
export type AcquisitionResponse = { type: 'chunk'; chunk: AcquisitionChunk; buffer: ArrayBuffer }
  | { type: 'shared-progress'; allocatedBytes: number; publishedSamples: bigint; publisher?: SharedPublisherMetrics; h417Transport?: { reads: number; receivedBytes: number; parserMs: number; queuePeak: number; dataFrames: number }; h417Worker?: { packedCopyMs: number; bufferWaitMs: number; consumerWaitMs: number } }
  | { type: 'done' } | { type: 'error'; message: string } | { type: 'closed' };
type Scope = { onmessage: ((event: MessageEvent<AcquisitionRequest>) => void) | null; postMessage(message: AcquisitionResponse, transfer?: Transferable[]): void };
const scope = globalThis as unknown as Scope;
const available: ArrayBuffer[] = [];
let waiter: { resolve(buffer: ArrayBuffer): void; reject(error: unknown): void } | null = null;
let pendingConsumers: MessagePort[] = [];
let producer: SharedChunkProducer | null = null;
let allocator: SharedChunkAllocator | null = null;
let started = false;
const controller = new AbortController();
scope.onmessage = ({ data }) => {
  if (data.type === 'stop') {
    controller.abort(); waiter?.reject(controller.signal.reason); waiter = null; return;
  }
  if (data.type === 'subscribe') {
    if (producer) producer.addConsumer(data.port); else pendingConsumers.push(data.port);
    return;
  }
  if (data.type === 'recycle') {
    if (waiter) { const { resolve } = waiter; waiter = null; resolve(data.buffer); } else available.push(data.buffer);
    return;
  }
  if (started) return;
  started = true; available.push(...data.buffers);
  void (async () => {
    let iterator: AsyncIterator<AcquisitionChunk> | undefined;
    let terminal: 'complete' | 'stopped' | 'error' = 'complete', failure = '';
    let h417Transport: Extract<AcquisitionChunk, { format: 'packed-logic' }>['h417Transport'];
    let h417Worker: Extract<AcquisitionChunk, { format: 'packed-logic' }>['h417Worker'];
    try {
      if (data.sharedSampleCount !== undefined) {
        const [{ SharedChunkProducer }, { SharedChunkAllocator }] = await Promise.all([import('./shared-chunks.js'), import('./shared-chunk-allocator.js')]);
        allocator = new SharedChunkAllocator();
        let lastProgressAt = -Infinity, lastReportedSamples = 0n;
        const reportSharedProgress = (allocatedBytes: number, publishedSamples: bigint, publisher: SharedPublisherMetrics, force = false): void => {
          const now = performance.now();
          if (force || publishedSamples > 0n && lastReportedSamples === 0n || now - lastProgressAt >= 100 || publishedSamples === data.sharedSampleCount) {
            lastProgressAt = now; lastReportedSamples = publishedSamples; scope.postMessage({ type: 'shared-progress', allocatedBytes, publishedSamples, publisher, ...(h417Transport ? { h417Transport } : {}), ...(h417Worker ? { h417Worker } : {}) });
          }
        };
        producer = new SharedChunkProducer({ sampleCount: data.sharedSampleCount, chunkBytes: data.sharedChunkBytes,
          allocate: byteLength => allocator!.allocate(byteLength), onProgress: (bytes, samples, publisher) => reportSharedProgress(bytes, samples, publisher) });
        for (const port of pendingConsumers.splice(0)) producer.addConsumer(port);
        await producer.prepare();
        reportSharedProgress(producer.allocatedBytes, producer.length, producer.publisherMetrics, true);
      }
      const module = await import(data.moduleUrl);
      controller.signal.throwIfAborted();
      const device = new module[data.exportName](data.initialization) as SampleDevice;
      const source = device.getAcquisitionDescription?.(data.configuration).layout === 'packed-logic' ? device.createPackedSource!.bind(device) : device.createSource.bind(device);
      let borrowed: ArrayBuffer | null = null;
      iterator = source(data.configuration, { signal: controller.signal, chunkSamples: data.chunkSamples,
        acquireBuffer: async () => {
          controller.signal.throwIfAborted();
          return borrowed = available.shift() ?? await new Promise<ArrayBuffer>((resolve, reject) => { waiter = { resolve, reject }; });
        } })[Symbol.asyncIterator]();
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        if (!borrowed) throw new Error('Worker driver must use the managed buffer contract');
        if (producer && 'format' in result.value && result.value.format === 'packed-logic') {
          h417Transport = result.value.h417Transport ?? h417Transport;
          h417Worker = result.value.h417Worker ?? h417Worker;
          await producer.append(result.value.data.subarray(0, result.value.length));
        }
        const buffer = borrowed; borrowed = null;
        if (producer) {
          available.push(buffer);
        } else {
          scope.postMessage({ type: 'chunk', chunk: result.value, buffer }, [buffer]);
        }
      }
      if (producer && producer.length !== data.sharedSampleCount) throw new Error(`Shared capture ended at ${producer.length} of ${data.sharedSampleCount} samples`);
    } catch (error) {
      if (controller.signal.aborted) terminal = 'stopped';
      else { terminal = 'error'; failure = error instanceof Error ? error.message : String(error); }
    } finally {
      try { await iterator?.return?.(); }
      catch (error) { if (terminal !== 'stopped') { terminal = 'error'; failure = error instanceof Error ? error.message : String(error); } }
      if (producer?.state === 'open') producer.finish(terminal, failure || undefined);
      if (producer) scope.postMessage({ type: 'shared-progress', allocatedBytes: producer.allocatedBytes, publishedSamples: producer.length, publisher: producer.publisherMetrics, ...(h417Transport ? { h417Transport } : {}), ...(h417Worker ? { h417Worker } : {}) });
      allocator?.close(); allocator = null;
      if (terminal === 'error') scope.postMessage({ type: 'error', message: failure || 'Acquisition failed' });
      else scope.postMessage({ type: 'done' });
      scope.postMessage({ type: 'closed' });
    }
  })();
};
