import type { AcquisitionChunk, AcquisitionDescription, DeviceConfiguration } from '../libhakei/device.js';
import type { AcquisitionResponse, AcquisitionRequest } from './acquisition-worker.js';
import { DEFAULT_SHARED_CHUNK_BYTES } from './shared-chunks.js';

export class WorkerSampleSource implements AsyncIterableIterator<AcquisitionChunk> {
  private readonly worker: Worker;
  private readonly queue: Extract<AcquisitionResponse, { type: 'chunk' }>[] = [];
  private borrowed: ArrayBuffer | null = null;
  private wake: (() => void) | null = null;
  private finished = false;
  private error: Error | null = null;
  private stopping: Promise<IteratorResult<AcquisitionChunk>> | null = null;
  private closed = false;
  private closeWake: (() => void) | null = null;
  private completionResolve!: () => void;
  private readonly completion: Promise<void>;
  private completionSettled = false;
  private readonly abort = () => this.stop();
  onSharedProgress: (() => void) | null = null;
  private readonly shared: boolean;
  private sharedAllocatedBytes = 0;
  private sharedPublishedSamples = 0n;
  private sharedPublisher = { calls: 0, bytes: 0, totalMs: 0, maxMs: 0 };
  private sharedH417Transport: { reads: number; receivedBytes: number; parserMs: number; queuePeak: number; dataFrames: number } | undefined;
  private sharedH417Worker: { packedCopyMs: number; bufferWaitMs: number; consumerWaitMs: number } | undefined;
  readonly capacity: number;
  maxQueued = 0;
  constructor(description: AcquisitionDescription, configuration: DeviceConfiguration, chunkSamples: number, buffers: ArrayBuffer[], private readonly signal?: AbortSignal) {
    this.completion = new Promise<void>(resolve => { this.completionResolve = resolve; });
    this.capacity = buffers.length;
    this.shared = description.layout === 'packed-logic';
    if (description.worker?.required && this.shared && typeof SharedArrayBuffer === 'undefined')
      throw new Error('H417 shared capture requires cross-origin isolation (COOP same-origin and COEP require-corp)');
    this.worker = new Worker(new URL('./acquisition-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<AcquisitionResponse>) => {
      if (data.type === 'chunk') {
        this.queue.push(data); this.maxQueued = Math.max(this.maxQueued, this.queue.length);
        if (this.queue.length > this.capacity) { this.error = new Error('Acquisition worker exceeded its buffer capacity'); this.stop(); }
      } else if (data.type === 'shared-progress') { this.sharedAllocatedBytes = data.allocatedBytes; this.sharedPublishedSamples = data.publishedSamples; if (data.publisher) this.sharedPublisher = { ...data.publisher }; if (data.h417Transport) this.sharedH417Transport = { ...data.h417Transport }; if (data.h417Worker) this.sharedH417Worker = { ...data.h417Worker }; this.onSharedProgress?.(); }
      else if (data.type === 'error') this.error = new Error(data.message);
      else if (data.type === 'closed') { this.closed = true; this.closeWake?.(); this.resolveCompletion(); }
      else { this.finished = true; this.resolveCompletion(); }
      this.wake?.(); this.wake = null;
    };
    this.worker.onerror = event => { event.preventDefault(); this.error = new Error(event.message); this.closed = true; this.closeWake?.(); this.resolveCompletion(); this.wake?.(); this.wake = null; };
    this.worker.onmessageerror = () => { this.error = new Error('Acquisition message could not be read'); this.stop(); this.wake?.(); this.wake = null; };
    try { this.worker.postMessage({ type: 'start', ...description.worker!, configuration, chunkSamples, buffers,
      ...(this.shared ? { sharedSampleCount: BigInt(configuration.sampleCount), sharedChunkBytes: DEFAULT_SHARED_CHUNK_BYTES } : {}) } satisfies AcquisitionRequest, buffers); }
    catch (error) { this.worker.terminate(); throw error; }
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.stop();
  }
  get allocatedBytes(): number { return this.sharedAllocatedBytes; }
  get publishedSamples(): bigint { return this.sharedPublishedSamples; }
  get publisherMetrics(): { calls: number; bytes: number; totalMs: number; maxMs: number } { return { ...this.sharedPublisher }; }
  get h417TransportMetrics(): { reads: number; receivedBytes: number; parserMs: number; queuePeak: number; dataFrames: number } | undefined { return this.sharedH417Transport ? { ...this.sharedH417Transport } : undefined; }
  get h417WorkerMetrics(): { packedCopyMs: number; bufferWaitMs: number; consumerWaitMs: number } | undefined { return this.sharedH417Worker ? { ...this.sharedH417Worker } : undefined; }
  get sharedCapture(): boolean { return this.shared; }
  get errorMessage(): string | undefined { return this.error?.message; }
  waitForCompletion(): Promise<void> { return this.completion; }

  connectConsumer(port: MessagePort): void {
    if (!this.shared) throw new Error('This acquisition source does not publish shared raw chunks');
    if (this.closed || this.finished) throw new Error('Acquisition source is closed');
    this.worker.postMessage({ type: 'subscribe', port } satisfies AcquisitionRequest, [port]);
  }
  private stop(): void { if (!this.closed && !this.finished) this.worker.postMessage({ type: 'stop' } satisfies AcquisitionRequest); }
  [Symbol.asyncIterator](): AsyncIterableIterator<AcquisitionChunk> { return this; }
  async next(): Promise<IteratorResult<AcquisitionChunk>> {
    if (this.borrowed && !this.closed) {
      this.worker.postMessage({ type: 'recycle', buffer: this.borrowed } satisfies AcquisitionRequest, [this.borrowed]); this.borrowed = null;
    }
    while (!this.queue.length && !this.finished && !this.error) await new Promise<void>(resolve => { this.wake = resolve; });
    const value = this.queue.shift();
    if (value) { this.borrowed = value.buffer; return { done: false, value: value.chunk }; }
    if (this.error) throw this.error;
    return { done: true, value: undefined };
  }
  return(): Promise<IteratorResult<AcquisitionChunk>> {
    return this.stopping ??= this.close();
  }
  private async close(): Promise<IteratorResult<AcquisitionChunk>> {
    this.signal?.removeEventListener('abort', this.abort);
    this.stop();
    if (!this.closed) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 3_000);
      this.closeWake = () => { clearTimeout(timer); resolve(); };
      if (this.closed) this.closeWake();
    });
    this.finished = true; this.worker.terminate(); this.closed = true;
    this.resolveCompletion();
    this.queue.length = 0; this.borrowed = null; this.wake?.(); this.wake = null;
    return { done: true, value: undefined };
  }
  private resolveCompletion(): void {
    if (this.completionSettled) return;
    this.completionSettled = true; this.completionResolve();
  }
}
