export const DEFAULT_SHARED_CHUNK_BYTES = 128 * 1024 * 1024;
export const SHARED_SUMMARY_GROUP_SAMPLES = 1024;
const HEADER_BYTES = 64;
const COMMITTED_SAMPLES = 0;
const VALID_SAMPLES = 1;
const CHUNK_STATE = 2;

export type SharedCaptureState = 'open' | 'complete' | 'stopped' | 'error';
export interface SharedChunkDescriptor {
  readonly id: number;
  readonly startSample: bigint;
  readonly capacitySamples: number;
  readonly bytesPerSample: number;
  readonly buffer: SharedArrayBuffer;
}
export interface SharedSampleRead { readonly startSample: bigint; readonly sampleCount: number; readonly data: Uint8Array }
export interface SharedPublisherMetrics { readonly calls: number; readonly bytes: number; readonly totalMs: number; readonly maxMs: number }
export class SharedCaptureError extends Error {
  constructor(readonly captureState: 'stopped' | 'error', message: string) { super(message); this.name = 'SharedCaptureError'; }
}
type SharedMessage =
  | { type: 'directory'; sessionId: string; chunks: SharedChunkDescriptor[]; publishedSamples: bigint; state: SharedCaptureState; error?: string }
  | { type: 'chunk'; sessionId: string; chunk: SharedChunkDescriptor }
  | { type: 'commit'; sessionId: string; chunkId: number; committedSamples: number; publishedSamples: bigint }
  | { type: 'state'; sessionId: string; state: SharedCaptureState; publishedSamples: bigint; error?: string };
type ConsumerPort = MessagePort;

function checkChunkBytes(chunkBytes: number, bytesPerSample: number): void {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < bytesPerSample || !Number.isSafeInteger(bytesPerSample) || bytesPerSample < 1)
    throw new RangeError('Invalid shared chunk layout');
  if (Math.floor(chunkBytes / bytesPerSample) > 0x7fffffff) throw new RangeError('Shared chunk exceeds atomic sample count');
}
function sharedHeader(chunk: SharedChunkDescriptor): Int32Array { return new Int32Array(chunk.buffer, 0, HEADER_BYTES / 4); }

export interface SharedChunkProducerOptions {
  readonly sampleCount: bigint;
  readonly bytesPerSample?: number;
  readonly chunkBytes?: number;
  readonly sessionId?: string;

  readonly allocate?: (byteLength: number) => SharedArrayBuffer | Promise<SharedArrayBuffer>;

  readonly onProgress?: (allocatedBytes: number, publishedSamples: bigint, publisher: SharedPublisherMetrics) => void;
}
interface PendingAllocation { capacitySamples: number; byteLength: number; buffer?: SharedArrayBuffer; promise: Promise<SharedArrayBuffer> }
export class SharedChunkProducer {
  readonly sessionId: string;
  readonly bytesPerSample: number;
  readonly chunkBytes: number;
  readonly sampleCount: bigint;
  private readonly allocate: (byteLength: number) => SharedArrayBuffer | Promise<SharedArrayBuffer>;
  private readonly onProgress?: SharedChunkProducerOptions['onProgress'];
  private readonly directory: SharedChunkDescriptor[] = [];
  private readonly consumers = new Set<ConsumerPort>();
  private active: SharedChunkDescriptor | null = null;
  private prepared: { capacitySamples: number; buffer: SharedArrayBuffer } | null = null;
  private allocation: PendingAllocation | null = null;
  private published = 0n;
  private terminalState: SharedCaptureState = 'open';
  private terminalError: string | undefined;
  private readonly publisher = { calls: 0, bytes: 0, totalMs: 0, maxMs: 0 };

  constructor(options: SharedChunkProducerOptions) {
    if (typeof SharedArrayBuffer === 'undefined') throw new Error('SharedArrayBuffer is unavailable; serve the page in a cross-origin isolated context');
    if (options.sampleCount < 0n) throw new RangeError('Sample count must not be negative');
    this.sampleCount = options.sampleCount;
    this.bytesPerSample = options.bytesPerSample ?? 1;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_SHARED_CHUNK_BYTES;
    checkChunkBytes(this.chunkBytes, this.bytesPerSample);
    this.sessionId = options.sessionId ?? `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.allocate = options.allocate ?? (size => new SharedArrayBuffer(size));
    this.onProgress = options.onProgress;
  }
  get length(): bigint { return this.published; }
  get chunks(): readonly SharedChunkDescriptor[] { return this.directory; }
  get state(): SharedCaptureState { return this.terminalState; }
  get publisherMetrics(): SharedPublisherMetrics { return { ...this.publisher }; }
  get allocatedBytes(): number {
    return this.directory.reduce((sum, chunk) => sum + chunk.buffer.byteLength, 0)
      + (this.prepared?.buffer.byteLength ?? 0) + (this.allocation?.buffer?.byteLength ?? 0);
  }

  async prepare(): Promise<void> {
    if (this.terminalState !== 'open') throw new Error('Shared capture is already terminal');
    if (this.sampleCount === 0n || this.active) return;
    const capacitySamples = this.capacityAt(this.published);
    try {
      const buffer = await this.takeBuffer(capacitySamples);
      this.publishChunk(capacitySamples, buffer);
    } catch (error) {
      this.finish('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  addConsumer(port: MessagePort): void {
    if (this.terminalState !== 'open') {
      port.start();
      port.postMessage(this.directoryMessage());
      return;
    }
    const consumer = port as ConsumerPort;
    this.consumers.add(consumer);
    consumer.addEventListener('message', event => {
      if ((event.data as { type?: unknown })?.type === 'detach') this.consumers.delete(consumer);
    });
    consumer.start();
    consumer.postMessage(this.directoryMessage());
  }

  async append(data: Uint8Array): Promise<void> {
    if (this.terminalState !== 'open') throw new Error('Shared capture is already terminal');
    if (data.byteLength % this.bytesPerSample) throw new RangeError('Append must contain whole samples');
    const totalSamples = data.byteLength / this.bytesPerSample;
    if (this.published + BigInt(totalSamples) > this.sampleCount) throw new RangeError('Append exceeds requested sample count');
    let sourceOffset = 0;
    while (sourceOffset < data.byteLength) {
      const chunk = this.active ?? await this.createChunk();
      const header = sharedHeader(chunk), committed = Atomics.load(header, COMMITTED_SAMPLES);
      const capacityBytes = chunk.capacitySamples * this.bytesPerSample;
      const availableBytes = capacityBytes - committed * this.bytesPerSample;
      const countBytes = Math.min(availableBytes, data.byteLength - sourceOffset);
      const countSamples = countBytes / this.bytesPerSample;
      const publishStarted = performance.now();
      new Uint8Array(chunk.buffer, HEADER_BYTES + committed * this.bytesPerSample, countBytes)
        .set(data.subarray(sourceOffset, sourceOffset + countBytes));
      const nextCommitted = committed + countSamples;
      Atomics.store(header, VALID_SAMPLES, nextCommitted);
      Atomics.store(header, COMMITTED_SAMPLES, nextCommitted);
      this.published += BigInt(countSamples);
      sourceOffset += countBytes;
      this.broadcast({ type: 'commit', sessionId: this.sessionId, chunkId: chunk.id, committedSamples: nextCommitted, publishedSamples: this.published });
      const publishMs = performance.now() - publishStarted;
      this.publisher.calls++; this.publisher.bytes += countBytes;
      this.publisher.totalMs += publishMs; this.publisher.maxMs = Math.max(this.publisher.maxMs, publishMs);
      this.reportProgress();
      if (nextCommitted === chunk.capacitySamples) this.active = null;
      else if (nextCommitted * 4 >= chunk.capacitySamples * 3) this.preallocateNext();
    }
  }

  finish(state: Exclude<SharedCaptureState, 'open'>, error?: string): void {
    if (this.terminalState !== 'open') return;
    if (state === 'complete' && this.published !== this.sampleCount) throw new Error('Cannot complete before the requested sample count is committed');
    this.terminalState = state;
    this.terminalError = error;
    for (const chunk of this.directory) Atomics.store(sharedHeader(chunk), CHUNK_STATE, stateCode(state));
    this.broadcast({ type: 'state', sessionId: this.sessionId, state, publishedSamples: this.published, ...(error ? { error } : {}) });
    this.prepared = null;
    this.reportProgress();
  }

  private capacityAt(startSample: bigint): number {
    const maxSamples = Math.floor(this.chunkBytes / this.bytesPerSample);
    const remaining = this.sampleCount - startSample;
    return remaining < BigInt(maxSamples) ? Number(remaining) : maxSamples;
  }
  private requestAllocation(capacitySamples: number): PendingAllocation {
    const byteLength = HEADER_BYTES + capacitySamples * this.bytesPerSample;
    const pending: PendingAllocation = { capacitySamples, byteLength, promise: Promise.resolve().then(() => this.allocate(byteLength)) };
    pending.promise = pending.promise.then(buffer => {
      if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== byteLength) throw new Error('Shared chunk allocator returned an invalid buffer');
      pending.buffer = buffer;
      this.reportProgress();
      return buffer;
    });
    void pending.promise.catch(() => {});
    return pending;
  }
  private preallocateNext(): void {
    if (this.terminalState !== 'open' || this.prepared || this.allocation) return;
    const nextStart = this.active ? this.active.startSample + BigInt(this.active.capacitySamples) : this.published;
    if (nextStart >= this.sampleCount) return;
    this.allocation = this.requestAllocation(this.capacityAt(nextStart));
  }
  private async takeBuffer(capacitySamples: number): Promise<SharedArrayBuffer> {
    let pending = this.allocation;
    if (!pending || pending.capacitySamples !== capacitySamples) pending = this.requestAllocation(capacitySamples);
    try { return await pending.promise; }
    finally { if (this.allocation === pending) this.allocation = null; }
  }
  private publishChunk(capacitySamples: number, buffer: SharedArrayBuffer): SharedChunkDescriptor {
    const chunk: SharedChunkDescriptor = { id: this.directory.length, startSample: this.published, capacitySamples, bytesPerSample: this.bytesPerSample, buffer };
    this.directory.push(chunk); this.active = chunk;
    this.broadcast({ type: 'chunk', sessionId: this.sessionId, chunk });
    this.reportProgress();
    return chunk;
  }
  private async createChunk(): Promise<SharedChunkDescriptor> {
    const capacitySamples = this.capacityAt(this.published);
    if (capacitySamples <= 0) throw new Error('No sample capacity remains');
    let buffer: SharedArrayBuffer;
    try {
      buffer = this.prepared?.capacitySamples === capacitySamples ? this.prepared.buffer : await this.takeBuffer(capacitySamples);
    } catch (error) {
      this.finish('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.prepared = null;
    return this.publishChunk(capacitySamples, buffer);
  }
  private directoryMessage(): SharedMessage {
    return { type: 'directory', sessionId: this.sessionId, chunks: [...this.directory], publishedSamples: this.published,
      state: this.terminalState, ...(this.terminalError ? { error: this.terminalError } : {}) };
  }
  private broadcast(message: SharedMessage): void {
    for (const port of this.consumers) {
      try { port.postMessage(message); } catch { this.consumers.delete(port); }
    }
  }
  private reportProgress(): void {
    try { this.onProgress?.(this.allocatedBytes, this.published, this.publisherMetrics); } catch {   }
  }

}
function stateCode(state: SharedCaptureState): number { return state === 'complete' ? 1 : state === 'stopped' ? 2 : state === 'error' ? 3 : 0; }

export class SharedChunkReader {
  private readonly chunks = new Map<number, SharedChunkDescriptor>();
  private readonly orderedChunks: SharedChunkDescriptor[] = [];
  private cursor = 0n;
  private state: SharedCaptureState = 'open';
  private failure: string | undefined;
  private published = 0n;
  private session: string | null = null;
  private waiters = new Set<() => void>();
  private closed = false;
  private readonly onMessage = (event: MessageEvent<SharedMessage>): void => {
    const message = event.data;
    if (this.session !== null && message.sessionId !== this.session) return;
    if (this.session === null) this.session = message.sessionId;
    if (message.type === 'directory') {
      for (const chunk of message.chunks) this.addChunk(chunk);
      this.published = message.publishedSamples; this.state = message.state; this.failure = message.error;
    } else if (message.type === 'chunk') this.addChunk(message.chunk);
    else if (message.type === 'commit') this.published = message.publishedSamples;
    else { this.state = message.state; this.published = message.publishedSamples; this.failure = message.error; }
    this.wake();
  };

  constructor(readonly port: MessagePort, readonly bytesPerSample = 1) {
    if (!Number.isSafeInteger(bytesPerSample) || bytesPerSample < 1) throw new RangeError('Invalid sample width');
    port.addEventListener('message', this.onMessage as EventListener);
    port.start();
  }
  get readPosition(): bigint { return this.cursor; }
  get availableSamples(): bigint { return this.published - this.cursor; }
  get terminalState(): SharedCaptureState { return this.state; }
  get chunkCount(): number { return this.chunks.size; }

  readRange(startSample: bigint, endSample: bigint): Uint8Array | null {
    if (startSample < 0n || endSample < startSample) return null;
    if (startSample === endSample && startSample > this.published) return null;
    const length = endSample - startSample;
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Shared read range is too large');
    const output = new Uint8Array(Number(length) * this.bytesPerSample);
    let destination = 0;
    for (let position = startSample; position < endSample;) {
      const chunk = this.findChunk(position);
      if (!chunk) return null;
      const header = sharedHeader(chunk), committed = Atomics.load(header, COMMITTED_SAMPLES);
      const offset = Number(position - chunk.startSample);
      const available = committed - offset;
      if (available <= 0) return null;
      const count = Math.min(available, Number(endSample - position));
      const bytes = count * this.bytesPerSample;
      output.set(new Uint8Array(chunk.buffer, HEADER_BYTES + offset * this.bytesPerSample, bytes), destination);
      destination += bytes; position += BigInt(count);
    }
    return output;
  }

  readByte(sample: bigint): number | null {
    if (sample < 0n) return null;
    const chunk = this.findChunk(sample);
    if (!chunk) return null;
    const committed = Atomics.load(sharedHeader(chunk), COMMITTED_SAMPLES);
    const offset = Number(sample - chunk.startSample);
    if (offset >= committed) return null;
    return new Uint8Array(chunk.buffer, HEADER_BYTES + offset * this.bytesPerSample, this.bytesPerSample)[0]!;
  }

  async next(maxSamples = 1_048_576): Promise<SharedSampleRead | null> {
    if (!Number.isSafeInteger(maxSamples) || maxSamples < 1) throw new RangeError('maxSamples must be a positive safe integer');
    while (!this.closed) {
      const chunk = this.findChunk(this.cursor);
      if (chunk) {
        const header = sharedHeader(chunk), committed = Atomics.load(header, COMMITTED_SAMPLES);
        const offset = Number(this.cursor - chunk.startSample);
        if (committed > offset) {
          const sampleCount = Math.min(maxSamples, committed - offset);
          const data = new Uint8Array(chunk.buffer, HEADER_BYTES + offset * chunk.bytesPerSample, sampleCount * chunk.bytesPerSample);
          const startSample = this.cursor; this.cursor += BigInt(sampleCount);
          return { startSample, sampleCount, data };
        }
      }
      if (this.state !== 'open' && this.cursor >= this.published) {
        if (this.state === 'error' || this.state === 'stopped') throw new SharedCaptureError(this.state, this.failure ?? `Capture ${this.state}`);
        return null;
      }
      await this.waitForChange();
    }
    return null;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.port.removeEventListener('message', this.onMessage as EventListener);
    try { this.port.postMessage({ type: 'detach' }); } catch {}
    this.port.close(); this.wake();
  }
  private addChunk(chunk: SharedChunkDescriptor): void {
    if (chunk.bytesPerSample !== this.bytesPerSample || chunk.id < 0 || !Number.isSafeInteger(chunk.capacitySamples)
      || chunk.capacitySamples < 1 || chunk.startSample < 0n) throw new Error('Invalid shared chunk descriptor');
    const previous = this.chunks.get(chunk.id);
    if (previous && previous.buffer !== chunk.buffer) throw new Error('Shared chunk id was reused');
    this.chunks.set(chunk.id, chunk);
    const index = this.orderedChunks.findIndex(item => item.id === chunk.id);
    if (index >= 0) this.orderedChunks[index] = chunk;
    else if (!this.orderedChunks.length || chunk.startSample >= this.orderedChunks.at(-1)!.startSample) this.orderedChunks.push(chunk);
    else {
      const at = this.orderedChunks.findIndex(item => item.startSample > chunk.startSample);
      if (at < 0) this.orderedChunks.push(chunk); else this.orderedChunks.splice(at, 0, chunk);
    }
  }
  private findChunk(sample: bigint): SharedChunkDescriptor | undefined {
    let low = 0, high = this.orderedChunks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.orderedChunks[mid]!.startSample <= sample) low = mid + 1; else high = mid;
    }
    const chunk = this.orderedChunks[low - 1];
    return chunk && sample < chunk.startSample + BigInt(chunk.capacitySamples) ? chunk : undefined;
  }
  private waitForChange(): Promise<void> {
    return new Promise(resolve => this.waiters.add(resolve));
  }
  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
