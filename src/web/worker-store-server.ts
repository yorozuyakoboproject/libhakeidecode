import { prepareDigitalView, type DigitalViewRequest } from './digital-view.js';
import { minSample, maxSample, localNumber, rescaleSample } from '../libhakei/sample-index.js';
import type { AnalogStore, AnalogColumnView } from './data/analogStore.js';
import { channelStoreRange, packStoreRange } from './data/channel-range.js';
import type { PlanarSampleStore } from './data/planarStore.js';
import type { RleSampleStore } from './data/rleStore.js';
import type { RollingSampleStore } from './rolling-capture.js';
import { AnalogConversion } from './analog-conversion.js';
import { parseAnalogSettings } from './analog-settings.js';
import { TimedAnalogStore } from './data/timed-analogStore.js';
import type {
  DecodeReadRequest,
  DecodeReadResponse,
  PreparedAnalogView,
  StoreMetadata,
  StoreRequest,
  StoreResponse,
} from './worker-store.js';

export interface StoreCaptureSource {
  readonly store: PlanarSampleStore | RleSampleStore | RollingSampleStore;
  readonly sampleOffset?: bigint;
  readonly snapshot?: (analog?: boolean) => StoreCaptureSource;
  readonly dispose?: () => void;
  readonly labels: readonly string[];
  readonly logicChannelCount?: number;
  readonly analogChannels?: readonly { readonly name: string; readonly store: AnalogStore }[];
  readonly packedDigital?: {
    readonly channelCount: number;
    readonly samplerate: number;
    readonly length: bigint;
    readonly labels: readonly string[];
    readPackedRange(start: bigint, end: bigint, channels?: number): Promise<Uint8Array>;
  };
}

const DECODE_EDGE_WINDOW_LIMIT = 100_000;
const MAX_CHUNK = 2 ** 26;

export class WorkerStoreServer {
  private port: MessagePort | null = null;
  private readonly decodePorts = new Map<number, { port: MessagePort; snapshot?: StoreCaptureSource }>();
  private readonly exportControllers = new Map<number, AbortController>();
  private disposed = false;
  private readonly conversions = new Map<number, AnalogConversion>();
  private sampleOffset?: bigint;
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
      ...('queryDiagnostics' in store ? { queryDiagnostics: store.queryDiagnostics() } : {}),
      ...(capture.sampleOffset === undefined ? {} : { sampleOffset: capture.sampleOffset }),
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
        range: channel.store.range,
        mean: channel.store.mean,
        ...(channel.store instanceof TimedAnalogStore
          ? { timing: channel.store.timing, nativeLength: channel.store.native.length }
          : {}),
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
    const metadata = this.metadata();
    if (metadata.sampleOffset !== this.sampleOffset) {
      for (const conversion of this.conversions.values()) conversion.dispose();
      this.conversions.clear();
      this.sampleOffset = metadata.sampleOffset;
    }
    this.port.postMessage({ type: 'metadata', metadata } satisfies StoreResponse);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const conversion of this.conversions.values()) conversion.dispose();
    this.conversions.clear();
    this.port?.close();
    this.port = null;
    for (const controller of this.exportControllers.values()) controller.abort();
    this.exportControllers.clear();
    for (const id of this.decodePorts.keys()) this.closeDecodeReader(id);
  }

  private async handle(request: StoreRequest): Promise<void> {
    if (request.type === 'decode-reader') {
      this.connectDecodeReader(request.id, request.port, request.live);
      return;
    }
    if (request.type === 'close-decode-reader') {
      this.closeDecodeReader(request.id);
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
    if (request.type === 'probe-analog') {
      const sample = request.sample,
        inGap = capture.store.gaps().some((gap) => sample >= gap.startSample && sample < gap.endSample),
        values = (capture.analogChannels ?? []).map(({ store }) => {
          const analogSample = rescaleSample(sample, capture.store.samplerate, store.samplerate);
          if (analogSample < 0n || analogSample >= store.length || inGap) return null;
          const value = store.sampleAt(analogSample);
          return Number.isFinite(value) ? value : null;
        });
      this.port!.postMessage({ type: 'analog-probe', id: request.id, sample, values } satisfies StoreResponse);
      return;
    }
    if (request.type === 'prepare-digital') {
      await this.prepareDigital(capture, request);
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
    const source = this.source(),
      snapshot = source?.snapshot?.(true),
      capture = snapshot ?? source;
    if (!capture) throw new Error('Capture data is not ready');
    const controller = new AbortController();
    this.exportControllers.set(request.id, controller);
    try {
      const { serializeSR } = await import('./sr.js');
      controller.signal.throwIfAborted();
      const digital = capture.packedDigital;
      const length = digital?.length ?? capture.store.length;
      let workspace = request.workspace;
      if ((snapshot || digital) && workspace && length > 0n) {
        const end = minSample(length, maxSample(1n, workspace.viewport[1])),
          cursor = (value: bigint | null | undefined) => (value != null && value < length ? value : null);
        workspace = {
          ...workspace,
          viewport: [minSample(workspace.viewport[0], end - 1n), end],
          cursor: cursor(workspace.cursor),
          cursorA: cursor(workspace.cursorA),
          cursorB: cursor(workspace.cursorB),
        };
      }
      const acquisition =
        request.acquisition && (snapshot || digital)
          ? {
              ...request.acquisition,
              actualSamples: length,
              stopReason:
                request.acquisition.stopReason === 'complete' && length < request.acquisition.targetSamples
                  ? ('stopped' as const)
                  : request.acquisition.stopReason,
            }
          : request.acquisition;
      const blob = await serializeSR(
        {
          name: 'capture.sr',
          store: digital
            ? ({ ...digital, gaps: () => capture.store.gaps() } as unknown as PlanarSampleStore)
            : capture.store,
          labels: [...(digital?.labels ?? capture.labels)],
          triggerSample: request.triggerSample,
          loadedMs: 0,
          ...(digital
            ? { logicChannelCount: digital.channelCount }
            : capture.logicChannelCount === undefined
              ? {}
              : { logicChannelCount: capture.logicChannelCount }),
          ...(capture.analogChannels
            ? {
                analogChannels: capture.analogChannels.map((channel) => ({ name: channel.name, store: channel.store })),
              }
            : {}),
          ...(acquisition ? { acquisition } : {}),
        },
        workspace,
        (fraction) => {
          if (!controller.signal.aborted)
            this.port?.postMessage({ type: 'export-sr-progress', id: request.id, fraction } satisfies StoreResponse);
        },
        controller.signal,
      );
      if (!controller.signal.aborted && this.port)
        this.port.postMessage({ type: 'export-sr-result', id: request.id, blob } satisfies StoreResponse);
    } finally {
      this.exportControllers.delete(request.id);
      snapshot?.dispose?.();
    }
  }

  private async prepareDigital(capture: StoreCaptureSource, request: DigitalViewRequest): Promise<void> {
    const result =
      'prepareDigitalView' in capture.store
        ? await capture.store.prepareDigitalView(request)
        : prepareDigitalView(capture.store, request);
    if (!this.port || this.disposed) return;
    const transfer: Transferable[] = [];
    for (const view of result.views)
      transfer.push(
        view.low.buffer,
        view.high.buffer,
        view.edge.buffer,
        view.packed.buffer,
        ...(view.points ? [view.points.buffer] : []),
      );
    this.port.postMessage(result, transfer);
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
    const settings = request.settings ? parseAnalogSettings(request.settings) : null;
    let logic: AnalogColumnView['logic'];
    if (settings && settings.conversion !== 'none' && availableSpan > 0n) {
      let conversion = this.conversions.get(request.channel);
      if (!conversion) {
        conversion = new AnalogConversion();
        this.conversions.set(request.channel, conversion);
      }
      logic = conversion.prepare(analog.store, settings, capture.store.gaps(), start, availableEnd, bins);
    } else {
      this.conversions.get(request.channel)?.dispose();
      this.conversions.delete(request.channel);
    }
    const result = logic ? { ...view, logic } : view;
    this.port!.postMessage(
      { type: 'prepared-analog', id: request.id, view: result, availableEnd } satisfies StoreResponse,
      [
        low.buffer,
        high.buffer,
        ...(logic
          ? [
              logic.low.buffer,
              logic.high.buffer,
              logic.edge.buffer,
              logic.packed.buffer,
              ...(logic.points ? [logic.points.buffer] : []),
            ]
          : []),
      ],
    );
  }

  private closeDecodeReader(id: number): void {
    const reader = this.decodePorts.get(id);
    if (!reader) return;
    reader.port.close();
    reader.snapshot?.dispose?.();
    this.decodePorts.delete(id);
  }
  private connectDecodeReader(id: number, port: MessagePort, live = false): void {
    let snapshot: StoreCaptureSource | undefined,
      failure: unknown,
      established = false;
    try {
      if (!live) snapshot = this.source()?.snapshot?.();
    } catch (error) {
      failure = error;
    }
    this.decodePorts.set(id, { port, snapshot });
    port.onmessage = ({ data }: MessageEvent<DecodeReadRequest>) => {
      try {
        if (failure) throw failure;
        established = this.answerDecodeRequest(port, data, snapshot, live, live && !established) || established;
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

  private answerDecodeRequest(
    port: MessagePort,
    request: DecodeReadRequest,
    snapshot?: StoreCaptureSource,
    live = false,
    opening = false,
  ): boolean {
    if (request.type !== 'decode-read' || !Number.isSafeInteger(request.id)) return false;
    const capture = snapshot ?? this.source();
    if (!capture) throw new Error('Capture data is not ready');
    const store = capture.store,
      offset = live ? (capture.sampleOffset ?? 0n) : 0n,
      sourceEnd = offset + store.length,
      requestedStart = maxSample(0n, request.startSample),
      requestedSpan = maxSample(0n, request.endSample - requestedStart),
      absoluteStart = opening ? maxSample(offset, requestedStart) : requestedStart,
      absoluteEnd = opening ? minSample(sourceEnd, absoluteStart + requestedSpan) : requestedStart + requestedSpan;
    if (absoluteStart < offset) throw new Error('Decoder fell behind the retained capture window');
    if (
      Object.values(request.channels).some(
        (channel) => !Number.isInteger(channel) || channel < 0 || channel >= store.channelCount,
      )
    )
      throw new RangeError('Invalid decode channel');
    const start = absoluteStart - offset,
      availableEnd = minSample(sourceEnd, absoluteEnd) - offset;
    if (absoluteStart >= sourceEnd || (live && absoluteEnd > sourceEnd)) {
      port.postMessage({
        type: 'decode-read-result',
        id: request.id,
        kind: 'wait',
        startSample: absoluteStart,
        availableEnd: sourceEnd,
        availableStart: offset,
      } satisfies DecodeReadResponse);
      return false;
    }
    if (availableEnd - start > BigInt(MAX_CHUNK)) throw new RangeError('Decode read range is too large');
    const edgeIndex = request.edgeInput === undefined ? undefined : request.channels[request.edgeInput];
    if (edgeIndex === undefined && 'decodeEdges' in store && store.gaps().length === 0) {
      const channels: Record<string, { initial: 0 | 1; edges: bigint[] }> = {};
      let remaining = DECODE_EDGE_WINDOW_LIMIT,
        complete = true;
      for (const [name, index] of Object.entries(request.channels)) {
        const edges = store.decodeEdges(index, start, availableEnd, remaining);
        if (edges === null) {
          complete = false;
          break;
        }
        remaining -= edges.length;
        channels[name] = { initial: store.sampleAt(index, start) as 0 | 1, edges: edges.map((edge) => edge + offset) };
      }
      if (complete) {
        port.postMessage({
          type: 'decode-read-result',
          id: request.id,
          kind: 'edges',
          startSample: absoluteStart,
          endSample: availableEnd + offset,
          availableStart: offset,
          availableEnd: sourceEnd,
          channels,
          sampleRate: store.samplerate,
        } satisfies DecodeReadResponse);
        return availableEnd > start;
      }
    }
    const fastEdges =
      edgeIndex !== undefined && 'decodeEdges' in store
        ? store.decodeEdges(edgeIndex, start, availableEnd, Math.min(request.edgeLimit, DECODE_EDGE_WINDOW_LIMIT))
        : undefined;
    if (
      edgeIndex !== undefined &&
      store.gaps().length === 0 &&
      (fastEdges !== undefined || ('edgeCount' in store && typeof store.edgeCount === 'function'))
    ) {
      const edgeCount =
        fastEdges === null
          ? Infinity
          : (fastEdges?.length ?? ('edgeCount' in store ? store.edgeCount(edgeIndex, start, availableEnd) : Infinity));
      if (edgeCount <= Math.min(request.edgeLimit, DECODE_EDGE_WINDOW_LIMIT)) {
        const edges = (fastEdges ?? store.edges(edgeIndex, start, availableEnd)).map((edge) => edge + offset);
        port.postMessage({
          type: 'decode-read-result',
          id: request.id,
          kind: 'edge',
          startSample: absoluteStart,
          endSample: availableEnd + offset,
          availableStart: offset,
          availableEnd: sourceEnd,
          parts: [
            {
              startSample: absoluteStart,
              endSample: availableEnd + offset,
              initial: store.sampleAt(edgeIndex, start) as 0 | 1,
              edges,
            },
          ],
        } satisfies DecodeReadResponse);
        return availableEnd > start;
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
        startSample: absoluteStart,
        endSample: availableEnd + offset,
        availableStart: offset,
        availableEnd: sourceEnd,
        sampleRate: store.samplerate,
        channels,
      } satisfies DecodeReadResponse,
      transfer,
    );
    return availableEnd > start;
  }
}

function copyAnalog(store: AnalogStore, start: bigint, end: bigint): Float32Array {
  const output = new Float32Array(localNumber(end - start, MAX_CHUNK));
  for (let index = 0; index < output.length; index++) output[index] = store.sampleAt(start + BigInt(index));
  return output;
}
