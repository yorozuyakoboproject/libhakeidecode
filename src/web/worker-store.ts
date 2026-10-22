import type { SampleInput } from '../libhakei/sample-index.js';
import type { AnalogStore } from './data/analogStore.js';
import type { AnalogColumnView } from './data/analogStore.js';
import type { ColumnView, GapSpan, MemoryReport, SampleStore } from './data/types.js';
import type { DecodeEdgePart } from './protocol.js';
import type { AcquisitionResult } from './capture.js';
import type { WorkspaceSettings } from './workspace.js';

export interface StoreAnalogMetadata {
  readonly name: string;
  readonly length: bigint;
  readonly samplerate: number;
  readonly bytes: number;
}
export interface StoreMetadata {
  readonly channelCount: number;
  readonly samplerate: number;
  readonly length: bigint;
  readonly logicChannelCount?: number;
  readonly labels: readonly string[];
  readonly analog: readonly StoreAnalogMetadata[];
  readonly gaps: readonly GapSpan[];
  readonly digitalBytes: number;
  readonly analogBytes: number;
}

export interface PreparedChannelView {
  readonly channel: number;
  readonly low: Uint8Array;
  readonly high: Uint8Array;
  readonly edge: Uint8Array;
  readonly packed: Uint8Array;
  readonly edges?: bigint[];
  readonly points?: Uint8Array;
}
export interface PreparedAnalogView {
  readonly channel: number;
  readonly low: Float32Array;
  readonly high: Float32Array;
  readonly startSample: bigint;
  readonly endSample: bigint;
  readonly bins: number;
}
export type StoreRequest =
  | {
      type: 'prepare-digital';
      id: number;
      channels: readonly number[];
      startSample: bigint;
      endSample: bigint;
      bins: number;
      includeEdges: boolean;
    }
  | { type: 'prepare-analog'; id: number; channel: number; startSample: bigint; endSample: bigint; bins: number }
  | { type: 'pack-range'; id: number; startSample: bigint; endSample: bigint; channels: number }
  | { type: 'analog-range'; id: number; channel: number; startSample: bigint; endSample: bigint }
  | {
      type: 'export-sr';
      id: number;
      workspace?: WorkspaceSettings;
      triggerSample: bigint;
      acquisition?: AcquisitionResult;
    }
  | { type: 'cancel-export'; id: number }
  | { type: 'decode-reader'; port: MessagePort };
export type StoreResponse =
  | { type: 'metadata'; metadata: StoreMetadata }
  | {
      type: 'prepared-digital';
      id: number;
      startSample: bigint;
      endSample: bigint;
      availableEnd: bigint;
      bins: number;
      views: readonly PreparedChannelView[];
    }
  | { type: 'prepared-analog'; id: number; view: PreparedAnalogView; availableEnd: bigint }
  | { type: 'pack-range-result'; id: number; data: Uint8Array }
  | { type: 'analog-range-result'; id: number; data: Float32Array }
  | { type: 'export-sr-result'; id: number; blob: Blob }
  | { type: 'error'; id?: number; message: string };

export interface DecodeReadRequest {
  readonly type: 'decode-read';
  readonly id: number;
  readonly startSample: bigint;
  readonly endSample: bigint;
  readonly channels: Readonly<Record<string, number>>;
  readonly edgeInput?: string;
  readonly edgeLimit: number;
}
export type DecodeReadResponse =
  | { type: 'decode-read-result'; id: number; kind: 'wait'; startSample: bigint; availableEnd: bigint }
  | {
      type: 'decode-read-result';
      id: number;
      kind: 'channels';
      startSample: bigint;
      endSample: bigint;
      sampleRate: number;
      channels: Record<string, Uint8Array>;
    }
  | {
      type: 'decode-read-result';
      id: number;
      kind: 'edge';
      startSample: bigint;
      endSample: bigint;
      parts: DecodeEdgePart[];
    }
  | { type: 'decode-read-error'; id: number; message: string };

interface SharedStoreState {
  metadata: StoreMetadata;
  revision: number;
}
type Pending = { resolve(value: StoreResponse): void; reject(error: Error): void };
type StoreQueryRequest = Extract<
  StoreRequest,
  { type: 'prepare-digital' | 'prepare-analog' | 'pack-range' | 'analog-range' }
>;
type DigitalPrepared = { view: ColumnView; availableEnd: bigint; edges: bigint[] | null };
const keyFor = (channel: number, start: bigint, end: bigint, bins: number): string =>
  `${channel}:${start}:${end}:${bins}`;

function copyMetadata(metadata: StoreMetadata): StoreMetadata {
  return {
    ...metadata,
    labels: [...metadata.labels],
    analog: metadata.analog.map((item) => ({ ...item })),
    gaps: metadata.gaps.map((gap) => ({ ...gap })),
  };
}
function emptyMetadata(
  channelCount: number,
  samplerate: number,
  labels: readonly string[],
  analogNames: readonly string[],
): StoreMetadata {
  return {
    channelCount,
    samplerate,
    length: 0n,
    logicChannelCount: labels.length,
    labels: [...labels],
    analog: analogNames.map((name) => ({ name, length: 0n, samplerate, bytes: 0 })),
    gaps: [],
    digitalBytes: 0,
    analogBytes: 0,
  };
}

export class WorkerCaptureStore implements SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  private state: SharedStoreState;
  private nextId = 0;
  private readonly views = new Map<string, DigitalPrepared>();
  private readonly pending = new Map<number, Pending>();
  private readonly pendingViews = new Map<string, Promise<void>>();
  private readonly analogs: WorkerAnalogStore[] = [];
  private disposed = false;
  private failure: Error | null = null;

  constructor(
    private readonly worker: Worker,
    private readonly port: MessagePort,
    metadata: StoreMetadata,
  ) {
    this.state = { metadata: copyMetadata(metadata), revision: 0 };
    this.channelCount = metadata.channelCount;
    this.samplerate = metadata.samplerate;
    this.syncAnalogs();
    port.onmessage = ({ data }: MessageEvent<StoreResponse>) => this.receive(data);
    port.start();
  }

  static empty(
    worker: Worker,
    port: MessagePort,
    channelCount: number,
    samplerate: number,
    labels: readonly string[],
    analogNames: readonly string[],
  ): WorkerCaptureStore {
    return new WorkerCaptureStore(worker, port, emptyMetadata(channelCount, samplerate, labels, analogNames));
  }

  get length(): bigint {
    return this.state.metadata.length;
  }
  get metadata(): StoreMetadata {
    return copyMetadata(this.state.metadata);
  }
  get logicChannelCount(): number {
    return this.state.metadata.logicChannelCount ?? this.state.metadata.labels.length;
  }
  get analogStores(): readonly WorkerAnalogStore[] {
    return this.analogs;
  }
  get revision(): number {
    return this.state.revision;
  }
  get analogMetadata(): readonly StoreAnalogMetadata[] {
    return this.state.metadata.analog;
  }
  append(_chunk: Uint8Array): void {
    throw new Error('Worker capture storage is read-only on the UI thread');
  }
  noteGap(_start: SampleInput, _end: SampleInput): void {
    throw new Error('Worker capture storage is read-only on the UI thread');
  }
  gaps(): GapSpan[] {
    return this.state.metadata.gaps.map((gap) => ({ ...gap }));
  }
  sampleAt(_channel: number, _sample: SampleInput): number {
    throw new Error('Use the Worker decoder or request a prepared viewport');
  }
  edgeCount(channel: number, start: SampleInput, end: SampleInput): number {
    return this.edges(channel, start, end).length;
  }
  memory(): MemoryReport {
    return {
      baseBytes: this.state.metadata.digitalBytes,
      pyramidBytes: 0,
      totalBytes: this.state.metadata.digitalBytes,
      overhead: 0,
      slackBytes: 0,
    };
  }

  async prepareView(
    channels: readonly number[],
    start: bigint,
    end: bigint,
    bins: number,
    includeEdges = end - start < BigInt(bins),
  ): Promise<void> {
    const unique = [...new Set(channels)].filter(
      (channel) => Number.isInteger(channel) && channel >= 0 && channel < this.channelCount,
    );
    if (!unique.length || end <= start) return;
    const revision = this.state.revision,
      length = this.length;
    const missing = unique.filter((channel) => {
      const cached = this.views.get(keyFor(channel, start, end, bins));
      return !cached || cached.availableEnd < (end < length ? end : length) || (includeEdges && cached.edges === null);
    });
    if (!missing.length) return;
    const pendingKey = `${start}:${end}:${bins}:${includeEdges ? 1 : 0}:${revision}:${missing.join(',')}`;
    const existing = this.pendingViews.get(pendingKey);
    if (existing) return existing;
    const task = this.request({
      type: 'prepare-digital',
      id: this.nextId++,
      channels: missing,
      startSample: start,
      endSample: end,
      bins,
      includeEdges,
    }).then((response) => {
      if (response.type !== 'prepared-digital') throw new Error('Invalid prepared waveform response');
      for (const result of response.views) {
        this.views.set(keyFor(result.channel, start, end, bins), {
          availableEnd: response.availableEnd,
          view: {
            channel: result.channel,
            startSample: response.startSample,
            endSample: response.endSample,
            bins: response.bins,
            low: result.low,
            high: result.high,
            edge: result.edge,
            packed: result.packed,
            ...(result.points ? { points: result.points } : {}),
          },
          edges: result.edges ?? null,
        });
      }
      while (this.views.size > 128) this.views.delete(this.views.keys().next().value!);
    });
    this.pendingViews.set(pendingKey, task);
    try {
      await task;
    } finally {
      if (this.pendingViews.get(pendingKey) === task) this.pendingViews.delete(pendingKey);
    }
  }

  query(channel: number, startInput: SampleInput, endInput: SampleInput, bins: number): ColumnView {
    const start = BigInt(startInput),
      end = BigInt(endInput),
      prepared = this.views.get(keyFor(channel, start, end, bins));
    if (prepared) return prepared.view;
    return {
      channel,
      startSample: start,
      endSample: end,
      bins,
      low: new Uint8Array(bins).fill(1),
      high: new Uint8Array(bins),
      edge: new Uint8Array(bins),
      packed: new Uint8Array(bins).fill(8),
    };
  }
  edges(channel: number, startInput: SampleInput, endInput: SampleInput): bigint[] {
    const start = BigInt(startInput),
      end = BigInt(endInput);
    for (const [key, value] of this.views)
      if (key.startsWith(`${channel}:${start}:${end}:`) && value.edges) return value.edges;
    return [];
  }
  connectDecodeReader(port: MessagePort): void {
    this.port.postMessage({ type: 'decode-reader', port } satisfies StoreRequest, [port]);
  }
  exportSR(
    workspace: WorkspaceSettings | undefined,
    triggerSample: bigint,
    acquisition: AcquisitionResult | undefined,
    signal?: AbortSignal,
  ): Promise<Blob> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.disposed) return Promise.reject(new DOMException('Capture storage disposed', 'AbortError'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let settled = false,
        onAbort = (): void => {};
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      onAbort = (): void => {
        this.port.postMessage({ type: 'cancel-export', id } satisfies StoreRequest);
        finish(() => reject(new DOMException('Export aborted', 'AbortError')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (response) =>
          finish(() =>
            response.type === 'export-sr-result'
              ? resolve(response.blob)
              : reject(new Error('Invalid SR export response')),
          ),
        reject: (error) => finish(() => reject(error)),
      });
      try {
        this.port.postMessage({
          type: 'export-sr',
          id,
          ...(workspace ? { workspace } : {}),
          triggerSample,
          ...(acquisition ? { acquisition } : {}),
        } satisfies StoreRequest);
      } catch (error) {
        this.pending.delete(id);
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }
  nextRequestId(): number {
    return this.nextId++;
  }
  requestAnalog(channel: number, startSample: bigint, endSample: bigint, bins: number): Promise<StoreResponse> {
    return this.request({ type: 'prepare-analog', id: this.nextRequestId(), channel, startSample, endSample, bins });
  }
  async readPackedRange(startSample: bigint, endSample: bigint, channels = this.channelCount): Promise<Uint8Array> {
    const response = await this.request({ type: 'pack-range', id: this.nextId++, startSample, endSample, channels });
    if (response.type !== 'pack-range-result') throw new Error('Invalid packed range response');
    return response.data;
  }
  async readAnalogRange(channel: number, startSample: bigint, endSample: bigint): Promise<Float32Array> {
    const response = await this.request({ type: 'analog-range', id: this.nextId++, channel, startSample, endSample });
    if (response.type !== 'analog-range-result') throw new Error('Invalid analog range response');
    return response.data;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.close();
    this.worker.terminate();
    const error = new DOMException('Capture storage disposed', 'AbortError');
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    this.views.clear();
    this.pendingViews.clear();
  }
  private syncAnalogs(): void {
    const metadata = this.state.metadata.analog;
    while (this.analogs.length < metadata.length) this.analogs.push(new WorkerAnalogStore(this, this.analogs.length));
    this.analogs.length = metadata.length;
  }
  private request(request: StoreQueryRequest): Promise<StoreResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.disposed) return Promise.reject(new DOMException('Capture storage disposed', 'AbortError'));
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      try {
        this.port.postMessage(request);
      } catch (error) {
        this.pending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private receive(response: StoreResponse): void {
    if (response.type === 'metadata') {
      this.state.metadata = copyMetadata(response.metadata);
      this.state.revision++;
      this.syncAnalogs();
      return;
    }
    if (response.type === 'error') {
      if (response.id === undefined) {
        const error = new Error(response.message);
        this.failure = error;
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      pending.reject(new Error(response.message));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.resolve(response);
  }
}

export class WorkerAnalogStore implements AnalogStore {
  constructor(
    private readonly owner: WorkerCaptureStore,
    readonly channel: number,
  ) {}
  get samplerate(): number {
    return this.owner.samplerate;
  }
  get length(): bigint {
    return this.owner.analogMetadata[this.channel]?.length ?? 0n;
  }
  get name(): string {
    return this.owner.analogMetadata[this.channel]?.name ?? `A${this.channel}`;
  }
  private cache: { key: string; view: AnalogColumnView } | null = null;
  append(_values: ArrayLike<number>): void {
    throw new Error('Worker capture storage is read-only on the UI thread');
  }
  sampleAt(_index: SampleInput): number {
    throw new Error('Use the Worker decoder or request a prepared viewport');
  }
  async prepareView(start: bigint, end: bigint, bins: number): Promise<void> {
    const key = `${start}:${end}:${bins}:${this.owner.revision}`;
    if (this.cache?.key === key) return;
    const response = await this.owner.requestAnalog(this.channel, start, end, bins);
    if (response.type !== 'prepared-analog') throw new Error('Invalid prepared analog response');
    this.cache = {
      key,
      view: {
        startSample: response.view.startSample,
        endSample: response.view.endSample,
        bins: response.view.bins,
        low: response.view.low,
        high: response.view.high,
      },
    };
  }
  query(startInput: SampleInput, endInput: SampleInput, bins: number): AnalogColumnView {
    const start = BigInt(startInput),
      end = BigInt(endInput);
    if (
      this.cache &&
      this.cache.view.startSample === start &&
      this.cache.view.endSample === end &&
      this.cache.view.bins === bins
    )
      return this.cache.view;
    return { startSample: start, endSample: end, bins, low: new Float32Array(bins), high: new Float32Array(bins) };
  }
  memory(): { totalBytes: number } {
    return { totalBytes: this.owner.analogMetadata[this.channel]?.bytes ?? 0 };
  }
  dispose(): void {
    this.cache = null;
  }
}
