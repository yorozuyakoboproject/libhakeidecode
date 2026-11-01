import { componentFailure, type ComponentFailure } from '../components.js';
import {
  validateDeviceConfiguration,
  deviceChannelIndices,
  type AcquisitionChunk,
  type DeviceConfiguration,
  type DriverDiagnostics,
  type ManagedSampleSourceContext,
  type TransferProgress,
} from '../libhakei/device.js';
import { createDriverDevice } from '../drivers/workers.js';
import { createSampleChunk } from '../libhakei/index.js';
import type { SharedChunkProducer, SharedPublisherMetrics } from './shared-chunks.js';
import type { SharedChunkAllocator } from './shared-chunk-allocator.js';
import { PlanarSampleStore, type PlanarStoreTimings } from './data/planarStore.js';
import { AnalogSampleStore } from './data/analogStore.js';
import { channelWidthForProbes } from './data/channel-count.js';
import { DEFAULT_CAPTURE_BUDGET_BYTES, MemoryBudget, type BudgetSnapshot } from './memory.js';
import { WorkerStoreServer } from './worker-store-server.js';
import { yieldWorkerTask } from './worker-task.js';
import type { StoreMetadata } from './worker-store.js';
import { MultiRateCapture } from './multirate-capture.js';
export type AcquisitionRequest =
  | {
      type: 'start';
      driverId: string;
      initialization?: unknown;
      configuration: DeviceConfiguration;
      chunkSamples: number;
      buffers: ArrayBuffer[];
      sharedSampleCount?: bigint;
      sharedChunkBytes?: number;
      store?: { budgetBytes: number };
      storePort?: MessagePort;
    }
  | { type: 'subscribe'; port: MessagePort }
  | { type: 'recycle'; buffer: ArrayBuffer }
  | { type: 'stop' };
export type AcquisitionResponse =
  | { type: 'transfer-progress'; progress: TransferProgress }
  | { type: 'chunk'; chunk: AcquisitionChunk; buffer: ArrayBuffer }
  | { type: 'local-progress'; length: bigint; memory: BudgetSnapshot; driverDiagnostics?: DriverDiagnostics }
  | {
      type: 'local-done';
      metadata: StoreMetadata;
      length: bigint;
      memory: BudgetSnapshot;
      stopReason: 'complete' | 'stopped' | 'error';
      error?: string;
      timings?: PlanarStoreTimings;
      driverDiagnostics?: DriverDiagnostics;
    }
  | {
      type: 'shared-progress';
      allocatedBytes: number;
      publishedSamples: bigint;
      publisher?: SharedPublisherMetrics;
      driverDiagnostics?: DriverDiagnostics;
    }
  | { type: 'done' }
  | ({ type: 'error' } & ComponentFailure)
  | { type: 'closed' };
type Scope = {
  onmessage: ((event: MessageEvent<AcquisitionRequest>) => void) | null;
  postMessage(message: AcquisitionResponse, transfer?: Transferable[]): void;
};
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
    controller.abort();
    waiter?.reject(controller.signal.reason);
    waiter = null;
    return;
  }
  if (data.type === 'subscribe') {
    if (producer) producer.addConsumer(data.port);
    else pendingConsumers.push(data.port);
    return;
  }
  if (data.type === 'recycle') {
    if (waiter) {
      const { resolve } = waiter;
      waiter = null;
      resolve(data.buffer);
    } else available.push(data.buffer);
    return;
  }
  if (started) return;
  started = true;
  available.push(...data.buffers);
  void (async () => {
    let iterator: AsyncIterator<AcquisitionChunk> | undefined;
    let terminal: 'complete' | 'stopped' | 'error' = 'complete';
    let failure: ComponentFailure = { message: '' };
    let driverDiagnostics: DriverDiagnostics | undefined;
    let store: PlanarSampleStore | null = null,
      analogStores: AnalogSampleStore[] = [];
    let multiRate: MultiRateCapture | null = null;
    let logicIds: string[] = [],
      analogIds: string[] = [],
      padding: Uint8Array | null = null;
    const budget = data.store ? new MemoryBudget(data.store.budgetBytes ?? DEFAULT_CAPTURE_BUDGET_BYTES) : null;
    let lastProgressAt = -Infinity;
    const storeServer = data.store
      ? new WorkerStoreServer(
          () =>
            multiRate ??
            (store
              ? {
                  store,
                  labels: logicIds,
                  logicChannelCount: logicIds.length,
                  analogChannels: analogIds.map((id, index) => ({ name: id, store: analogStores[index]! })),
                }
              : null),
        )
      : null;
    const appendChunk = (input: AcquisitionChunk): number => {
      if (multiRate) {
        multiRate.append(input);
        return 0;
      }
      if ('format' in input) {
        if (
          input.format !== 'packed-logic' ||
          input.encoding !== 'raw8' ||
          !(input.data instanceof Uint8Array) ||
          typeof input.startSample !== 'bigint' ||
          input.startSample < 0n ||
          !Number.isSafeInteger(input.sampleRate) ||
          input.sampleRate < 1 ||
          !Number.isInteger(input.channelCount) ||
          input.channelCount < 1 ||
          input.channelCount > 8 ||
          !Number.isSafeInteger(input.length) ||
          input.length < 1 ||
          input.length > input.data.length
        )
          throw new Error('Invalid packed logic chunk');
        if (!store) {
          logicIds = deviceChannelIndices(data.configuration, 'logic').map((index) => `D${index}`);
          analogIds = [];
          store = new PlanarSampleStore({
            channelCount: channelWidthForProbes(input.channelCount),
            samplerate: input.sampleRate,
            transpose32: 'js',
            deferPyramid: true,
            stagePacked: true,
            keepPacked: true,
            ...(budget ? { budget } : {}),
          });
          storeServer?.connect(data.storePort!);
        }
        const config = data.configuration;
        if (
          input.sampleRate !== store.samplerate ||
          input.startSample !== store.length ||
          input.channelCount !== logicIds.length ||
          input.sampleRate !== config.sampleRate ||
          input.channelCount !== config.logicChannels ||
          config.analogChannels !== 0 ||
          input.startSample + BigInt(input.length) > config.sampleCount
        )
          throw new Error('Device sample rate, channel layout or sample continuity changed during capture');
        if (input.length > data.chunkSamples) throw new Error('Device exceeded its declared buffer capacity');
        store.append(input.data.subarray(0, input.length));
        return input.length;
      }
      const chunk = createSampleChunk(input);
      if (!store) {
        logicIds = Object.keys(chunk.channels);
        analogIds = Object.keys(chunk.analogChannels);
        store = new PlanarSampleStore({
          channelCount: channelWidthForProbes(Math.max(1, logicIds.length)),
          samplerate: chunk.sampleRate,
          transpose32: 'js',
          ...(budget ? { budget } : {}),
        });
        analogStores = analogIds.map(() => new AnalogSampleStore(chunk.sampleRate, budget ?? undefined));
        storeServer?.connect(data.storePort!);
      }
      if (
        chunk.sampleRate !== store.samplerate ||
        chunk.startSample !== store.length ||
        Object.keys(chunk.channels).join('\0') !== logicIds.join('\0') ||
        Object.keys(chunk.analogChannels).join('\0') !== analogIds.join('\0')
      )
        throw new Error('Device sample rate, channel layout or sample continuity changed during capture');
      const config = data.configuration;
      if (
        chunk.sampleRate !== config.sampleRate ||
        logicIds.length !== config.logicChannels ||
        analogIds.length !== config.analogChannels ||
        logicIds.join('\0') !==
          deviceChannelIndices(config, 'logic')
            .map((index) => `D${index}`)
            .join('\0') ||
        analogIds.join('\0') !==
          deviceChannelIndices(config, 'analog')
            .map((index) => `A${index}`)
            .join('\0') ||
        chunk.endSample > config.sampleCount
      )
        throw new Error('Device capture does not match the requested configuration');
      if (chunk.length > data.chunkSamples) throw new Error('Device exceeded its declared buffer capacity');
      for (const id of analogIds) {
        const values = chunk.analogChannels[id]!;
        if (!(values instanceof Float32Array))
          for (let index = 0; index < values.length; index++)
            if (Math.abs(values[index]!) > 3.4028234663852886e38)
              throw new RangeError('Analog sample exceeds Float32 storage format');
      }
      const rollbacks: (() => void)[] = [];
      try {
        rollbacks.push(store.prepareAppend(chunk.length));
        for (const analog of analogStores) rollbacks.push(analog.prepareAppend(chunk.length));
      } catch (error) {
        for (const rollback of rollbacks.reverse()) rollback();
        throw error;
      }
      if (logicIds.length !== store.channelCount && (!padding || padding.length < chunk.length)) {
        if (padding) budget?.release(padding.buffer);
        padding = new Uint8Array(
          budget ? budget.allocate(chunk.length, 'padding channel') : new ArrayBuffer(chunk.length),
        );
      }
      const emptyChannel = padding?.subarray(0, chunk.length);
      store.appendChannels(
        Array.from({ length: store.channelCount }, (_, index) =>
          index < logicIds.length ? chunk.channels[logicIds[index]!]! : emptyChannel!,
        ),
      );
      analogIds.forEach((id, index) => analogStores[index]!.appendValidated(chunk.analogChannels[id]!));
      return chunk.length;
    };
    const reportLocal = (force = false): void => {
      if ((!store && !multiRate) || !budget || !storeServer) return;
      const now = performance.now();
      if (!force && now - lastProgressAt < 100) return;
      lastProgressAt = now;
      storeServer.publish();
      scope.postMessage({
        type: 'local-progress',
        length: (multiRate?.store ?? store!).length,
        memory: budget.snapshot(),
        driverDiagnostics,
      });
    };
    try {
      if (data.sharedSampleCount !== undefined) {
        const [{ SharedChunkProducer }, { SharedChunkAllocator }] = await Promise.all([
          import('./shared-chunks.js'),
          import('./shared-chunk-allocator.js'),
        ]);
        allocator = new SharedChunkAllocator();
        let lastProgressAt = -Infinity,
          lastReportedSamples = 0n;
        const reportSharedProgress = (
          allocatedBytes: number,
          publishedSamples: bigint,
          publisher: SharedPublisherMetrics,
          force = false,
        ): void => {
          const now = performance.now();
          if (
            force ||
            (publishedSamples > 0n && lastReportedSamples === 0n) ||
            now - lastProgressAt >= 100 ||
            publishedSamples === data.sharedSampleCount
          ) {
            lastProgressAt = now;
            lastReportedSamples = publishedSamples;
            scope.postMessage({
              type: 'shared-progress',
              allocatedBytes,
              publishedSamples,
              publisher,
              driverDiagnostics,
            });
          }
        };
        producer = new SharedChunkProducer({
          sampleCount: data.sharedSampleCount,
          chunkBytes: data.sharedChunkBytes,
          allocate: (byteLength) => allocator!.allocate(byteLength),
          onProgress: (bytes, samples, publisher) => reportSharedProgress(bytes, samples, publisher),
        });
        for (const port of pendingConsumers.splice(0)) producer.addConsumer(port);
        await producer.prepare();
        reportSharedProgress(producer.allocatedBytes, producer.length, producer.publisherMetrics, true);
      }
      controller.signal.throwIfAborted();
      const device = createDriverDevice(data.driverId, data.initialization);
      validateDeviceConfiguration(device, data.configuration);
      const description = device.getAcquisitionDescription(data.configuration);
      if (!!producer !== (description.layout === 'packed-logic'))
        throw new Error('Driver acquisition layout does not match the capture pipeline');
      if (description.layout === 'multi-rate') {
        if (!budget || !storeServer || !data.storePort)
          throw new Error('Multi-rate acquisition requires Worker storage');
        multiRate = new MultiRateCapture(data.configuration, budget);
        storeServer.connect(data.storePort);
      }
      let borrowed: ArrayBuffer | null = null;
      const context: ManagedSampleSourceContext = {
        signal: controller.signal,
        chunkSamples: data.chunkSamples,
        reportDiagnostics: (snapshot) => {
          driverDiagnostics = { ...snapshot };
        },
        reportTransferProgress: (progress) => scope.postMessage({ type: 'transfer-progress', progress }),
        acquireBuffer: async () => {
          controller.signal.throwIfAborted();
          return (borrowed =
            available.shift() ??
            (await new Promise<ArrayBuffer>((resolve, reject) => {
              waiter = { resolve, reject };
            })));
        },
      };
      iterator = (
        description.layout === 'multi-rate' && device.layout === 'multi-rate'
          ? device.createMultiRateSource(data.configuration, context)
          : device.layout !== 'channel-arrays'
            ? device.createPackedSource(data.configuration, context)
            : device.createSource(data.configuration, context)
      )[Symbol.asyncIterator]();
      let lastYield = performance.now();
      while (true) {
        controller.signal.throwIfAborted();
        const result = await iterator.next();
        if (result.done) {
          controller.signal.throwIfAborted();
          break;
        }
        const timeline = 'format' in result.value && result.value.format === 'timeline';
        if (!borrowed && !timeline) throw new Error('Worker driver must use the managed buffer contract');
        if (producer && 'format' in result.value && result.value.format === 'packed-logic') {
          await producer.append(result.value.data.subarray(0, result.value.length));
        } else if (data.store) {
          appendChunk(result.value);
          reportLocal();
        }
        const buffer = borrowed;
        borrowed = null;
        if (buffer) {
          if (producer || data.store) {
            available.push(buffer);
          } else {
            scope.postMessage({ type: 'chunk', chunk: result.value, buffer }, [buffer]);
          }
        }
        if (performance.now() - lastYield >= 8) {
          await yieldWorkerTask();
          controller.signal.throwIfAborted();
          lastYield = performance.now();
        }
      }
      if (producer && producer.length !== data.sharedSampleCount)
        throw new Error(`Shared capture ended at ${producer.length} of ${data.sharedSampleCount} samples`);
    } catch (error) {
      if (controller.signal.aborted) terminal = 'stopped';
      else {
        terminal = 'error';
        failure = componentFailure(error);
      }
    } finally {
      try {
        await iterator?.return?.();
      } catch (error) {
        if (terminal !== 'stopped') {
          terminal = 'error';
          failure = componentFailure(error);
        }
      }
      if (producer?.state === 'open') producer.finish(terminal, failure.message || undefined);
      if (producer)
        scope.postMessage({
          type: 'shared-progress',
          allocatedBytes: producer.allocatedBytes,
          publishedSamples: producer.length,
          publisher: producer.publisherMetrics,
          driverDiagnostics,
        });
      allocator?.close();
      allocator = null;
      const finalStore = store as PlanarSampleStore | null,
        finalPadding = padding as Uint8Array | null;
      if (finalStore && budget) {
        try {
          finalStore.finalizePyramid();
        } catch (error) {
          if (terminal !== 'stopped') {
            terminal = 'error';
            failure = componentFailure(error);
          }
        }
        storeServer?.publish();
        scope.postMessage({
          type: 'local-done',
          metadata: storeServer!.metadata(),
          length: finalStore.length,
          memory: budget.snapshot(),
          stopReason: terminal,
          ...(failure.message ? { error: failure.message } : {}),
          timings: finalStore.timings,
          driverDiagnostics,
        });
      }
      if (finalPadding) budget?.release(finalPadding.buffer);
      const finalMultiRate = multiRate as MultiRateCapture | null;
      if (finalMultiRate && budget) {
        try {
          finalMultiRate.finalize();
        } catch (error) {
          terminal = 'error';
          failure = componentFailure(error);
        }
        storeServer!.publish();
        scope.postMessage({
          type: 'local-done',
          metadata: storeServer!.metadata(),
          length: finalMultiRate.store.length,
          memory: budget.snapshot(),
          stopReason: terminal,
          ...(failure.message ? { error: failure.message } : {}),
          driverDiagnostics,
        });
      }
      if (terminal === 'error')
        scope.postMessage({ type: 'error', ...failure, message: failure.message || 'Acquisition failed' });
      else scope.postMessage({ type: 'done' });
      scope.postMessage({ type: 'closed' });
    }
  })();
};
