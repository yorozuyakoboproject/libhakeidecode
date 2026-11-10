const WINDOW_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;

type Chunk = { data: ArrayBuffer; offset: number; consumed: number };
type Read = { length: number; resolve(value: DataView): void; reject(error: Error): void };
export class RelayData {
  readonly socket: WebSocket;
  readonly ready: Promise<void>;
  private readonly chunks: Chunk[] = [];
  private readonly reads: Read[] = [];
  private readonly delivered = new Map<DataView, { chunk: Chunk; length: number }>();
  private error?: Error;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private lastAck = performance.now();
  private ackMessages = 0;
  private consumedBytes = 0;
  private receivedBytes = 0;
  private closed?: Promise<void>;
  private closeResolve?: () => void;
  private lastMessageAt = 0;
  readonly metrics = {
    protocol: 'ws-consumed-v1',
    receivedBytes: 0,
    consumedBytes: 0,
    acknowledgedBytes: 0,
    messages: 0,
    acks: 0,
    queuedBytes: 0,
    queuePeakBytes: 0,
    deliveredBytes: 0,
    deliveredPeakBytes: 0,
    pendingReadsPeak: 0,
    messageGapMaxMs: 0,
    recentGaps: [] as { atUnixMs: number; ms: number }[],
  };
  constructor(url: string) {
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    this.closed = new Promise<void>((resolve) => {
      this.closeResolve = resolve;
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('USB relay data connection timed out');
        this.fail(error);
        reject(error);
      }, 5000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        const error = new Error('USB relay data connection failed; check relay version and interface ownership');
        this.fail(error);
        reject(error);
      };
      socket.onclose = () => {
        clearTimeout(timer);
        const error = this.error ?? new Error('USB relay data connection ended; capture stopped');
        this.fail(error);
        reject(error);
        this.closeResolve?.();
      };
    });
    void this.ready.catch(() => {});
    socket.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      if (this.error) return;
      if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > MAX_MESSAGE_BYTES) {
        this.fail(new Error('Invalid USB relay data message'));
        return;
      }
      const at = performance.now();
      if (this.lastMessageAt) {
        const gap = at - this.lastMessageAt;
        this.metrics.messageGapMaxMs = Math.max(this.metrics.messageGapMaxMs, gap);
        if (gap >= 20) {
          if (this.metrics.recentGaps.length === 16) this.metrics.recentGaps.shift();
          this.metrics.recentGaps.push({ atUnixMs: performance.timeOrigin + this.lastMessageAt, ms: gap });
        }
      }
      this.lastMessageAt = at;
      this.receivedBytes += data.byteLength;
      this.metrics.receivedBytes = this.receivedBytes;
      this.metrics.queuedBytes += data.byteLength;
      this.metrics.queuePeakBytes = Math.max(this.metrics.queuePeakBytes, this.metrics.queuedBytes);
      ++this.metrics.messages;
      if (this.receivedBytes - this.consumedBytes > WINDOW_BYTES) {
        this.fail(new Error('USB relay exceeded data receive window'));
        return;
      }
      this.chunks.push({ data, offset: 0, consumed: 0 });
      this.drain();
    };
  }
  private drain(): void {
    while (this.reads.length) {
      const chunk = this.chunks.find((entry) => entry.offset < entry.data.byteLength);
      if (!chunk) return;
      const read = this.reads.shift()!;
      const length = Math.min(read.length, chunk.data.byteLength - chunk.offset);
      const value = new DataView(chunk.data, chunk.offset, length);
      chunk.offset += length;
      this.delivered.set(value, { chunk, length });
      this.metrics.queuedBytes -= length;
      this.metrics.deliveredBytes += length;
      this.metrics.deliveredPeakBytes = Math.max(this.metrics.deliveredPeakBytes, this.metrics.deliveredBytes);
      read.resolve(value);
    }
  }
  read(length: number): Promise<DataView> {
    if (!Number.isSafeInteger(length) || length < 1) return Promise.reject(new Error('Invalid USB receive length'));
    if (this.error) return Promise.reject(this.error);
    if (this.reads.length >= 128) return Promise.reject(new Error('Too many USB receive requests'));
    return new Promise<DataView>((resolve, reject) => {
      this.reads.push({ length, resolve, reject });
      this.metrics.pendingReadsPeak = Math.max(this.metrics.pendingReadsPeak, this.reads.length);
      this.drain();
    });
  }
  consume(value: DataView): void {
    const delivered = this.delivered.get(value);
    if (!delivered || this.error) return;
    this.delivered.delete(value);
    delivered.chunk.consumed += delivered.length;
    this.metrics.deliveredBytes -= delivered.length;
    while (this.chunks.length && this.chunks[0]!.consumed === this.chunks[0]!.data.byteLength) {
      this.consumedBytes += this.chunks.shift()!.data.byteLength;
      ++this.ackMessages;
    }
    this.metrics.consumedBytes = this.consumedBytes;
    if (this.ackMessages >= 4 || performance.now() - this.lastAck >= 4) this.ack();
    else if (this.ackMessages && !this.ackTimer) this.ackTimer = setTimeout(() => this.ack(), 4);
  }
  private ack(): void {
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (!this.ackMessages || this.error || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ consumedBytes: this.consumedBytes }));
    this.metrics.acknowledgedBytes = this.consumedBytes;
    ++this.metrics.acks;
    this.ackMessages = 0;
    this.lastAck = performance.now();
  }
  fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    for (const read of this.reads.splice(0)) read.reject(error);
    this.chunks.length = 0;
    this.delivered.clear();
    this.metrics.queuedBytes = 0;
    this.metrics.deliveredBytes = 0;
    this.socket.close();
  }
  async stop(): Promise<void> {
    this.ack();
    this.fail(new Error('USB data reception stopped'));
    await Promise.race([this.closed, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
  }
}
