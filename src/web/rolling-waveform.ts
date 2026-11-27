import type { SampleRing, RingSnapshot, IndexedPage } from './sample-ring.js';
import type { DigitalViewRequest, DigitalViewResult } from './digital-view.js';

export type WaveformRequest =
  | { type: 'view'; snapshot: RingSnapshot; request: DigitalViewRequest; channels: number; rate: number }
  | { type: 'pages'; pages: IndexedPage[] };
export type WaveformResponse =
  | { type: 'ready' }
  | { type: 'result'; result: DigitalViewResult; elapsedMs: number }
  | { type: 'error'; message: string };
type Job = { request: DigitalViewRequest; resolve(result: DigitalViewResult): void; reject(error: Error): void };

export class RollingWaveformReader {
  readonly diagnostics = { queries: 0, totalMs: 0, maxMs: 0, aborted: 0 };
  private worker?: Worker;
  private ready = false;
  private active?: Job;
  private pending?: Job;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(
    private readonly ring: SampleRing,
    private readonly channels: number,
    private readonly rate: number,
  ) {
    this.start();
  }
  read(request: DigitalViewRequest): Promise<DigitalViewResult> {
    if (this.disposed) return Promise.reject(new Error('Waveform reader is closed'));
    return new Promise((resolve, reject) => {
      this.pending?.reject(new DOMException('Superseded waveform view', 'AbortError'));
      this.pending = { request, resolve, reject };
      this.pump();
    });
  }
  private start(): void {
    this.ready = false;
    const worker = new Worker(new URL('./waveform-worker.js', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<WaveformResponse>) => {
      if (worker !== this.worker) return;
      if (data.type === 'ready') {
        this.ready = true;
        this.pump();
        return;
      }
      const job = this.active;
      if (!job) return;
      clearTimeout(this.timer);
      const pages = this.ring.unpin();
      if (pages.length) worker.postMessage({ type: 'pages', pages } satisfies WaveformRequest);
      this.active = undefined;
      if (data.type === 'error') job.reject(new Error(data.message));
      else {
        this.diagnostics.queries++;
        this.diagnostics.totalMs += data.elapsedMs;
        this.diagnostics.maxMs = Math.max(this.diagnostics.maxMs, data.elapsedMs);
        job.resolve(data.result);
      }
      this.pump();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.abort(new Error(event.message));
    };
  }
  private pump(): void {
    if (!this.ready || this.active || !this.pending || this.disposed) return;
    this.active = this.pending;
    this.pending = undefined;
    const snapshot = this.ring.pin(() =>
      this.abort(new DOMException('Waveform view exceeded its page budget', 'AbortError')),
    );
    this.worker!.postMessage({
      type: 'view',
      snapshot,
      request: this.active.request,
      channels: this.channels,
      rate: this.rate,
    } satisfies WaveformRequest);
    this.timer = setTimeout(() => this.abort(new DOMException('Waveform view timed out', 'AbortError')), 1500);
  }
  private abort(error: Error): void {
    if (this.active) this.diagnostics.aborted++;
    this.worker?.terminate();
    clearTimeout(this.timer);
    this.active?.reject(error);
    this.pending?.reject(error);
    this.active = this.pending = undefined;
    this.ring.unpin();
    this.ring.republish();
    if (!this.disposed) this.start();
  }
  dispose(): void {
    this.disposed = true;
    this.abort(new DOMException('Waveform reader closed', 'AbortError'));
  }
}
