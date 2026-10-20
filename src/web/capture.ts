import { sampleIndex, type SampleInput } from '../libhakei/sample-index.js';
import { PlanarSampleStore } from './data/planarStore.js';
import { RleSampleStore, type RleChannelData } from './data/rleStore.js';
import { ProceduralSampleStore } from './data/proceduralStore.js';
import { splitAroundGaps } from './data/gaps.js';
import type { GapSpan } from './data/types.js';
import { channelWidthForProbes, type ChannelCount } from './data/channel-count.js';
import { UIError, type MessageKey } from './i18n.js';
import type { WorkspaceSettings } from './workspace.js';
import { Transpose32Pipeline, type Pipeline32Backend } from './transpose32-pipeline.js';
import { AnalogSampleStore, ProceduralAnalogSampleStore, type AnalogStore } from './data/analogStore.js';
import { DemoDevice, type DemoPattern } from '../libhakei/demo.js';
import { createSampleChunk } from '../libhakei/index.js';
import { validateDeviceConfiguration, type AcquisitionChunk, type AcquisitionDescription, type DeviceConfiguration, type SampleDevice } from '../libhakei/device.js';

import { MemoryBudget, MemoryBudgetError, SampleAllocationError, DEFAULT_CAPTURE_BUDGET_BYTES, recoverableMemoryError, type BudgetSnapshot } from './memory.js';
import { WorkerSampleSource } from './acquisition-source.js';
import { SharedWorkerSampleStore } from './shared-sample-store.js';
export interface SharedCaptureConsumerSource { readonly allocatedBytes: number; readonly publishedSamples: bigint; readonly publisherMetrics?: { calls: number; bytes: number; totalMs: number; maxMs: number }; readonly h417TransportMetrics?: { reads: number; receivedBytes: number; parserMs: number; queuePeak: number; dataFrames: number }; readonly h417WorkerMetrics?: { packedCopyMs: number; bufferWaitMs: number; consumerWaitMs: number }; connectConsumer(port: MessagePort): void }
const VIRTUAL_DEMO_MIN_SAMPLES = 4_000_000;
export interface StageTiming { calls: number; totalMs: number; maxMs: number }
export interface CaptureDiagnostics {
  mainThreadAppend: StageTiming;
  mainThreadPublish: StageTiming;
  mainThreadUICallback: StageTiming;
  ui: Record<'captureRefresh' | 'captureLabels' | 'memoryRefresh' | 'decodeScheduling' | 'decodeFrames' | 'decodeAnnotations' | 'decodeUI', StageTiming>;
  store?: import('./data/planarStore.js').PlanarStoreTimings;
  h417Transport?: { reads: number; receivedBytes: number; parserMs: number; queuePeak: number; dataFrames: number };
  h417Worker?: { packedCopyMs: number; bufferWaitMs: number; consumerWaitMs: number };
  sharedPublisher?: { calls: number; bytes: number; totalMs: number; maxMs: number };
  sharedStorage?: { readerWaitMs: number; summaryMs: number; processCalls: number; queryMs: number; queryCalls: number; edgeMs: number; edgeCalls: number; packMs: number; packCalls: number; samples: bigint; groups: number };
  decodeWorker?: { sharedUnpackMs: number; decoderPushMs: number; runtimeBatchMs: number; outputPostMs: number; cooperativeYieldMs: number; cooperativeYieldCount: number };
  decodeMainThread?: { restoreTotalMs: number; restoreMaxMs: number; callbackTotalMs: number; callbackMaxMs: number; batchCount: number; frames: number; annotations: number };
}
export interface AcquisitionResult {
  targetSamples: bigint; actualSamples: bigint;
  stopReason: 'complete' | 'stopped' | 'budget' | 'allocation-failed' | 'store-limit' | 'error';
  error?: string;
  memory: BudgetSnapshot;
  worker: boolean; buffers: number; maxQueued: number;
}
export type Store = PlanarSampleStore | RleSampleStore | ProceduralSampleStore | SharedWorkerSampleStore;
export interface AnalogCaptureChannel { name: string; store: AnalogStore; pattern?: DemoPattern }
export interface Capture { diagnostics?: CaptureDiagnostics; acquisition?: AcquisitionResult; sharedSource?: SharedCaptureConsumerSource; name: string; nameKey?: MessageKey; store: Store; labels: string[]; triggerSample: bigint; loadedMs: number; logicChannelCount?: number; analogChannels?: AnalogCaptureChannel[]; workspace?: WorkspaceSettings }

const PACK_RANGE_LIMIT = 2 ** 26;
export function validRate(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new UIError('error.rate');
  return n;
}
export function validWidth(n: number): ChannelCount {
  if (![4, 8, 16, 32].includes(n)) throw new UIError('error.width');
  return n as ChannelCount;
}

export function channelStoreRange(store: Store, channel: number, start: bigint, end: bigint): Uint8Array {
  if (!Number.isInteger(channel) || channel < 0 || channel >= store.channelCount) throw new RangeError('invalid channel');
  if (start < 0n || end < start || end > store.length) throw new RangeError('invalid channel range');
  if (end - start > BigInt(PACK_RANGE_LIMIT)) throw new RangeError('channel range is too large');
  if ('channelRange' in store) return store.channelRange(channel, start, end);
  const output = new Uint8Array(Number(end - start));
  for (const [a, b] of splitAroundGaps(store.gaps(), start, end)) {
    let position = a, level = store.sampleAt(channel, a);
    for (const edge of store.edges(channel, a + 1n, b)) {
      const next = edge < b ? edge : b;
      if (level) output.fill(1, Number(position - start), Number(next - start));
      position = next; level ^= 1;
      if (position >= b) break;
    }
    if (position < b && level) output.fill(1, Number(position - start), Number(b - start));
  }
  return output;
}

export interface CaptureOptions {

  budgetBytes?: number;

  stopSignal?: AbortSignal;
  retainedBytes?: number;
  decodeReserveBytes?: number;
  displayReserveBytes?: number;
  worker?: 'auto' | 'off' | 'on';
  buffers?: 2 | 3;
  chunkSamples?: number;
  onProgress?: (samples: bigint, memory: BudgetSnapshot) => void;

  onCapture?: (capture: Capture) => void;
  onSharedSource?: (source: SharedCaptureConsumerSource) => void;

  allocateBuffer?: (bytes: number, label: string) => ArrayBuffer;
}
function capturePlan(device: SampleDevice, configuration: DeviceConfiguration, options: CaptureOptions) {
  const description: AcquisitionDescription = device.getAcquisitionDescription?.(configuration) ?? {
    layout: 'channel-arrays', logicSampleBytes: 8, analogSampleBytes: 8, chunkSamples: 65_536,
  };
  const chunkSamples = options.chunkSamples ?? (description.layout === 'packed-logic' && description.managedBuffers && configuration.sampleCount >= 262_144
    ? description.chunkSamples : Math.min(description.chunkSamples, configuration.sampleCount < 262_144 ? 16_384 : 65_536));
  if (!Number.isSafeInteger(chunkSamples) || chunkSamples < 1 || chunkSamples > 2 ** 26) throw new RangeError('Invalid acquisition block size');
  if (!['channel-arrays', 'packed-logic'].includes(description.layout) || ![1, 2, 4, 8].includes(description.logicSampleBytes)
    || description.layout === 'packed-logic' && description.logicSampleBytes !== 1 || ![4, 8].includes(description.analogSampleBytes)) throw new Error('Unsupported acquisition format');
  const worker = options.worker !== 'off' && typeof Worker !== 'undefined' && !!description.worker && !!description.managedBuffers
    && (description.worker?.required || options.worker === 'on' || configuration.sampleCount >= 262_144);
  if ((description.worker?.required || options.worker === 'on') && !worker) throw new Error('Acquisition Worker unavailable');
  const buffers = worker ? options.buffers ?? 2 : 1;
  if (![1, 2, 3].includes(buffers)) throw new RangeError('Acquisition requires two or three Worker buffers');
  if (!Number.isSafeInteger(description.workingBytes ?? 0) || (description.workingBytes ?? 0) < 0) throw new RangeError('Invalid driver scratch capacity');
  const bufferBytes = description.layout === 'packed-logic' ? chunkSamples * description.logicSampleBytes
    : Math.ceil(chunkSamples * configuration.logicChannels * description.logicSampleBytes / 8) * 8
      + chunkSamples * configuration.analogChannels * description.analogSampleBytes + 8;
  return { description, chunkSamples, worker, buffers, bufferBytes };
}

export function captureMemory(capture: Capture): { digitalBytes: number; analogBytes: number; totalBytes: number } {
  const digitalBytes = capture.store.memory().totalBytes;
  const analogBytes = (capture.analogChannels ?? []).reduce((sum, channel) => sum + channel.store.memory().totalBytes, 0);
  return { digitalBytes, analogBytes, totalBytes: digitalBytes + analogBytes };
}
export async function deviceCapture(device: SampleDevice, configuration: DeviceConfiguration, signal?: AbortSignal, options: CaptureOptions = {}): Promise<Capture> {
  signal?.throwIfAborted(); options.stopSignal?.throwIfAborted();
  const virtual = virtualDemoCapture(device, configuration, options);
  if (virtual) {
    options.onProgress?.(sampleIndex(configuration.sampleCount), virtual.acquisition!.memory);
    options.onCapture?.(virtual);
    signal?.throwIfAborted(); options.stopSignal?.throwIfAborted();
    return virtual;
  }
  const sourceSignal = signal && options.stopSignal ? AbortSignal.any([signal, options.stopSignal]) : signal ?? options.stopSignal;
  const plan = capturePlan(device, configuration, options);
  const budget = new MemoryBudget(options.budgetBytes ?? DEFAULT_CAPTURE_BUDGET_BYTES, options.allocateBuffer);
  const buffers: ArrayBuffer[] = [], release: (() => void)[] = [], releasePipelineMemory: (() => void)[] = [];
  let pipelineReleased = false;
  const releasePipeline = (): void => {
    if (pipelineReleased) return;
    pipelineReleased = true;
    for (const buffer of buffers) budget.release(buffer);
    buffers.length = 0;
    for (const free of releasePipelineMemory.reverse()) free();
  };
  let source: AsyncIterable<AcquisitionChunk> | null = null, result: Capture | null = null, workerUsed = plan.worker;
  let sharedSource: SharedCaptureConsumerSource | undefined;
  try {
    release.push(budget.reserve(options.retainedBytes ?? 0, 'retained capture and decode results'));
    release.push(budget.reserve(options.decodeReserveBytes ?? 0, 'decode workspace'));
    release.push(budget.reserve(options.displayReserveBytes ?? 0, 'display workspace'));
    releasePipelineMemory.push(budget.reserve(plan.description.workingBytes ?? 0, 'driver scratch'));
    if (plan.description.managedBuffers) {
      for (let index = 0; index < plan.buffers; index++) buffers.push(budget.allocate(plan.bufferBytes, 'acquisition buffer'));
    }
    if (workerUsed) {
      try { source = new WorkerSampleSource(plan.description, configuration, plan.chunkSamples, buffers, sourceSignal); }
      catch (error) {
        if (plan.description.worker?.required || options.worker === 'on') throw error;
        workerUsed = false;
        for (const buffer of buffers.splice(0)) budget.release(buffer);
        buffers.push(budget.allocate(plan.bufferBytes, 'acquisition buffer'));
      }
    }
    source ??= plan.description.layout === 'packed-logic'
      ? device.createPackedSource?.(configuration, { signal: sourceSignal, chunkSamples: plan.chunkSamples, ...(buffers.length ? { acquireBuffer: async () => buffers[0]! } : {}) })
        ?? (() => { throw new Error('Packed acquisition source unavailable'); })()
      : device.createSource(configuration, { signal: sourceSignal, chunkSamples: plan.chunkSamples, ...(buffers.length ? { acquireBuffer: async () => buffers[0]! } : {}) });
    if (source instanceof WorkerSampleSource) { sharedSource = source; options.onSharedSource?.(source); }
    const capture = source instanceof WorkerSampleSource && source.sharedCapture
      ? await captureSharedWorkerSource(source, device.descriptor.name, configuration, signal, options, budget)
      : await captureSampleSource(source, device.descriptor.name, signal, { ...options, budget, configuration, chunkSamples: plan.chunkSamples, trackSourceBuffers: !plan.description.managedBuffers, beforeFinalize: releasePipeline, onSharedSource: source => { sharedSource = source; options.onSharedSource?.(source); } });
    capture.sharedSource = sharedSource;
    if (capture.store.samplerate !== configuration.sampleRate || capture.logicChannelCount !== configuration.logicChannels || capture.analogChannels!.length !== configuration.analogChannels
      || (capture.acquisition!.stopReason === 'complete' && capture.store.length !== sampleIndex(configuration.sampleCount))) {
      if ('dispose' in capture.store && typeof capture.store.dispose === 'function') capture.store.dispose();
      for (const channel of capture.analogChannels ?? []) if (channel.store instanceof AnalogSampleStore) channel.store.dispose();
      throw new Error('Device capture does not match the requested configuration');
    }
    capture.acquisition!.worker = workerUsed; capture.acquisition!.buffers = workerUsed ? plan.buffers : 1;
    capture.acquisition!.maxQueued = source instanceof WorkerSampleSource ? source.maxQueued : 0;
    result = capture; return capture;
  } finally {
    if (source instanceof WorkerSampleSource) await source.return();
    releasePipeline();
    for (const free of release.reverse()) free();
    if (result?.acquisition) result.acquisition.memory = budget.snapshot();
  }
}

async function captureSharedWorkerSource(source: WorkerSampleSource, name: string, configuration: DeviceConfiguration,
  signal: AbortSignal | undefined, options: CaptureOptions, budget: MemoryBudget): Promise<Capture> {
  const started = performance.now();
  const store = new SharedWorkerSampleStore(source, configuration.logicChannels, configuration.sampleRate);
  const diagnostics: CaptureDiagnostics = {
    mainThreadAppend: { calls: 0, totalMs: 0, maxMs: 0 }, mainThreadPublish: { calls: 0, totalMs: 0, maxMs: 0 },
    mainThreadUICallback: { calls: 0, totalMs: 0, maxMs: 0 },
    ui: { captureRefresh: { calls: 0, totalMs: 0, maxMs: 0 }, captureLabels: { calls: 0, totalMs: 0, maxMs: 0 },
      memoryRefresh: { calls: 0, totalMs: 0, maxMs: 0 }, decodeScheduling: { calls: 0, totalMs: 0, maxMs: 0 },
      decodeFrames: { calls: 0, totalMs: 0, maxMs: 0 }, decodeAnnotations: { calls: 0, totalMs: 0, maxMs: 0 }, decodeUI: { calls: 0, totalMs: 0, maxMs: 0 } },
  };
  const targetSamples = sampleIndex(configuration.sampleCount);
  let stopReason: AcquisitionResult['stopReason'] = 'complete', detail: string | undefined;
  const capture: Capture = { name, sharedSource: source, diagnostics, labels: Array.from({ length: configuration.logicChannels }, (_, index) => `D${index}`),
    triggerSample: 0n, loadedMs: 0, logicChannelCount: configuration.logicChannels, analogChannels: [], store,
    acquisition: { targetSamples, actualSamples: 0n, stopReason, memory: budget.snapshot(), worker: true, buffers: 2, maxQueued: source.maxQueued } };
  const publish = (notifyProgress: boolean): void => {
    const samples = source.publishedSamples;
    capture.loadedMs = performance.now() - started;
    capture.acquisition = { targetSamples, actualSamples: samples, stopReason, ...(detail ? { error: detail } : {}),
      memory: budget.snapshot(), worker: true, buffers: 2, maxQueued: source.maxQueued };
    diagnostics.sharedPublisher = { ...source.publisherMetrics };
    if (source.h417TransportMetrics) diagnostics.h417Transport = { ...source.h417TransportMetrics };
    if (source.h417WorkerMetrics) diagnostics.h417Worker = { ...source.h417WorkerMetrics };
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
      throw new Error(detail ?? 'Device returned no samples');
    }
    if (stopReason === 'complete' && (source.publishedSamples !== targetSamples || stored.length !== targetSamples)) {
      stopReason = 'error'; detail = `Shared capture ended at ${stored.length} of ${targetSamples} samples`;
    }
    capture.loadedMs = performance.now() - started;
    capture.acquisition = { targetSamples, actualSamples: stored.length, stopReason, ...(detail ? { error: detail } : {}),
      memory: budget.snapshot(), worker: true, buffers: 2, maxQueued: source.maxQueued };
    diagnostics.sharedPublisher = { ...source.publisherMetrics };
    if (source.h417TransportMetrics) diagnostics.h417Transport = { ...source.h417TransportMetrics };
    if (source.h417WorkerMetrics) diagnostics.h417Worker = { ...source.h417WorkerMetrics };
    options.onProgress?.(source.publishedSamples, budget.snapshot());
    options.onCapture?.(capture);
    return capture;
  } catch (error) {
    store.dispose();
    throw error;
  } finally { source.onSharedProgress = null; store.onProgress = null; }
}

function virtualDemoCapture(device: SampleDevice, configuration: DeviceConfiguration, options: CaptureOptions): Capture | null {
  const started = performance.now();
  if (!(device instanceof DemoDevice) || configuration.sampleCount < VIRTUAL_DEMO_MIN_SAMPLES || options.worker === 'on' || options.allocateBuffer) return null;
  validateDeviceConfiguration(device, configuration);
  const logicPattern = configuration.options.logicPattern;
  const analogPattern = configuration.options.analogPattern;
  if (logicPattern !== 'square' && logicPattern !== 'clock') return null;
  if (configuration.analogChannels && analogPattern !== 'sine' && analogPattern !== 'square' && analogPattern !== 'triangle'
    && analogPattern !== 'sawtooth' && analogPattern !== 'constant') return null;
  const frequencyHz = Number(configuration.options.frequencyHz ?? 1_000);
  if (!(frequencyHz > 0) || !Number.isFinite(frequencyHz)) return null;
  const count = validWidth(configuration.logicChannels);
  const store = new ProceduralSampleStore({ channelCount: count, samplerate: configuration.sampleRate, length: configuration.sampleCount, frequencyHz });
  const analogChannels: AnalogCaptureChannel[] = Array.from({ length: configuration.analogChannels }, (_, index) => ({
    name: `A${index}`,
    pattern: analogPattern as DemoPattern,
    store: new ProceduralAnalogSampleStore({ samplerate: configuration.sampleRate, length: configuration.sampleCount,
      pattern: analogPattern as 'sine' | 'square' | 'triangle' | 'sawtooth' | 'constant', frequencyHz,
      amplitude: Number(configuration.options.amplitude ?? 1), offset: Number(configuration.options.offset ?? 0) }),
  }));
  const memory = captureMemory({ name: device.descriptor.name, store, labels: [], triggerSample: 0n, loadedMs: 0, logicChannelCount: configuration.logicChannels, analogChannels });
  const reserved = (options.retainedBytes ?? 0) + (options.decodeReserveBytes ?? 0) + (options.displayReserveBytes ?? 0);
  const limit = options.budgetBytes ?? DEFAULT_CAPTURE_BUDGET_BYTES;
  if (reserved + memory.totalBytes > limit) throw new MemoryBudgetError(reserved + memory.totalBytes, limit, 'procedural capture metadata');
  const capture: Capture = {
    name: device.descriptor.name,
    store,
    labels: Array.from({ length: configuration.logicChannels }, (_, index) => `D${index}`),
    triggerSample: 0n,
    loadedMs: performance.now() - started,
    logicChannelCount: configuration.logicChannels,
    analogChannels,
    acquisition: { targetSamples: sampleIndex(configuration.sampleCount), actualSamples: sampleIndex(configuration.sampleCount), stopReason: 'complete',
      memory: { limitBytes: limit, usedBytes: memory.totalBytes, peakBytes: reserved + memory.totalBytes, allocations: 0 },
      worker: false, buffers: 1, maxQueued: 0 },
  };
  return capture;
}

async function nextSample(iterator: AsyncIterator<AcquisitionChunk>, signal?: AbortSignal) {
  if (!signal) return iterator.next();
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([iterator.next(), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function captureSampleSource(source: AsyncIterable<AcquisitionChunk>, name: string, signal?: AbortSignal,
  options: CaptureOptions & { budget?: MemoryBudget; configuration?: DeviceConfiguration; chunkSamples?: number; trackSourceBuffers?: boolean; beforeFinalize?: () => void } = {}): Promise<Capture> {
  const started = performance.now(), budget = options.budget ?? new MemoryBudget(options.budgetBytes, options.allocateBuffer);
  let sampleRate = 0, length = 0n, store: PlanarSampleStore | null = null;
  let sharedSource: SharedCaptureConsumerSource | undefined;
  let logicIds: string[] = [], analogIds: string[] = [], analogStores: AnalogSampleStore[] = [];
  let stopReason: AcquisitionResult['stopReason'] = 'complete', detail: string | undefined;
  let releaseChunk: (() => void) | undefined;
  let padding: Uint8Array | null = null;
  let liveCapture: Capture | null = null;
  const publish = (): void => {
    if (!options.onCapture || !store || !length) return;
    const publishStarted = performance.now();
    store.refreshPyramid();
    liveCapture ??= { name, sharedSource, diagnostics, labels: logicIds, triggerSample: 0n, loadedMs: 0, logicChannelCount: logicIds.length,
      store, analogChannels: analogIds.map((id, index) => ({ name: id, store: analogStores[index]! })) };
    liveCapture.sharedSource = sharedSource;
    if (sharedSource?.publisherMetrics) diagnostics.sharedPublisher = { ...sharedSource.publisherMetrics };
    liveCapture.loadedMs = performance.now() - started;
    liveCapture.acquisition = { targetSamples: options.configuration ? sampleIndex(options.configuration.sampleCount) : length, actualSamples: length, stopReason,
      ...(detail ? { error: detail } : {}), memory: budget.snapshot(), worker: false, buffers: 1, maxQueued: 0 };
    diagnostics.store = store.timings;
    recordTiming(diagnostics.mainThreadPublish, performance.now() - publishStarted);
    const callbackStarted = performance.now();
    options.onCapture?.(liveCapture);
    recordTiming(diagnostics.mainThreadUICallback, performance.now() - callbackStarted);
  };
  const makeTiming = (): StageTiming => ({ calls: 0, totalMs: 0, maxMs: 0 });
  const diagnostics: CaptureDiagnostics = {
    mainThreadAppend: makeTiming(), mainThreadPublish: makeTiming(), mainThreadUICallback: makeTiming(),
    ui: { captureRefresh: makeTiming(), captureLabels: makeTiming(), memoryRefresh: makeTiming(), decodeScheduling: makeTiming(), decodeFrames: makeTiming(), decodeAnnotations: makeTiming(), decodeUI: makeTiming() },
  };
  const recordTiming = (timing: StageTiming, elapsed: number): void => { timing.calls++; timing.totalMs += elapsed; timing.maxMs = Math.max(timing.maxMs, elapsed); };
  const iterator = source[Symbol.asyncIterator]();
  if (source instanceof WorkerSampleSource) { sharedSource = source; options.onSharedSource?.(source); }
  const interruption = signal && options.stopSignal ? AbortSignal.any([signal, options.stopSignal]) : signal ?? options.stopSignal;
  const abort = (): void => { if (source instanceof WorkerSampleSource) void source.return(); };
  interruption?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    let lastYield = performance.now(), lastProgress = -Infinity;
    while (true) {
      releaseChunk?.(); releaseChunk = undefined;
      signal?.throwIfAborted();
      if (options.stopSignal?.aborted) { stopReason = 'stopped'; break; }
      let next: IteratorResult<AcquisitionChunk>;
      try { next = await nextSample(iterator, interruption); }
      catch (error) {
        signal?.throwIfAborted();
        if (options.stopSignal?.aborted) { stopReason = 'stopped'; break; }
        if (recoverableMemoryError(error) || !length) throw error;
        stopReason = 'error'; detail = error instanceof Error ? error.message : String(error); break;
      }
      signal?.throwIfAborted();
      if (options.stopSignal?.aborted) { stopReason = 'stopped'; break; }
      if (next.done) break;
      const input = next.value;
      let chunkLength: number;
      if ('format' in input) {
        if (input.format !== 'packed-logic' || input.encoding !== 'raw8' || !(input.data instanceof Uint8Array)
          || typeof input.startSample !== 'bigint' || input.startSample < 0n || !Number.isSafeInteger(input.sampleRate) || input.sampleRate < 1
          || !Number.isInteger(input.channelCount) || input.channelCount < 1 || input.channelCount > 8
          || !Number.isSafeInteger(input.length) || input.length < 1 || input.length > input.data.length) throw new Error('Invalid packed logic chunk');
        chunkLength = input.length;
        if (options.trackSourceBuffers !== false) releaseChunk = budget.reserve(input.data.buffer.byteLength, 'source chunk buffer');
        if (!sampleRate) {
          sampleRate = input.sampleRate; logicIds = Array.from({ length: input.channelCount }, (_, index) => `D${index}`); analogIds = [];
          store = new PlanarSampleStore({ channelCount: channelWidthForProbes(input.channelCount), samplerate: sampleRate, transpose32: 'js', deferPyramid: true, stagePacked: true, keepPacked: true, budget });
        }
        const config = options.configuration;
        if (input.sampleRate !== sampleRate || input.startSample !== length || input.channelCount !== logicIds.length
          || config && (sampleRate !== config.sampleRate || input.channelCount !== config.logicChannels || config.analogChannels !== 0 || input.startSample + BigInt(chunkLength) > config.sampleCount)) {
          throw new Error('Device sample rate, channel layout or sample continuity changed during capture');
        }
        if (options.chunkSamples && chunkLength > options.chunkSamples) throw new Error('Device exceeded its declared buffer capacity');
        const appendStarted = performance.now();
        store!.append(input.data.subarray(0, chunkLength));
        recordTiming(diagnostics.mainThreadAppend, performance.now() - appendStarted);
        if (input.h417Transport) diagnostics.h417Transport = { ...input.h417Transport };
        if (input.h417Worker) diagnostics.h417Worker = { ...input.h417Worker };
        if (sharedSource?.publisherMetrics) diagnostics.sharedPublisher = { ...sharedSource.publisherMetrics };
        diagnostics.store = store!.timings;
      } else {
        const chunk = createSampleChunk(input);
        chunkLength = chunk.length;
        if (options.trackSourceBuffers !== false) {
          const buffers = new Set<ArrayBufferLike>();
          for (const channels of [input.channels, input.analogChannels ?? {}, chunk.channels, chunk.analogChannels]) {
            for (const values of Object.values(channels)) if (ArrayBuffer.isView(values)) buffers.add(values.buffer);
          }
          releaseChunk = budget.reserve([...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0), 'source chunk buffers');
        }
        if (!sampleRate) {
          sampleRate = chunk.sampleRate; logicIds = Object.keys(chunk.channels); analogIds = Object.keys(chunk.analogChannels);
          store = new PlanarSampleStore({ channelCount: channelWidthForProbes(Math.max(1, logicIds.length)), samplerate: sampleRate, transpose32: 'js', budget });
          analogStores = analogIds.map(() => new AnalogSampleStore(sampleRate, budget));
        }
        if (chunk.sampleRate !== sampleRate || chunk.startSample !== length
          || Object.keys(chunk.channels).join('\0') !== logicIds.join('\0') || Object.keys(chunk.analogChannels).join('\0') !== analogIds.join('\0')) throw new Error('Device sample rate, channel layout or sample continuity changed during capture');
        const config = options.configuration;
        if (config && (sampleRate !== config.sampleRate || logicIds.length !== config.logicChannels || analogIds.length !== config.analogChannels || chunk.endSample > config.sampleCount)) throw new Error('Device capture does not match the requested configuration');
        if (options.chunkSamples && chunk.length > options.chunkSamples) throw new Error('Device exceeded its declared buffer capacity');
        for (const id of analogIds) {
          const values = chunk.analogChannels[id]!;
          if (!(values instanceof Float32Array)) for (let i = 0; i < values.length; i++) if (Math.abs(values[i]!) > 3.4028234663852886e38) throw new RangeError('Analog sample exceeds Float32 storage format');
        }
        const rollbacks: (() => void)[] = [];
        try {
          rollbacks.push(store!.prepareAppend(chunk.length));
          for (const analog of analogStores) rollbacks.push(analog.prepareAppend(chunk.length));
        } catch (error) { for (const rollback of rollbacks.reverse()) rollback(); throw error; }
        if (logicIds.length !== store!.channelCount && (!padding || padding.length < chunk.length)) {
          if (padding) budget.release(padding.buffer);
          padding = new Uint8Array(budget.allocate(chunk.length, 'padding channel'));
        }
        store!.appendChannels(Array.from({ length: store!.channelCount }, (_, i) => i < logicIds.length ? chunk.channels[logicIds[i]!]! : padding!.subarray(0, chunk.length)));
        analogIds.forEach((id, index) => analogStores[index]!.appendValidated(chunk.analogChannels[id]!));
      }
      length += BigInt(chunkLength);
      if (length === BigInt(chunkLength) || performance.now() - lastYield >= 8) {
        if (performance.now() - lastProgress >= 50 || (length === BigInt(chunkLength) && !liveCapture)) {
          const memory = budget.snapshot(); options.onProgress?.(length, memory); publish(); lastProgress = performance.now();
        }
        await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = performance.now(); signal?.throwIfAborted();
      }
    }
  } catch (error) {
    if (signal?.aborted) { store?.dispose(); for (const analog of analogStores) analog.dispose(); signal.throwIfAborted(); }
    if (recoverableMemoryError(error)) { stopReason = error instanceof MemoryBudgetError ? 'budget' : 'allocation-failed'; detail = error.message; }
    else { store?.dispose(); for (const analog of analogStores) analog.dispose(); throw error; }
  } finally {
    releaseChunk?.();
    if (padding) budget.release(padding.buffer);
    interruption?.removeEventListener('abort', abort);
    try {
      const close = iterator.return?.();
      if (interruption?.aborted) void Promise.resolve(close).catch(() => {}); else await close;
    } catch (error) {
      if (!signal?.aborted && length) { stopReason = 'error'; detail = error instanceof Error ? error.message : String(error); }
    }
    options.beforeFinalize?.();
  }
  if (!length || !store) { store?.dispose(); for (const analog of analogStores) analog.dispose();
    if (stopReason === 'stopped') options.stopSignal?.throwIfAborted();
    if (stopReason === 'allocation-failed') throw new SampleAllocationError(detail ?? 'first capture block', undefined);
    if (stopReason === 'budget') throw new MemoryBudgetError(0, budget.limitBytes - budget.snapshot().usedBytes, detail ?? 'first capture block');
    throw new Error(detail ?? 'Device returned no samples');
  }
  publish();
  store.finalizePyramid();
  const capture = liveCapture ?? { name, sharedSource, diagnostics, labels: logicIds, triggerSample: 0n, loadedMs: performance.now() - started, logicChannelCount: logicIds.length,
    store, analogChannels: analogIds.map((id, index) => ({ name: id, store: analogStores[index]! })),
    acquisition: { targetSamples: options.configuration ? sampleIndex(options.configuration.sampleCount) : length, actualSamples: length, stopReason, ...(detail ? { error: detail } : {}),
      memory: budget.snapshot(), worker: false, buffers: 1, maxQueued: 0 } };
  diagnostics.store = store.timings;
  capture.diagnostics = diagnostics;
  return capture;
}
export function parseAcquisitionResult(value: unknown, length: bigint): AcquisitionResult | undefined {
  if (value === undefined) return undefined;
  const source = value as AcquisitionResult;
  const result = source && {...source, targetSamples: sampleIndex(source.targetSamples), actualSamples: sampleIndex(source.actualSamples)};
  if (!result || result.targetSamples < length || result.actualSamples !== length
    || !['complete', 'stopped', 'budget', 'allocation-failed', 'store-limit', 'error'].includes(result.stopReason)
    || result.stopReason === 'complete' && result.targetSamples !== length
    || !result.memory || ![result.memory.limitBytes, result.memory.usedBytes, result.memory.peakBytes, result.memory.allocations].every(n => Number.isSafeInteger(n) && n >= 0)
    || result.memory.usedBytes > result.memory.peakBytes || result.memory.peakBytes > result.memory.limitBytes
    || typeof result.worker !== 'boolean' || !Number.isInteger(result.buffers) || result.buffers < 1 || result.buffers > 3
    || !Number.isInteger(result.maxQueued) || result.maxQueued < 0 || result.maxQueued > result.buffers
    || result.error !== undefined && typeof result.error !== 'string') throw new Error('Invalid acquisition metadata');
  return { targetSamples: result.targetSamples, actualSamples: result.actualSamples, stopReason: result.stopReason,
    memory: { ...result.memory }, worker: result.worker, buffers: result.buffers, maxQueued: result.maxQueued,
    ...(result.error ? { error: result.error.slice(0, 4096) } : {}) };
}
export function parseCapture(text: string, name = 'capture.hakei.json'): Capture {
  const t = performance.now(); let obj;
  try { obj = JSON.parse(text); } catch { throw new UIError('error.json'); }
  if (!obj || !['libhakei.capture/v1', 'libhakei.capture/v2'].includes(obj.format)) throw new UIError('error.format');
  const samplerate = validRate(obj.sampleRate), channelCount = validWidth(obj.channelCount), length = sampleIndex(obj.length);
  if (length < 1n) throw new UIError('error.length');
  if (!Array.isArray(obj.channels) || obj.channels.length !== channelCount) throw new UIError('error.channelCount');
  const channels: RleChannelData[] = obj.channels.map((c: { initial?: unknown; edges?: unknown }, index: number) => {
    if (!c || (c.initial !== 0 && c.initial !== 1) || !Array.isArray(c.edges)) throw new UIError('error.channel', { channel: index });
    let previous = 0n;
    for (const input of c.edges) {
      const edge = sampleIndex(input as SampleInput);
      if (edge <= previous || edge >= length) throw new UIError('error.edges', { channel: index });
      previous = edge;
    }
    return { initial: c.initial, edges: c.edges.map((value: SampleInput) => sampleIndex(value)) };
  });
  const triggerSample = sampleIndex(obj.triggerSample ?? 0n);
  if (triggerSample < 0 || triggerSample >= length) throw new UIError('error.trigger');
  if (obj.gaps !== undefined && !Array.isArray(obj.gaps)) throw new UIError('error.gapsArray');
  const gaps: GapSpan[] = (obj.gaps ?? []).map((g: GapSpan) => {
    if (!g || sampleIndex(g.endSample) <= sampleIndex(g.startSample) || sampleIndex(g.endSample) > length) throw new UIError('error.gaps');
    return { startSample: sampleIndex(g.startSample), endSample: sampleIndex(g.endSample) };
  });
  const labels = channels.map((_, i) => typeof obj.channels[i].name === 'string' ? obj.channels[i].name.slice(0, 80) : `D${i}`);
  const logicChannelCount = obj.logicChannelCount;
  if (logicChannelCount !== undefined && (!Number.isInteger(logicChannelCount) || logicChannelCount < 0 || logicChannelCount > channelCount)) throw new UIError('error.channelCount');
  return { name, ...(logicChannelCount === undefined ? {} : { logicChannelCount }), acquisition: parseAcquisitionResult(obj.acquisition, length), store: new RleSampleStore({ channelCount, samplerate, length, channels, gaps }), labels, triggerSample, loadedMs: performance.now() - t };
}
export interface CaptureImportPipelineOptions {

  backend?: Pipeline32Backend | 'auto';
  buffers?: number;
  workers?: number;
  chunkSamples?: number;
}

async function* binaryChunks(file: File, chunkBytes: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  let pending = file.slice(0, chunkBytes).arrayBuffer();
  void pending.catch(() => {});
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    signal?.throwIfAborted();
    const buffer = await pending; signal?.throwIfAborted();
    const next = offset + chunkBytes;
    if (next < file.size) {
      pending = file.slice(next, next + chunkBytes).arrayBuffer(); void pending.catch(() => {});
    }
    yield new Uint8Array(buffer);
  }
}
export async function importCapture(file: File, sampleRate: number, width: number,
  progress: (fraction: number) => void = () => {}, signal?: AbortSignal,
  pipelineOptions: CaptureImportPipelineOptions = {}): Promise<Capture> {
  const t = performance.now(); signal?.throwIfAborted();
  if (/\.sr$/i.test(file.name)) { const { importSR } = await import('./sr.js'); return importSR(file, progress, signal); }
  if (/\.json$/i.test(file.name)) {
    if (file.size > 64 * 1024 * 1024) throw new UIError('error.jsonLimit');
    const text = await file.text(); signal?.throwIfAborted();
    const capture = parseCapture(text, file.name); capture.loadedMs = performance.now() - t; return capture;
  }
  if (!/\.(bin|raw|dat)$/i.test(file.name)) throw new UIError('error.fileType');
  const channelCount = validWidth(width), samplerate = validRate(sampleRate), stride = Math.ceil(channelCount / 8);
  if (file.size === 0 || file.size % stride !== 0) throw new UIError('error.binaryLength', { stride });
  if (file.size > 256 * 1024 * 1024) throw new UIError('error.binaryLimit');
  const store = new PlanarSampleStore({ channelCount, samplerate });
  let pipe: Transpose32Pipeline | null = null;
  const chunkSamples = pipelineOptions.chunkSamples ?? 1_048_576;
  const backend = pipelineOptions.backend && pipelineOptions.backend !== 'auto' ? pipelineOptions.backend : store.transpose32Backend;
  const buffers = pipelineOptions.buffers ?? (backend === 'wasm-simd' || backend === 'webgpu' ? 2 : 3);
  const workers = pipelineOptions.workers ?? (backend === 'js' || backend === 'wasm-scalar'
    ? Math.min(buffers, (globalThis.navigator?.hardwareConcurrency ?? 4) > 2 ? 2 : 1) : 1);
  if (!Number.isSafeInteger(chunkSamples) || chunkSamples <= 0 || chunkSamples % 32) {
    throw new Error('Import pipeline chunkSamples must be a positive multiple of 32');
  }
  if (pipelineOptions.buffers !== undefined && (!Number.isInteger(pipelineOptions.buffers) || pipelineOptions.buffers < 1 || pipelineOptions.buffers > 8)) {
    throw new Error('Import pipeline buffers must be between 1 and 8');
  }
  if (pipelineOptions.workers !== undefined && (!Number.isInteger(pipelineOptions.workers) || pipelineOptions.workers < 1 || pipelineOptions.workers > buffers)) {
    throw new Error('Import pipeline workers must be between 1 and the buffer count');
  }
  const explicitPipeline = Object.keys(pipelineOptions).length > 0;
  if (channelCount === 32 && (file.size >= 4 * 1024 * 1024 || explicitPipeline)
    && (typeof Worker !== 'undefined' || pipelineOptions.backend === 'webgpu')) {
    try {
      pipe = await Transpose32Pipeline.create({backend, maxSamples: chunkSamples, buffers, workers});
    } catch (error) {
      if (pipelineOptions.backend && pipelineOptions.backend !== 'auto') throw error;
    }
  }
  if (channelCount === 32 && !pipe && pipelineOptions.backend && pipelineOptions.backend !== 'auto') {
    throw new Error('Explicit import pipeline requires Worker support');
  }
  const onAbort = (): void => pipe?.cancel(signal?.reason instanceof Error ? signal.reason : new Error('Import aborted'));
  signal?.addEventListener('abort', onAbort, {once: true});
  try {
    const chunkBytes = pipe ? chunkSamples * stride : 262144;
    for await (const chunk of binaryChunks(file, chunkBytes, signal)) {
      signal?.throwIfAborted();
      if (pipe) {
        await pipe.waitForSlot(); signal?.throwIfAborted();
        const aligned = Math.floor(chunk.byteLength / stride / 32) * 32;
        if (aligned) {
          void pipe.enqueue(new Uint32Array(chunk.buffer, chunk.byteOffset, aligned), planes => {
            store.appendTransposed32(planes); progress(Number(store.length * BigInt(stride)) / file.size);
          }).catch(() => {});
        }
        if (aligned * stride < chunk.byteLength) {
          await pipe.drain(); signal?.throwIfAborted();
          store.append(chunk.subarray(aligned * stride)); progress(Number(store.length * BigInt(stride)) / file.size);
        }
      } else {store.append(chunk); progress(Number(store.length * BigInt(stride)) / file.size);}
    }
    await pipe?.drain(); signal?.throwIfAborted();
  } catch (error) {
    pipe?.cancel(error instanceof Error ? error : new Error(String(error))); throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (pipe) {try {await pipe.drain();} catch {} pipe.dispose();}
  }
  return { name: file.name, store, labels: Array.from({ length: channelCount }, (_, i) => `D${i}`), triggerSample: 0n, loadedMs: performance.now() - t };
}
