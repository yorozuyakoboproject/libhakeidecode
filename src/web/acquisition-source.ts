import { errorLabel } from './i18n.js';
import { restoreComponentError } from '../components.js';
import { deviceChannelIndices } from '../libhakei/device.js';
import type {
  AcquisitionChunk,
  CaptureMode,
  DeviceConfiguration,
  DriverDiagnostics,
  TransferProgress,
} from '../libhakei/device.js';
import type { WorkerAcquisitionDescription } from './device-protocol.js';
import type { AcquisitionResponse, AcquisitionRequest } from './acquisition-worker.js';
import { DEFAULT_SHARED_CHUNK_BYTES } from './shared-chunks.js';
import { DEFAULT_CAPTURE_BUDGET_BYTES, type BudgetSnapshot } from './memory.js';
import { channelWidthForProbes } from './data/channel-count.js';
import { WorkerCaptureStore } from './worker-store.js';

export interface LocalCaptureResult {
  length: bigint;
  memory: BudgetSnapshot;
  stopReason: 'complete' | 'stopped' | 'error';
  error?: string;
  timings?: import('./data/planarStore.js').PlanarStoreTimings;
}

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
  private driverSnapshot: DriverDiagnostics | undefined;
  private localLength = 0n;
  private localMemory: BudgetSnapshot = {
    limitBytes: DEFAULT_CAPTURE_BUDGET_BYTES,
    usedBytes: 0,
    peakBytes: 0,
    allocations: 0,
  };
  private localDone: LocalCaptureResult | null = null;
  readonly captureStore?: WorkerCaptureStore;
  onLocalProgress: (() => void) | null = null;
  onTransferProgress?: (progress: TransferProgress) => void;
  readonly capacity: number;
  readonly logicSampleBytes: 1 | 2 | 3 | 4;
  readonly channelSelection: { driverId: string; logic: readonly number[]; analog: readonly number[] };
  maxQueued = 0;
  constructor(
    description: WorkerAcquisitionDescription,
    configuration: DeviceConfiguration,
    chunkSamples: number,
    buffers: ArrayBuffer[],
    private readonly signal?: AbortSignal,
    storeCapture = false,
    mode: CaptureMode = 'single',
  ) {
    this.completion = new Promise<void>((resolve) => {
      this.completionResolve = resolve;
    });
    this.capacity = buffers.length;
    this.logicSampleBytes =
      description.logicSampleBytes === 2 || description.logicSampleBytes === 3 || description.logicSampleBytes === 4
        ? description.logicSampleBytes
        : 1;
    this.channelSelection = {
      driverId: description.worker.driverId,
      logic: deviceChannelIndices(configuration, 'logic'),
      analog: deviceChannelIndices(configuration, 'analog'),
    };
    this.shared = description.layout === 'packed-logic' && mode !== 'continuous';
    if (this.shared && typeof SharedArrayBuffer === 'undefined')
      throw new Error('Packed capture requires cross-origin isolation (COOP same-origin and COEP require-corp)');
    this.worker = new Worker(new URL('./acquisition-worker.js', import.meta.url), { type: 'module' });
    let storePort: MessagePort | undefined;
    if (storeCapture) {
      const channel = new MessageChannel();
      storePort = channel.port1;
      const labels = this.channelSelection.logic.map((index) => `D${index}`);
      const analogNames = this.channelSelection.analog.map((index) => `A${index}`);
      this.captureStore = WorkerCaptureStore.empty(
        this.worker,
        channel.port2,
        channelWidthForProbes(Math.max(1, configuration.logicChannels)),
        configuration.sampleRate,
        labels,
        analogNames,
      );
    }
    this.worker.onmessage = ({ data }: MessageEvent<AcquisitionResponse>) => {
      if ('driverDiagnostics' in data && data.driverDiagnostics) this.driverSnapshot = data.driverDiagnostics;
      if (data.type === 'transfer-progress') {
        this.onTransferProgress?.(data.progress);
      } else if (data.type === 'chunk') {
        this.queue.push(data);
        this.maxQueued = Math.max(this.maxQueued, this.queue.length);
        if (this.queue.length > this.capacity) {
          this.error = new Error('Acquisition worker exceeded its buffer capacity');
          this.stop();
        }
      } else if (data.type === 'shared-progress') {
        this.sharedAllocatedBytes = data.allocatedBytes;
        this.sharedPublishedSamples = data.publishedSamples;
        if (data.publisher) this.sharedPublisher = { ...data.publisher };
        this.onSharedProgress?.();
      } else if (data.type === 'local-progress') {
        this.localLength = data.length;
        this.localMemory = { ...data.memory };
        this.onLocalProgress?.();
      } else if (data.type === 'local-done') {
        this.captureStore?.updateMetadata(data.metadata);
        this.localLength = data.length;
        this.localMemory = { ...data.memory };
        this.localDone = {
          length: data.length,
          memory: { ...data.memory },
          stopReason: data.stopReason,
          ...(data.error ? { error: data.error } : {}),
          ...(data.timings ? { timings: data.timings } : {}),
        };
      } else if (data.type === 'error') this.error = restoreComponentError(data);
      else if (data.type === 'closed') {
        this.closed = true;
        this.closeWake?.();
        this.resolveCompletion();
      } else {
        this.finished = true;
        this.resolveCompletion();
      }
      this.wake?.();
      this.wake = null;
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.error = new Error(event.message);
      this.closed = true;
      this.closeWake?.();
      this.resolveCompletion();
      this.wake?.();
      this.wake = null;
    };
    this.worker.onmessageerror = () => {
      this.error = new Error('Acquisition message could not be read');
      this.stop();
      this.wake?.();
      this.wake = null;
    };
    try {
      this.worker.postMessage(
        {
          type: 'start',
          ...description.worker,
          configuration,
          mode,
          chunkSamples,
          buffers,
          ...(storeCapture ? { store: { budgetBytes: DEFAULT_CAPTURE_BUDGET_BYTES }, storePort: storePort! } : {}),
          ...(this.shared
            ? {
                sharedSampleCount: BigInt(configuration.sampleCount),
                sharedChunkBytes: DEFAULT_SHARED_CHUNK_BYTES,
                sharedSampleBytes: this.logicSampleBytes,
              }
            : {}),
        } satisfies AcquisitionRequest,
        storePort ? [...buffers, storePort] : buffers,
      );
    } catch (error) {
      this.captureStore?.dispose();
      this.worker.terminate();
      throw error;
    }
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.stop();
  }
  get allocatedBytes(): number {
    return this.sharedAllocatedBytes;
  }
  get bytesPerSample(): 1 | 2 | 3 | 4 {
    return this.logicSampleBytes;
  }
  get publishedSamples(): bigint {
    return this.sharedPublishedSamples;
  }
  get publisherMetrics(): { calls: number; bytes: number; totalMs: number; maxMs: number } {
    return { ...this.sharedPublisher };
  }
  get driverDiagnostics(): DriverDiagnostics | undefined {
    return this.driverSnapshot;
  }
  get sharedCapture(): boolean {
    return this.shared;
  }
  get errorValue(): Error | undefined {
    return this.error ?? undefined;
  }
  get errorMessage(): string | undefined {
    return this.error ? errorLabel(this.error, 'error.capture') : undefined;
  }
  get localLengthValue(): bigint {
    return this.localLength;
  }
  get localMemorySnapshot(): BudgetSnapshot {
    return { ...this.localMemory };
  }
  get localResult(): LocalCaptureResult | null {
    return this.localDone ? { ...this.localDone, memory: { ...this.localDone.memory } } : null;
  }
  waitForCompletion(): Promise<void> {
    return this.completion;
  }

  connectConsumer(port: MessagePort): void {
    if (!this.shared) throw new Error('This acquisition source does not publish shared raw chunks');
    if (this.closed || this.finished) throw new Error('Acquisition source is closed');
    this.worker.postMessage({ type: 'subscribe', port } satisfies AcquisitionRequest, [port]);
  }
  private stop(): void {
    if (!this.closed && !this.finished) this.worker.postMessage({ type: 'stop' } satisfies AcquisitionRequest);
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<AcquisitionChunk> {
    return this;
  }
  async next(): Promise<IteratorResult<AcquisitionChunk>> {
    if (this.borrowed && !this.closed) {
      this.worker.postMessage({ type: 'recycle', buffer: this.borrowed } satisfies AcquisitionRequest, [this.borrowed]);
      this.borrowed = null;
    }
    while (!this.queue.length && !this.finished && !this.error)
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    const value = this.queue.shift();
    if (value) {
      this.borrowed = value.buffer;
      return { done: false, value: value.chunk };
    }
    if (this.error) throw this.error;
    return { done: true, value: undefined };
  }
  return(): Promise<IteratorResult<AcquisitionChunk>> {
    return (this.stopping ??= this.close());
  }
  private async close(): Promise<IteratorResult<AcquisitionChunk>> {
    this.signal?.removeEventListener('abort', this.abort);
    this.stop();
    if (!this.closed)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        this.closeWake = () => {
          clearTimeout(timer);
          resolve();
        };
        if (this.closed) this.closeWake();
      });
    this.finished = true;
    this.worker.terminate();
    this.closed = true;
    this.resolveCompletion();
    this.queue.length = 0;
    this.borrowed = null;
    this.wake?.();
    this.wake = null;
    return { done: true, value: undefined };
  }
  private resolveCompletion(): void {
    if (this.completionSettled) return;
    this.completionSettled = true;
    this.completionResolve();
  }
}
