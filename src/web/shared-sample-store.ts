import type { SampleInput } from '../libhakei/sample-index.js';
import type { ColumnView, GapSpan, MemoryReport, SampleStore } from './data/types.js';
import type { AcquisitionResult, SharedCaptureConsumerSource } from './capture.js';
import type { SharedCaptureState } from './shared-chunks.js';
import type { WorkspaceSettings } from './workspace.js';

type Request =
  | { type: 'start'; port: MessagePort; channelCount: number; sampleRate: number; labels?: readonly string[] }
  | { type: 'query'; id: number; channel: number; startSample: bigint; endSample: bigint; bins: number }
  | { type: 'edges'; id: number; channel: number; startSample: bigint; endSample: bigint }
  | { type: 'pack'; id: number; startSample: bigint; endSample: bigint; channels: number }
  | { type: 'reader'; port: MessagePort }
  | {
      type: 'export-sr';
      id: number;
      workspace?: WorkspaceSettings;
      triggerSample: bigint;
      acquisition?: AcquisitionResult;
    }
  | { type: 'cancel-export'; id: number }
  | { type: 'finish' };
type Response =
  | { type: 'progress'; length: bigint; groups: number; summaryBytes: number }
  | {
      type: 'query-result';
      id: number;
      channel: number;
      startSample: bigint;
      endSample: bigint;
      bins: number;
      low: Uint8Array;
      high: Uint8Array;
      edge: Uint8Array;
      packed: Uint8Array;
    }
  | { type: 'edges-result'; id: number; channel: number; startSample: bigint; endSample: bigint; edges: bigint[] }
  | { type: 'pack-result'; id: number; data: Uint8Array }
  | { type: 'export-sr-result'; id: number; blob: Blob }
  | {
      type: 'done';
      state: SharedCaptureState;
      length: bigint;
      error?: string;
      summaryBytes: number;
      metrics: {
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
    }
  | { type: 'error'; id?: number; message: string };
type ViewRequest =
  | { type: 'start'; port: MessagePort; channelCount: number }
  | { type: 'query'; id: number; channel: number; startSample: bigint; endSample: bigint; bins: number }
  | {
      type: 'query-many';
      id: number;
      channels: readonly number[];
      startSample: bigint;
      endSample: bigint;
      bins: number;
    }
  | { type: 'edges'; id: number; channel: number; startSample: bigint; endSample: bigint }
  | { type: 'finish' };
type ViewChannelResult = {
  channel: number;
  low: Uint8Array;
  high: Uint8Array;
  edge: Uint8Array;
  packed: Uint8Array;
  points?: Uint8Array;
};
type ViewResponse =
  | { type: 'progress'; length: bigint; summaryBytes: number }
  | {
      type: 'query-result';
      id: number;
      channel: number;
      startSample: bigint;
      endSample: bigint;
      availableEnd: bigint;
      bins: number;
      low: Uint8Array;
      high: Uint8Array;
      edge: Uint8Array;
      packed: Uint8Array;
      points?: Uint8Array;
    }
  | {
      type: 'query-many-result';
      id: number;
      startSample: bigint;
      endSample: bigint;
      availableEnd: bigint;
      bins: number;
      results: readonly ViewChannelResult[];
    }
  | { type: 'edges-result'; id: number; channel: number; startSample: bigint; endSample: bigint; edges: bigint[] }
  | { type: 'done'; state: 'complete' | 'stopped' | 'error'; length: bigint; error?: string; summaryBytes: number }
  | { type: 'error'; message: string };
type RemoteView = { view: ColumnView; edges: bigint[] | null; availableEnd: bigint };
type Pending = { resolve(value: Response): void; reject(error: Error): void };
type PendingView = { resolve(value: ViewResponse): void; reject(error: Error): void };
const keyFor = (channel: number, start: bigint, end: bigint, bins: number): string =>
  `${channel}:${start}:${end}:${bins}`;
const MAX_SAFE_SAMPLE = BigInt(Number.MAX_SAFE_INTEGER);

export class SharedWorkerSampleStore implements SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  private nextId = 0;
  private latestLength = 0n;
  private latestSummaryBytes = 0;
  private latestViewSummaryBytes = 0;
  private sequence = 0;
  private views = new Map<string, RemoteView>();
  private pendingViews = new Map<string, Promise<void>>();
  private pending = new Map<number, Pending>();
  private viewPending = new Map<number, PendingView>();
  private readonly worker: Worker;
  private readonly viewWorker: Worker;
  private doneResolve!: (value: Extract<Response, { type: 'done' }>) => void;
  private doneReject!: (error: Error) => void;
  readonly done: Promise<Extract<Response, { type: 'done' }>>;
  private viewDoneResolve!: (value: Extract<ViewResponse, { type: 'done' }>) => void;
  private viewDoneReject!: (error: Error) => void;
  readonly viewDone: Promise<Extract<ViewResponse, { type: 'done' }>>;
  onProgress: (() => void) | null = null;
  private terminal: Extract<Response, { type: 'done' }> | null = null;
  private viewTerminal: Extract<ViewResponse, { type: 'done' }> | null = null;
  private failure: Error | null = null;
  private viewFailure: Error | null = null;
  private disposed = false;

  constructor(
    source: SharedCaptureConsumerSource,
    channelCount: number,
    samplerate: number,
    labels: readonly string[] = Array.from({ length: channelCount }, (_, index) => 'D' + index),
  ) {
    this.channelCount = channelCount;
    this.samplerate = samplerate;
    if (labels.length !== channelCount) throw new Error('Invalid shared channel labels');
    this.worker = new Worker(new URL('./capture-store-worker.js', import.meta.url), { type: 'module' });
    this.viewWorker = new Worker(new URL('./capture-view-worker.js', import.meta.url), { type: 'module' });
    this.done = new Promise((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
    this.viewDone = new Promise((resolve, reject) => {
      this.viewDoneResolve = resolve;
      this.viewDoneReject = reject;
    });
    void this.done.catch(() => {});
    void this.viewDone.catch(() => {});
    this.worker.onmessage = ({ data }: MessageEvent<Response>) => {
      if (data.type === 'progress') {
        this.latestLength = data.length > this.latestLength ? data.length : this.latestLength;
        this.latestSummaryBytes = data.summaryBytes;
        this.sequence++;
        this.onProgress?.();
        return;
      }
      if (data.type === 'done') {
        this.terminal = data;
        this.latestLength = data.length > this.latestLength ? data.length : this.latestLength;
        this.latestSummaryBytes = data.summaryBytes;
        this.sequence++;
        this.doneResolve(data);
        this.onProgress?.();
        return;
      }
      if (data.type === 'error') {
        if (typeof data.id === 'number') {
          const pending = this.pending.get(data.id);
          if (!pending) return;
          this.pending.delete(data.id);
          pending.reject(new Error(data.message));
          return;
        }
        this.failStorage(new Error(data.message));
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      pending.resolve(data);
    };
    this.viewWorker.onmessage = ({ data }: MessageEvent<ViewResponse>) => {
      if (data.type === 'progress') {
        this.latestLength = data.length > this.latestLength ? data.length : this.latestLength;
        this.latestViewSummaryBytes = data.summaryBytes;
        this.sequence++;
        this.onProgress?.();
        return;
      }
      if (data.type === 'done') {
        this.viewTerminal = data;
        this.latestLength = data.length > this.latestLength ? data.length : this.latestLength;
        this.latestViewSummaryBytes = data.summaryBytes;
        this.sequence++;
        this.viewDoneResolve(data);
        this.onProgress?.();
        return;
      }
      if (data.type === 'error') {
        this.failView(new Error(data.message));
        return;
      }
      const pending = this.viewPending.get(data.id);
      if (!pending) return;
      this.viewPending.delete(data.id);
      pending.resolve(data);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.failStorage(new Error(event.message || 'Capture storage Worker failed'));
    };
    this.viewWorker.onerror = (event) => {
      event.preventDefault();
      this.failView(new Error(event.message || 'Capture viewport Worker failed'));
    };
    const storageChannel = new MessageChannel();
    const viewChannel = new MessageChannel();
    try {
      this.worker.postMessage(
        {
          type: 'start',
          port: storageChannel.port1,
          channelCount,
          sampleRate: samplerate,
          labels: [...labels],
        } satisfies Request,
        [storageChannel.port1],
      );
      this.viewWorker.postMessage({ type: 'start', port: viewChannel.port1, channelCount } satisfies ViewRequest, [
        viewChannel.port1,
      ]);
      source.connectConsumer(storageChannel.port2);
      source.connectConsumer(viewChannel.port2);
    } catch (error) {
      storageChannel.port2.close();
      viewChannel.port2.close();
      this.worker.terminate();
      this.viewWorker.terminate();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  get length(): bigint {
    return this.latestLength;
  }
  get publishedLength(): bigint {
    return this.latestLength;
  }
  get processedLength(): bigint {
    return this.terminal?.length ?? this.latestLength;
  }
  get terminalState(): SharedCaptureState {
    return this.terminal?.state ?? 'open';
  }
  get errorMessage(): string | undefined {
    return this.terminal?.error ?? this.failure?.message ?? this.viewTerminal?.error ?? this.viewFailure?.message;
  }
  get revision(): number {
    return this.sequence;
  }
  append(_chunk: Uint8Array): void {
    throw new Error('Shared worker store is read-only on the UI thread');
  }
  noteGap(_start: SampleInput, _end: SampleInput): void {
    throw new Error('Shared worker store does not accept UI-thread writes');
  }
  gaps(): GapSpan[] {
    return [];
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
    if (!unique.length) return;
    const fresh = (channel: number): RemoteView | undefined => {
      const key = keyFor(channel, start, end, bins);
      const cached = this.views.get(key),
        requiredEnd = end < this.latestLength ? end : this.latestLength;
      return cached && cached.availableEnd >= requiredEnd && (!includeEdges || cached.edges !== null)
        ? cached
        : undefined;
    };
    const missing = unique.filter((channel) => !fresh(channel));
    if (!missing.length) return;
    const pendingKey = `batch:${start}:${end}:${bins}:${includeEdges ? 1 : 0}:${missing.join(',')}`;
    const pending = this.pendingViews.get(pendingKey);
    if (pending) {
      await pending;
      return;
    }
    const task = (async (): Promise<void> => {
      const loaded = new Map<number, { view: ColumnView; availableEnd: bigint }>();
      if (missing.length > 1 && end <= MAX_SAFE_SAMPLE && this.latestLength <= MAX_SAFE_SAMPLE) {
        const response = await this.requestView({
          type: 'query-many',
          id: this.nextId++,
          channels: missing,
          startSample: start,
          endSample: end,
          bins,
        });
        if (response.type !== 'query-many-result') throw new Error('Invalid shared viewport batch response');
        for (const result of response.results)
          loaded.set(result.channel, {
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
          });
      } else {
        await Promise.all(
          missing.map(async (channel) => {
            const response = await this.requestView({
              type: 'query',
              id: this.nextId++,
              channel,
              startSample: start,
              endSample: end,
              bins,
            });
            if (response.type !== 'query-result') throw new Error('Invalid shared viewport response');
            loaded.set(channel, {
              availableEnd: response.availableEnd,
              view: {
                channel: response.channel,
                startSample: response.startSample,
                endSample: response.endSample,
                bins: response.bins,
                low: response.low,
                high: response.high,
                edge: response.edge,
                packed: response.packed,
                ...(response.points ? { points: response.points } : {}),
              },
            });
          }),
        );
      }
      await Promise.all(
        [...loaded.values()].map(async ({ view, availableEnd }) => {
          const key = keyFor(view.channel, start, end, bins);
          let edges: bigint[] | null = null;
          if (includeEdges && edges === null) {
            const edgeResponse = await this.requestView({
              type: 'edges',
              id: this.nextId++,
              channel: view.channel,
              startSample: start,
              endSample: end,
            });
            if (edgeResponse.type !== 'edges-result') throw new Error('Invalid shared viewport edge response');
            edges = edgeResponse.edges;
          }
          this.views.set(key, { view, edges, availableEnd });
          while (this.views.size > 96) this.views.delete(this.views.keys().next().value!);
        }),
      );
    })();
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
      key = keyFor(channel, start, end, bins),
      prepared = this.views.get(key);
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
      end = BigInt(endInput),
      prepared = this.views.get(keyFor(channel, start, end, Math.max(1, Math.floor(Number(end - start)))));
    if (prepared?.edges) return prepared.edges;
    for (const [key, value] of this.views)
      if (key.startsWith(`${channel}:${start}:${end}:`) && value.edges) return value.edges;
    return [];
  }
  edgeCount(channel: number, start: SampleInput, end: SampleInput): number {
    return this.edges(channel, start, end).length;
  }
  sampleAt(_channel: number, _sample: SampleInput): number {
    throw new Error('Use the shared decoder or request a prepared viewport');
  }
  memory(): MemoryReport {
    const pyramidBytes = this.latestSummaryBytes + this.latestViewSummaryBytes;
    return { baseBytes: 0, pyramidBytes, totalBytes: pyramidBytes, overhead: 0, slackBytes: 0 };
  }
  async readPackedRange(startSample: bigint, endSample: bigint, channels = this.channelCount): Promise<Uint8Array> {
    const response = await this.request({ type: 'pack', id: this.nextId++, startSample, endSample, channels });
    if (response.type !== 'pack-result') throw new Error('Invalid shared packed-data response');
    return response.data;
  }
  exportSR(
    workspace: WorkspaceSettings | undefined,
    triggerSample: bigint,
    acquisition: AcquisitionResult | undefined,
    signal?: AbortSignal,
  ): Promise<Blob> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.disposed) return Promise.reject(new DOMException('Shared capture store disposed', 'AbortError'));
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
        this.worker.postMessage({ type: 'cancel-export', id } satisfies Request);
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
        this.worker.postMessage({
          type: 'export-sr',
          id,
          ...(workspace ? { workspace } : {}),
          triggerSample,
          ...(acquisition ? { acquisition } : {}),
        } satisfies Request);
      } catch (error) {
        this.pending.delete(id);
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }
  connectPackedReader(port: MessagePort): void {
    this.worker.postMessage({ type: 'reader', port } satisfies Request, [port]);
  }
  async finishStorage(): Promise<Extract<Response, { type: 'done' }>> {
    this.worker.postMessage({ type: 'finish' } satisfies Request);
    return this.done;
  }
  async finishViews(): Promise<Extract<ViewResponse, { type: 'done' }>> {
    this.viewWorker.postMessage({ type: 'finish' } satisfies ViewRequest);
    return this.viewDone;
  }
  async finish(): Promise<Extract<Response, { type: 'done' }>> {
    const [stored] = await Promise.all([this.finishStorage(), this.finishViews()]);
    return stored;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.viewWorker.terminate();
    const error = new DOMException('Shared capture store disposed', 'AbortError');
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    for (const item of this.viewPending.values()) item.reject(error);
    this.viewPending.clear();
    this.views.clear();
    this.pendingViews.clear();
    this.doneReject(error);
    this.viewDoneReject(error);
  }
  private failStorage(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    this.doneReject(error);
    this.worker.terminate();
  }
  private failView(error: Error): void {
    if (this.viewFailure) return;
    this.viewFailure = error;
    for (const item of this.viewPending.values()) item.reject(error);
    this.viewPending.clear();
    this.viewDoneReject(error);
    this.viewWorker.terminate();
  }
  private request(request: Extract<Request, { type: 'query' | 'edges' | 'pack' }>): Promise<Response> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private requestView(
    request: Extract<ViewRequest, { type: 'query' | 'query-many' | 'edges' }>,
  ): Promise<ViewResponse> {
    if (this.viewFailure) return Promise.reject(this.viewFailure);
    return new Promise((resolve, reject) => {
      this.viewPending.set(request.id, { resolve, reject });
      try {
        this.viewWorker.postMessage(request);
      } catch (error) {
        this.viewPending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
