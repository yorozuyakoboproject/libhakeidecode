import { componentFailure, type ComponentFailure } from '../components.js';
import {
  validateDeviceConfiguration,
  deviceChannelIndices,
  packedLogicSampleBytes,
  type AcquisitionChunk,
  type CaptureMode,
  type DeviceConfiguration,
  type DriverDiagnostics,
  type ManagedSampleSourceContext,
  type TransferProgress,
} from '../libhakei/device.js';
import { createDriverDevice } from '../drivers/workers.js';
import { ensureWorkerDriver } from '../kernel/worker-plugins.js';
import { createSampleChunk } from '../libhakei/index.js';
import type { SharedChunkProducer, SharedPublisherMetrics } from './shared-chunks.js';
import type { SharedChunkAllocator } from './shared-chunk-allocator.js';
import { PlanarSampleStore, type PlanarStoreTimings } from './data/planarStore.js';
import { AnalogSampleStore } from './data/analogStore.js';
import { channelWidthForProbes, widenPackedSamples } from './data/channel-count.js';
import { DEFAULT_CAPTURE_BUDGET_BYTES, MemoryBudget, type BudgetSnapshot } from './memory.js';
import { WorkerStoreServer, type StoreCaptureSource } from './worker-store-server.js';
import { yieldWorkerTask } from './worker-task.js';
import type { StoreMetadata } from './worker-store.js';
import { MultiRateCapture } from './multirate-capture.js';
import { RollingCapture } from './rolling-capture.js';
export type AcquisitionRequest =
  | {
      type: 'start';
      driverId: string;
      initialization?: unknown;
      configuration: DeviceConfiguration;
      mode?: CaptureMode;
      chunkSamples: number;
      buffers: ArrayBuffer[];
      sharedSampleCount?: bigint;
      sharedChunkBytes?: number;
      sharedSampleBytes?: 1 | 2 | 3 | 4;
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
    let rolling: RollingCapture | null = null;
    const continuous = data.mode === 'continuous';
    let logicIds: string[] = [],
      analogIds: string[] = [],
      padding: Uint8Array | null = null;
    const budget = data.store ? new MemoryBudget(data.store.budgetBytes ?? DEFAULT_CAPTURE_BUDGET_BYTES) : null;
    let lastProgressAt = -Infinity;
    let packedDigital: StoreCaptureSource['packedDigital'];
    const storeServer = data.store
      ? new WorkerStoreServer(() => {
          const source =
            rolling?.source() ??
            multiRate ??
            (store
              ? {
                  store,
                  labels: logicIds,
                  logicChannelCount: logicIds.length,
                  analogChannels: analogIds.map((id, index) => ({ name: id, store: analogStores[index]! })),
                }
              : null);
          return source && packedDigital ? { ...source, packedDigital } : source;
        })
      : null;
    const appendChunk = (input: AcquisitionChunk): number => {
      if (rolling) {
        rolling.append(input);
        return 0;
      }
      if (multiRate) {
        multiRate.append(input);
        return 0;
      }
      if ('format' in input) {
        const sampleBytes = input.format === 'packed-logic' ? packedLogicSampleBytes(input) : 0;
        if (
          input.format !== 'packed-logic' ||
          !['raw8', 'raw16', 'raw24', 'raw32'].includes(input.encoding) ||
          !(input.data instanceof Uint8Array) ||
          typeof input.startSample !== 'bigint' ||
          input.startSample < 0n ||
          !Number.isSafeInteger(input.sampleRate) ||
          input.sampleRate < 1 ||
          !Number.isInteger(input.channelCount) ||
          input.channelCount < 1 ||
          input.channelCount > 32 ||
          !Number.isSafeInteger(input.length) ||
          input.length < 1 ||
          input.length * sampleBytes > input.data.length
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
            stagePacked: input.channelCount <= 8,
            keepPacked: input.channelCount <= 8,
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
        store.append(
          widenPackedSamples(input.data.subarray(0, input.length * sampleBytes), sampleBytes, store.channelCount),
        );
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
      if ((!store && !multiRate && !rolling) || !budget || !storeServer) return;
      const now = performance.now();
      if (!force && now - lastProgressAt < 100) return;
      lastProgressAt = now;
      storeServer.publish();
      scope.postMessage({
        type: 'local-progress',
        length: (rolling?.store ?? multiRate?.store ?? store!).length,
        memory: budget.snapshot(),
        driverDiagnostics,
      });
    };
    try {
      if (data.sharedSampleCount !== undefined) {
        const [{ SharedChunkProducer, SharedChunkReader, normalizePackedSamples }, { SharedChunkAllocator }] =
          await Promise.all([import('./shared-chunks.js'), import('./shared-chunk-allocator.js')]);
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
          bytesPerSample: data.sharedSampleBytes,
          allocate: (byteLength) => allocator!.allocate(byteLength),
          onProgress: (bytes, samples, publisher) => reportSharedProgress(bytes, samples, publisher),
        });
        for (const port of pendingConsumers.splice(0)) producer.addConsumer(port);
        await producer.prepare();
        if (data.store) {
          const channel = new MessageChannel();
          producer.addConsumer(channel.port1);
          const reader = new SharedChunkReader(channel.port2, data.sharedSampleBytes ?? 1);
          packedDigital = {
            channelCount: data.configuration.logicChannels,
            samplerate: data.configuration.sampleRate,
            labels: deviceChannelIndices(data.configuration, 'logic').map((index) => `D${index}`),
            get length() {
              return producer!.length;
            },
            async readPackedRange(start, end, channels = data.configuration.logicChannels) {
              const raw = reader.readRange(start, end);
              if (!raw) throw new Error('Requested capture range is not committed');
              return normalizePackedSamples(raw, data.sharedSampleBytes ?? 1, channels);
            },
          };
        }
        reportSharedProgress(producer.allocatedBytes, producer.length, producer.publisherMetrics, true);
      }
      controller.signal.throwIfAborted();
      await ensureWorkerDriver(data.driverId);
      const device = createDriverDevice(data.driverId, data.initialization);
      validateDeviceConfiguration(device, data.configuration);
      let configuration = data.configuration;
      if (continuous) {
        const capability = device.getCapabilities(configuration).sampleCount;
        const maximum =
          capability.kind === 'list'
            ? capability.values.reduce((best, value) => (BigInt(value) > BigInt(best) ? value : best))
            : BigInt(capability.max) - ((BigInt(capability.max) - BigInt(capability.min)) % BigInt(capability.step));
        configuration = { ...configuration, sampleCount: maximum };
        validateDeviceConfiguration(device, configuration);
      }
      const description = device.getAcquisitionDescription(configuration);
      const sharedDigital =
        configuration.logicChannels > 0 &&
        (description.layout === 'packed-logic' || description.layout === 'multi-rate');
      if (!continuous && !!producer !== sharedDigital)
        throw new Error('Driver acquisition layout does not match the capture pipeline');
      if (continuous) {
        if (!budget || !storeServer || !data.storePort)
          throw new Error('Continuous acquisition requires Worker storage');
        rolling = new RollingCapture(
          data.configuration,
          budget,
          BigInt(configuration.sampleCount),
          description.layout === 'channel-arrays',
        );
        storeServer.connect(data.storePort);
      } else if (description.layout === 'multi-rate') {
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
          Object.assign((driverDiagnostics ??= {}), snapshot);
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
      const createSource = () =>
        (description.layout === 'multi-rate' && device.layout === 'multi-rate'
          ? device.createMultiRateSource(configuration, context)
          : device.layout !== 'channel-arrays'
            ? device.createPackedSource(configuration, context)
            : device.createSource(configuration, context))[Symbol.asyncIterator]();
      iterator = createSource();
      let lastYield = performance.now();
      while (true) {
        controller.signal.throwIfAborted();
        const result = await iterator.next();
        if (result.done) {
          controller.signal.throwIfAborted();
          if (rolling) {
            await iterator.return?.();
            rolling.nextSource();
            iterator = createSource();
            await yieldWorkerTask();
            continue;
          }
          break;
        }
        const timeline = 'format' in result.value && result.value.format === 'timeline';
        if (!borrowed && !timeline) throw new Error('Worker driver must use the managed buffer contract');
        if (producer && 'format' in result.value && result.value.format === 'packed-logic') {
          const sampleBytes = packedLogicSampleBytes(result.value);
          if (
            producer.bytesPerSample !== sampleBytes ||
            result.value.startSample !== producer.length ||
            result.value.sampleRate !== configuration.sampleRate ||
            result.value.channelCount !== configuration.logicChannels
          )
            throw new Error('Device digital layout or sample continuity changed during capture');
          const bytes = result.value.length * sampleBytes;
          await producer.append(result.value.data.subarray(0, bytes));
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
      const finalRolling = rolling as RollingCapture | null;
      if (finalRolling && budget) {
        storeServer!.publish();
        scope.postMessage({
          type: 'local-done',
          metadata: storeServer!.metadata(),
          length: finalRolling.store.length,
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
