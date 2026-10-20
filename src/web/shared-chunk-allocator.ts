type AllocateRequest = { id: number; byteLength: number };
type AllocateResponse = { id: number; buffer?: SharedArrayBuffer; error?: string };
export class SharedChunkAllocator {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(buffer: SharedArrayBuffer): void; reject(error: Error): void }>();
  private readonly worker: Worker;
  constructor() {
    this.worker = new Worker(new URL('./shared-allocator-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<AllocateResponse>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error || !data.buffer) request.reject(new RangeError(data.error ?? 'Shared buffer allocation failed'));
      else request.resolve(data.buffer);
    };
    this.worker.onerror = event => {
      event.preventDefault();
      const error = new Error(event.message || 'Shared buffer allocator Worker failed');
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
  }
  allocate(byteLength: number): Promise<SharedArrayBuffer> {
    if (!Number.isSafeInteger(byteLength) || byteLength < 1) return Promise.reject(new RangeError('Invalid shared allocation size'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, byteLength } satisfies AllocateRequest); }
      catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  close(): void {
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(new Error('Shared buffer allocator closed'));
    this.pending.clear();
  }
}
