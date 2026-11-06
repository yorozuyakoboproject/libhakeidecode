import type { DeviceControl, WorkerAcquisitionDescription } from './device-protocol.js';
import { sampleIndex } from '../libhakei/sample-index.js';
import type { PlanarSampleStore } from './data/planarStore.js';
import type { RleSampleStore } from './data/rleStore.js';
import { UIError, type MessageKey } from './i18n.js';
import type { WorkspaceSettings } from './workspace.js';
import type { Pipeline32Backend } from './transpose32-pipeline.js';
import type { AnalogStore } from './data/analogStore.js';
import type { DeviceConfiguration, DriverDiagnostics, TransferProgress } from '../libhakei/device.js';
import { deviceChannelIndices } from '../libhakei/device.js';

import { MemoryBudget, DEFAULT_CAPTURE_BUDGET_BYTES, type BudgetSnapshot } from './memory.js';
import { WorkerSampleSource } from './acquisition-source.js';
import { SharedWorkerSampleStore } from './shared-sample-store.js';
import { WorkerCaptureStore } from './worker-store.js';
export interface SharedCaptureConsumerSource {
  readonly allocatedBytes: number;
  readonly bytesPerSample: 1 | 2 | 3 | 4;
  readonly publishedSamples: bigint;
  readonly publisherMetrics?: { calls: number; bytes: number; totalMs: number; maxMs: number };
  readonly driverDiagnostics?: DriverDiagnostics;
  connectConsumer(port: MessagePort): void;
}
export interface StageTiming {
  calls: number;
  totalMs: number;
  maxMs: number;
}
export interface CaptureDiagnostics {
  mainThreadAppend: StageTiming;
  mainThreadPublish: StageTiming;
  mainThreadUICallback: StageTiming;
  ui: Record<'captureRefresh' | 'captureLabels' | 'memoryRefresh' | 'decodeScheduling', StageTiming>;
  store?: import('./data/planarStore.js').PlanarStoreTimings;
  driver?: DriverDiagnostics;
  sharedPublisher?: { calls: number; bytes: number; totalMs: number; maxMs: number };
  sharedStorage?: {
    readerWaitMs: number;
    summaryMs: number;
    processCalls: number;
    queryMs: number;
    queryCalls: number;
    edgeMs: number;
    edgeCalls: number;
    packMs: number;
    packCalls: number;
    samples: bigint;
    groups: number;
  };
  decodeWorker?: {
    sharedUnpackMs: number;
    decoderPushMs: number;
    runtimeBatchMs: number;
    outputPostMs: number;
    cooperativeYieldMs: number;
    cooperativeYieldCount: number;
  };
}
export interface AcquisitionResult {
  targetSamples: bigint;
  actualSamples: bigint;
  stopReason: 'complete' | 'stopped' | 'budget' | 'allocation-failed' | 'store-limit' | 'error';
  error?: string;
  memory: BudgetSnapshot;
  worker: boolean;
  buffers: number;
  maxQueued: number;
}
export type Store = PlanarSampleStore | RleSampleStore | SharedWorkerSampleStore | WorkerCaptureStore;
export interface AnalogCaptureChannel {
  name: string;
  store: AnalogStore;
}
export interface Capture {
  deviceChannels?: { driverId: string; logic: readonly number[]; analog: readonly number[] };
  diagnostics?: CaptureDiagnostics;
  acquisition?: AcquisitionResult;
  sharedSource?: SharedCaptureConsumerSource;
  name: string;
  nameKey?: MessageKey;
  store: Store;
  labels: string[];
  triggerSample: bigint;
  loadedMs: number;
  logicChannelCount?: number;
  analogChannels?: AnalogCaptureChannel[];
  workspace?: WorkspaceSettings;
}

export interface CaptureOptions {
  budgetBytes?: number;

  stopSignal?: AbortSignal;
  retainedBytes?: number;
  decodeReserveBytes?: number;
  displayReserveBytes?: number;
  buffers?: 2 | 3;
  chunkSamples?: number;
  onProgress?: (samples: bigint, memory: BudgetSnapshot) => void;
  onTransferProgress?: (progress: TransferProgress) => void;

  onCapture?: (capture: Capture) => void;
  onSharedSource?: (source: SharedCaptureConsumerSource) => void;

  allocateBuffer?: (bytes: number, label: string) => ArrayBuffer;
}
function capturePlan(
  description: WorkerAcquisitionDescription,
  configuration: DeviceConfiguration,
  options: CaptureOptions,
) {
  if (typeof Worker === 'undefined') throw new UIError('error.worker');
  const chunkSamples =
    options.chunkSamples ??
    (description.layout === 'packed-logic' && configuration.sampleCount >= 262_144
      ? description.chunkSamples
      : Math.min(description.chunkSamples, configuration.sampleCount < 262_144 ? 16_384 : 65_536));
  if (!Number.isSafeInteger(chunkSamples) || chunkSamples < 1 || chunkSamples > 2 ** 26)
    throw new RangeError('Invalid acquisition block size');
  if (
    !['channel-arrays', 'packed-logic', 'multi-rate'].includes(description.layout) ||
    ![1, 2, 3, 4, 8].includes(description.logicSampleBytes) ||
    ![4, 8].includes(description.analogSampleBytes)
  )
    throw new Error('Unsupported acquisition format');
  const buffers = options.buffers ?? 2;
  if (![2, 3].includes(buffers)) throw new RangeError('Acquisition requires two or three Worker buffers');
  if (!Number.isSafeInteger(description.workingBytes ?? 0) || (description.workingBytes ?? 0) < 0)
    throw new RangeError('Invalid driver scratch capacity');
  const bufferBytes =
    description.layout === 'packed-logic'
      ? chunkSamples * description.logicSampleBytes
      : Math.ceil((chunkSamples * configuration.logicChannels * description.logicSampleBytes) / 8) * 8 +
        chunkSamples * configuration.analogChannels * description.analogSampleBytes +
        8;
  return { description, chunkSamples, buffers, bufferBytes };
}

export function captureMemory(capture: Capture): { digitalBytes: number; analogBytes: number; totalBytes: number } {
  const digitalBytes = capture.store.memory().totalBytes;
  const analogBytes = (capture.analogChannels ?? []).reduce(
    (sum, channel) => sum + channel.store.memory().totalBytes,
    0,
  );
  return { digitalBytes, analogBytes, totalBytes: digitalBytes + analogBytes };
}
export async function deviceCapture(
  device: DeviceControl,
  configuration: DeviceConfiguration,
  signal?: AbortSignal,
  options: CaptureOptions = {},
): Promise<Capture> {
  signal?.throwIfAborted();
  options.stopSignal?.throwIfAborted();
  const sourceSignal =
    signal && options.stopSignal ? AbortSignal.any([signal, options.stopSignal]) : (signal ?? options.stopSignal);
  const plan = capturePlan(await device.prepare(configuration), configuration, options);
  sourceSignal?.throwIfAborted();
  const budget = new MemoryBudget(options.budgetBytes ?? DEFAULT_CAPTURE_BUDGET_BYTES, options.allocateBuffer);
  const buffers: ArrayBuffer[] = [],
    release: (() => void)[] = [],
    releasePipelineMemory: (() => void)[] = [];
  let pipelineReleased = false;
  const releasePipeline = (): void => {
    if (pipelineReleased) return;
    pipelineReleased = true;
    for (const buffer of buffers) budget.release(buffer);
    buffers.length = 0;
    for (const free of releasePipelineMemory.reverse()) free();
  };
  let source: WorkerSampleSource | null = null,
    result: Capture | null = null;
  let sharedSource: SharedCaptureConsumerSource | undefined;
  try {
    release.push(budget.reserve(options.retainedBytes ?? 0, 'retained capture and decode results'));
    release.push(budget.reserve(options.decodeReserveBytes ?? 0, 'decode workspace'));
    release.push(budget.reserve(options.displayReserveBytes ?? 0, 'display workspace'));
    releasePipelineMemory.push(budget.reserve(plan.description.workingBytes ?? 0, 'driver scratch'));
    for (let index = 0; index < plan.buffers; index++)
      buffers.push(budget.allocate(plan.bufferBytes, 'acquisition buffer'));
    source = new WorkerSampleSource(
      plan.description,
      configuration,
      plan.chunkSamples,
      buffers,
      sourceSignal,
      plan.description.layout !== 'packed-logic',
    );
    source.onTransferProgress = options.onTransferProgress;
    if (source.sharedCapture) {
      sharedSource = source;
      options.onSharedSource?.(source);
    }
    const capture = source.sharedCapture
      ? await captureSharedWorkerSource(source, device.descriptor.name, configuration, signal, options, budget)
      : await captureLocalWorkerSource(source, device.descriptor.name, configuration, signal, options);
    capture.sharedSource = sharedSource;
    if (
      capture.store.samplerate !== configuration.sampleRate ||
      capture.logicChannelCount !== configuration.logicChannels ||
      capture.analogChannels!.length !== configuration.analogChannels ||
      (capture.acquisition!.stopReason === 'complete' &&
        capture.store.length !== sampleIndex(configuration.sampleCount))
    ) {
      if ('dispose' in capture.store && typeof capture.store.dispose === 'function') capture.store.dispose();
      throw new Error('Device capture does not match the requested configuration');
    }
    capture.acquisition!.buffers = plan.buffers;
    capture.acquisition!.maxQueued = source.maxQueued;
    result = capture;
    return capture;
  } finally {
    if (source && result?.store !== source.captureStore) await source.return();
    releasePipeline();
    for (const free of release.reverse()) free();
    if (result?.acquisition) result.acquisition.memory = budget.snapshot();
  }
}

async function captureSharedWorkerSource(
  source: WorkerSampleSource,
  name: string,
  configuration: DeviceConfiguration,
  signal: AbortSignal | undefined,
  options: CaptureOptions,
  budget: MemoryBudget,
): Promise<Capture> {
  const started = performance.now();
  const labels = deviceChannelIndices(configuration, 'logic').map((index) => 'D' + index);
  const store = new SharedWorkerSampleStore(
    source,
    configuration.logicChannels,
    configuration.sampleRate,
    labels,
    source.logicSampleBytes,
  );
  const diagnostics: CaptureDiagnostics = {
    mainThreadAppend: { calls: 0, totalMs: 0, maxMs: 0 },
    mainThreadPublish: { calls: 0, totalMs: 0, maxMs: 0 },
    mainThreadUICallback: { calls: 0, totalMs: 0, maxMs: 0 },
    ui: {
      captureRefresh: { calls: 0, totalMs: 0, maxMs: 0 },
      captureLabels: { calls: 0, totalMs: 0, maxMs: 0 },
      memoryRefresh: { calls: 0, totalMs: 0, maxMs: 0 },
      decodeScheduling: { calls: 0, totalMs: 0, maxMs: 0 },
    },
  };
  const targetSamples = sampleIndex(configuration.sampleCount);
  let stopReason: AcquisitionResult['stopReason'] = 'complete',
    detail: string | undefined;
  const capture: Capture = {
    deviceChannels: source.channelSelection,
    name,
    sharedSource: source,
    diagnostics,
    labels,
    triggerSample: 0n,
    loadedMs: 0,
    logicChannelCount: configuration.logicChannels,
    analogChannels: [],
    store,
    acquisition: {
      targetSamples,
      actualSamples: 0n,
      stopReason,
      memory: budget.snapshot(),
      worker: true,
      buffers: 2,
      maxQueued: source.maxQueued,
    },
  };
  const publish = (notifyProgress: boolean): void => {
    const samples = source.publishedSamples;
    capture.loadedMs = performance.now() - started;
    capture.acquisition = {
      targetSamples,
      actualSamples: samples,
      stopReason,
      ...(detail ? { error: detail } : {}),
      memory: budget.snapshot(),
      worker: true,
      buffers: 2,
      maxQueued: source.maxQueued,
    };
    diagnostics.sharedPublisher = { ...source.publisherMetrics };
    diagnostics.driver = source.driverDiagnostics;
    if (notifyProgress && samples > 0n) options.onProgress?.(samples, budget.snapshot());
    options.onCapture?.(capture);
  };
  source.onSharedProgress = () => publish(true);
  store.onProgress = () => publish(false);
  publish(false);
  try {
    await source.waitForCompletion();
    const stored = await store.finishStorage();
    diagnostics.sharedStorage = stored.metrics;
    if (signal?.aborted) signal.throwIfAborted();
    if (options.stopSignal?.aborted) stopReason = 'stopped';
    else if (source.errorMessage || stored.state === 'error') {
      detail = source.errorMessage ?? stored.error ?? 'Shared storage Worker failed';
      stopReason = /allocation|out of memory|shared chunk/i.test(detail) ? 'allocation-failed' : 'error';
    } else if (stored.state === 'stopped') stopReason = 'stopped';
    if (stored.length === 0n) {
      store.dispose();
      throw source.errorValue ?? new Error(detail ?? 'Device returned no samples');
    }
    if (stopReason === 'complete' && (source.publishedSamples !== targetSamples || stored.length !== targetSamples)) {
      stopReason = 'error';
      detail = `Shared capture ended at ${stored.length} of ${targetSamples} samples`;
    }
    capture.loadedMs = performance.now() - started;
    capture.acquisition = {
      targetSamples,
      actualSamples: stored.length,
      stopReason,
      ...(detail ? { error: detail } : {}),
      memory: budget.snapshot(),
      worker: true,
      buffers: 2,
      maxQueued: source.maxQueued,
    };
    diagnostics.sharedPublisher = { ...source.publisherMetrics };
    diagnostics.driver = source.driverDiagnostics;
    options.onProgress?.(source.publishedSamples, budget.snapshot());
    options.onCapture?.(capture);
    return capture;
  } catch (error) {
    store.dispose();
    throw error;
  } finally {
    source.onSharedProgress = null;
    store.onProgress = null;
  }
}

async function captureLocalWorkerSource(
  source: WorkerSampleSource,
  name: string,
  configuration: DeviceConfiguration,
  signal: AbortSignal | undefined,
  options: CaptureOptions,
): Promise<Capture> {
  const started = performance.now(),
    store = source.captureStore!;
  const diagnostics: CaptureDiagnostics = {
    mainThreadAppend: { calls: 0, totalMs: 0, maxMs: 0 },
    mainThreadPublish: { calls: 0, totalMs: 0, maxMs: 0 },
    mainThreadUICallback: { calls: 0, totalMs: 0, maxMs: 0 },
    ui: {
      captureRefresh: { calls: 0, totalMs: 0, maxMs: 0 },
      captureLabels: { calls: 0, totalMs: 0, maxMs: 0 },
      memoryRefresh: { calls: 0, totalMs: 0, maxMs: 0 },
      decodeScheduling: { calls: 0, totalMs: 0, maxMs: 0 },
    },
  };
  const targetSamples = sampleIndex(configuration.sampleCount);
  let stopReason: AcquisitionResult['stopReason'] = 'complete',
    detail: string | undefined;
  const labels = deviceChannelIndices(configuration, 'logic').map((index) => `D${index}`);
  const analogChannels: AnalogCaptureChannel[] = store.analogStores.map((analog, index) => ({
    name: `A${deviceChannelIndices(configuration, 'analog')[index]}`,
    store: analog,
  }));
  const capture: Capture = {
    deviceChannels: source.channelSelection,
    name,
    diagnostics,
    labels,
    triggerSample: 0n,
    loadedMs: 0,
    logicChannelCount: configuration.logicChannels,
    analogChannels,
    store,
    acquisition: {
      targetSamples,
      actualSamples: 0n,
      stopReason,
      memory: source.localMemorySnapshot,
      worker: true,
      buffers: 2,
      maxQueued: 0,
    },
  };
  const publish = (notifyProgress: boolean): void => {
    const metadata = store.metadata;
    if (metadata.labels.length) capture.labels = [...metadata.labels];
    if (metadata.logicChannelCount !== undefined) capture.logicChannelCount = metadata.logicChannelCount;
    for (let index = 0; index < analogChannels.length; index++)
      analogChannels[index]!.name = metadata.analog[index]?.name ?? `A${index}`;
    const samples = source.localLengthValue;
    capture.loadedMs = performance.now() - started;
    capture.acquisition = {
      targetSamples,
      actualSamples: samples,
      stopReason,
      ...(detail ? { error: detail } : {}),
      memory: source.localMemorySnapshot,
      worker: true,
      buffers: 2,
      maxQueued: source.maxQueued,
    };
    diagnostics.driver = source.driverDiagnostics;
    if (notifyProgress && samples > 0n) options.onProgress?.(samples, source.localMemorySnapshot);
    options.onCapture?.(capture);
  };
  source.onLocalProgress = () => publish(true);
  publish(false);
  try {
    await source.waitForCompletion();
    const result = source.localResult;
    if (signal?.aborted) signal.throwIfAborted();
    if (!result) throw new Error(source.errorMessage ?? 'Acquisition Worker returned no capture result');
    if (options.stopSignal?.aborted && result.stopReason !== 'error') stopReason = 'stopped';
    else if (source.errorMessage || result.stopReason === 'error') {
      detail = source.errorMessage ?? result.error ?? 'Capture storage Worker failed';
      stopReason = /allocation|out of memory|memory limit/i.test(detail) ? 'allocation-failed' : 'error';
    } else if (result.stopReason === 'stopped') stopReason = 'stopped';
    if (result.length === 0n) throw source.errorValue ?? new Error(detail ?? 'Device returned no samples');
    if (stopReason === 'complete' && result.length !== targetSamples) {
      stopReason = 'error';
      detail = `Capture ended at ${result.length} of ${targetSamples} samples`;
    }
    capture.loadedMs = performance.now() - started;
    capture.acquisition = {
      targetSamples,
      actualSamples: result.length,
      stopReason,
      ...(detail ? { error: detail } : {}),
      memory: { ...result.memory },
      worker: true,
      buffers: 2,
      maxQueued: source.maxQueued,
    };
    diagnostics.store = result.timings;
    publish(false);
    options.onProgress?.(result.length, { ...result.memory });
    return capture;
  } catch (error) {
    store.dispose();
    throw error;
  } finally {
    source.onLocalProgress = null;
  }
}

export interface CaptureImportPipelineOptions {
  backend?: Pipeline32Backend | 'auto';
  buffers?: number;
  workers?: number;
  chunkSamples?: number;
}

export async function importCapture(
  file: File,
  sampleRate: number,
  width: number,
  progress: (fraction: number) => void = () => {},
  signal?: AbortSignal,
  pipelineOptions: CaptureImportPipelineOptions = {},
): Promise<Capture> {
  if (typeof Worker === 'undefined') throw new UIError('error.worker');
  const { importCaptureWorker } = await import('./capture-import-client.js');
  return importCaptureWorker(file, sampleRate, width, progress, signal, pipelineOptions);
}
