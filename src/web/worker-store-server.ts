import { minSample, maxSample, localNumber } from '../libhakei/sample-index.js';
import type { AnalogStore } from './data/analogStore.js';
import { channelStoreRange, packStoreRange } from './data/channel-range.js';
import type { PlanarSampleStore } from './data/planarStore.js';
import type { RleSampleStore } from './data/rleStore.js';
import { serializeSR } from './sr.js';
import type {
  DecodeReadRequest,
  DecodeReadResponse,
  PreparedAnalogView,
  PreparedChannelView,
  StoreMetadata,
  StoreRequest,
  StoreResponse,
} from './worker-store.js';

export interface StoreCaptureSource {
  readonly store: PlanarSampleStore | RleSampleStore;
  readonly labels: readonly string[];
  readonly logicChannelCount?: number;
  readonly analogChannels?: readonly { readonly name: string; readonly store: AnalogStore }[];
}

const DECODE_EDGE_WINDOW_LIMIT = 100_000;
const MAX_CHUNK = 2 ** 26;

function blankDigital(bins: number): { low: Uint8Array; high: Uint8Array; edge: Uint8Array; packed: Uint8Array } {
  return {
    low: new Uint8Array(bins).fill(1),
    high: new Uint8Array(bins),
    edge: new Uint8Array(bins),
    packed: new Uint8Array(bins).fill(8),
  };
}

export class WorkerStoreServer {
  private port: MessagePort | null = null;
  private readonly decodePorts = new Set<MessagePort>();
  private readonly exportControllers = new Map<number, AbortController>();
  private disposed = false;
  constructor(private readonly source: () => StoreCaptureSource | null) {}

  metadata(): StoreMetadata {
    const capture = this.source();
    if (!capture)
      return {
        channelCount: 4,
        samplerate: 1,
        length: 0n,
        labels: [],
        analog: [],
        gaps: [],
        digitalBytes: 0,
        analogBytes: 0,
      };
    const store = capture.store,
      analog = capture.analogChannels ?? [];
    return {
      channelCount: store.channelCount,
      samplerate: store.samplerate,
      length: store.length,
      ...(capture.logicChannelCount === undefined ? {} : { logicChannelCount: capture.logicChannelCount }),
      labels: [...capture.labels],
      analog: analog.map((channel) => ({
        name: channel.name,
        length: channel.store.length,
        samplerate: channel.store.samplerate,
        bytes: channel.store.memory().totalBytes,
      })),
      gaps: store.gaps().map((gap) => ({ ...gap })),
      digitalBytes: store.memory().totalBytes,
      analogBytes: analog.reduce((sum, channel) => sum + channel.store.memory().totalBytes, 0),
    };
  }

  connect(port: MessagePort): void {
    if (this.port) throw new Error('Store Worker already has a query port');
    this.port = port;
    port.onmessage = ({ data }: MessageEvent<StoreRequest | { type: 'dispose' }>) => {
      if (data.type === 'dispose') {
        this.dispose();
        return;
      }
      void this.handle(data).catch((error) => {
        port.postMessage({
          type: 'error',
          ...(typeof (data as { id?: number }).id === 'number' ? { id: (data as { id: number }).id } : {}),
          message: error instanceof Error ? error.message : String(error),
        } satisfies StoreResponse);
      });
    };
    port.start();
    this.publish();
  }

  publish(): void {
    if (!this.port || this.disposed) return;
    this.port.postMessage({ type: 'metadata', metadata: this.metadata() } satisfies StoreResponse);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port?.close();
    this.port = null;
    for (const controller of this.exportControllers.values()) controller.abort();
    this.exportControllers.clear();
    for (const port of this.decodePorts) port.close();
    this.decodePorts.clear();
  }

  private async handle(request: StoreRequest): Promise<void> {
    if (request.type === 'decode-reader') {
      this.connectDecodeReader(request.port);
      return;
    }
    if (request.type === 'cancel-export') {
      this.exportControllers.get(request.id)?.abort();
      return;
    }
    if (request.type === 'export-sr') {
      await this.exportSR(request);
      return;
    }
    const capture = this.source();
    if (!capture) throw new Error('Capture data is not ready');
    if (request.type === 'prepare-digital') {
      this.prepareDigital(capture, request);
      return;
    }
    if (request.type === 'prepare-analog') {
      this.prepareAnalog(capture, request);
      return;
    }
    if (request.type === 'pack-range') {
      const end = minSample(capture.store.length, request.endSample),
        data = packStoreRange(capture.store, request.startSample, end, request.channels);
      this.port!.postMessage({ type: 'pack-range-result', id: request.id, data } satisfies StoreResponse, [
        data.buffer,
      ]);
      return;
    }
    const analog = capture.analogChannels?.[request.channel];
    if (!analog) throw new RangeError('Analog channel out of range');
    const end = minSample(analog.store.length, request.endSample);
    const copyRange = (analog.store as AnalogStore & { copyRange?: (start: bigint, end: bigint) => Float32Array })
      .copyRange;
    const values = copyRange
      ? copyRange.call(analog.store, request.startSample, end)
      : copyAnalog(analog.store, request.startSample, end);
    this.port!.postMessage({ type: 'analog-range-result', id: request.id, data: values } satisfies StoreResponse, [
      values.buffer,
    ]);
  }

  private async exportSR(request: Extract<StoreRequest, { type: 'export-sr' }>): Promise<void> {
    const capture = this.source();
    if (!capture) throw new Error('Capture data is not ready');
    const controller = new AbortController();
    this.exportControllers.set(request.id, controller);
    try {
      const blob = await serializeSR(
        {
          name: 'capture.sr',
          store: capture.store,
          labels: [...capture.labels],
          triggerSample: request.triggerSample,
          loadedMs: 0,
          ...(capture.logicChannelCount === undefined ? {} : { logicChannelCount: capture.logicChannelCount }),
          ...(capture.analogChannels
            ? {
                analogChannels: capture.analogChannels.map((channel) => ({ name: channel.name, store: channel.store })),
              }
            : {}),
          ...(request.acquisition ? { acquisition: request.acquisition } : {}),
        },
        request.workspace,
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted && this.port)
        this.port.postMessage({ type: 'export-sr-result', id: request.id, blob } satisfies StoreResponse);
    } finally {
      this.exportControllers.delete(request.id);
    }
  }

  private prepareDigital(
    capture: StoreCaptureSource,
    request: Extract<StoreRequest, { type: 'prepare-digital' }>,
  ): void {
    const store = capture.store,
      bins = request.bins,
      start = maxSample(0n, request.startSample),
      requestedEnd = request.endSample > start ? request.endSample : start;
    const availableEnd = minSample(store.length, requestedEnd),
      span = requestedEnd - start,
      availableSpan = availableEnd > start ? availableEnd - start : 0n;
    const availableBins =
      availableSpan >= span || span === 0n
        ? bins
        : Math.max(1, Math.floor((Number(availableSpan) / Number(span)) * bins));
    const views: PreparedChannelView[] = [];
    for (const channel of request.channels) {
      if (!Number.isInteger(channel) || channel < 0 || channel >= store.channelCount)
        throw new RangeError('Digital channel out of range');
      let result = blankDigital(bins);
      if (availableSpan > 0n) {
        const view = store.query(channel, start, availableEnd, availableBins);
        result = {
          low: new Uint8Array(bins).fill(1),
          high: new Uint8Array(bins),
          edge: new Uint8Array(bins),
          packed: new Uint8Array(bins).fill(8),
        };
        const count = Math.min(availableBins, view.bins, bins);
        result.low.set(view.low.subarray(0, count));
        result.high.set(view.high.subarray(0, count));
        result.edge.set(view.edge.subarray(0, count));
        result.packed.set(view.packed.subarray(0, count));
      }
      const edges = request.includeEdges ? store.edges(channel, start, availableEnd) : undefined;
      const points =
        request.bins >= Number(availableSpan) ? channelStoreRange(store, channel, start, availableEnd) : undefined;
      views.push({ channel, ...result, ...(edges ? { edges } : {}), ...(points ? { points } : {}) });
    }
    const transfer: Transferable[] = [];
    for (const view of views)
      transfer.push(
        view.low.buffer,
        view.high.buffer,
        view.edge.buffer,
        view.packed.buffer,
        ...(view.points ? [view.points.buffer] : []),
      );
    this.port!.postMessage(
      {
        type: 'prepared-digital',
        id: request.id,
        startSample: start,
        endSample: requestedEnd,
        availableEnd,
        bins,
        views,
      } satisfies StoreResponse,
      transfer,
    );
  }

  private prepareAnalog(capture: StoreCaptureSource, request: Extract<StoreRequest, { type: 'prepare-analog' }>): void {
    const analog = capture.analogChannels?.[request.channel];
    if (!analog) throw new RangeError('Analog channel out of range');
    const bins = request.bins,
      start = maxSample(0n, request.startSample),
      requestedEnd = request.endSample > start ? request.endSample : start;
    const availableEnd = minSample(analog.store.length, requestedEnd),
      span = requestedEnd - start,
      availableSpan = availableEnd > start ? availableEnd - start : 0n;
    const low = new Float32Array(bins),
      high = new Float32Array(bins);
    if (availableSpan > 0n) {
      const availableBins =
        availableSpan >= span || span === 0n
          ? bins
          : Math.max(1, Math.floor((Number(availableSpan) / Number(span)) * bins));
      const view = analog.store.query(start, availableEnd, availableBins),
        count = Math.min(availableBins, view.bins, bins);
      low.set(view.low.subarray(0, count));
      high.set(view.high.subarray(0, count));
    }
    const view: PreparedAnalogView = {
      channel: request.channel,
      startSample: start,
      endSample: requestedEnd,
      bins,
      low,
      high,
    };
    this.port!.postMessage({ type: 'prepared-analog', id: request.id, view, availableEnd } satisfies StoreResponse, [
      low.buffer,
      high.buffer,
    ]);
  }

  private connectDecodeReader(port: MessagePort): void {
    this.decodePorts.add(port);
    port.onmessage = ({ data }: MessageEvent<DecodeReadRequest>) => {
      try {
        this.answerDecodeRequest(port, data);
      } catch (error) {
        port.postMessage({
          type: 'decode-read-error',
          id: data?.id,
          message: error instanceof Error ? error.message : String(error),
        } satisfies DecodeReadResponse);
      }
    };
    port.start();
  }

  private answerDecodeRequest(port: MessagePort, request: DecodeReadRequest): void {
    if (request.type !== 'decode-read' || !Number.isSafeInteger(request.id)) return;
    const capture = this.source();
    if (!capture) throw new Error('Capture data is not ready');
    const store = capture.store,
      start = maxSample(0n, request.startSample),
      requestedEnd = request.endSample > start ? request.endSample : start;
    const availableEnd = minSample(store.length, requestedEnd);
    if (start >= availableEnd) {
      port.postMessage({
        type: 'decode-read-result',
        id: request.id,
        kind: 'wait',
        startSample: start,
        availableEnd,
      } satisfies DecodeReadResponse);
      return;
    }
    if (availableEnd - start > BigInt(MAX_CHUNK)) throw new RangeError('Decode read range is too large');
    const edgeIndex = request.edgeInput === undefined ? undefined : request.channels[request.edgeInput];
    if (
      edgeIndex !== undefined &&
      store.gaps().length === 0 &&
      'edgeCount' in store &&
      typeof store.edgeCount === 'function'
    ) {
      const edgeCount = store.edgeCount(edgeIndex, start, availableEnd);
      if (edgeCount <= Math.min(request.edgeLimit, DECODE_EDGE_WINDOW_LIMIT)) {
        const edges = store.edges(edgeIndex, start, availableEnd);
        port.postMessage({
          type: 'decode-read-result',
          id: request.id,
          kind: 'edge',
          startSample: start,
          endSample: availableEnd,
          parts: [
            { startSample: start, endSample: availableEnd, initial: store.sampleAt(edgeIndex, start) as 0 | 1, edges },
          ],
        } satisfies DecodeReadResponse);
        return;
      }
    }
    const channels: Record<string, Uint8Array> = {},
      transfer: Transferable[] = [];
    for (const [name, channel] of Object.entries(request.channels)) {
      const data = channelStoreRange(store, channel, start, availableEnd);
      channels[name] = data;
      transfer.push(data.buffer);
    }
    port.postMessage(
      {
        type: 'decode-read-result',
        id: request.id,
        kind: 'channels',
        startSample: start,
        endSample: availableEnd,
        sampleRate: store.samplerate,
        channels,
      } satisfies DecodeReadResponse,
      transfer,
    );
  }
}

function copyAnalog(store: AnalogStore, start: bigint, end: bigint): Float32Array {
  const output = new Float32Array(localNumber(end - start, MAX_CHUNK));
  for (let index = 0; index < output.length; index++) output[index] = store.sampleAt(start + BigInt(index));
  return output;
}
