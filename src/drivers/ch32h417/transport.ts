import {
  BLOCK_BYTES,
  Command,
  DATA,
  ANALOG,
  EP_IN,
  EP_OUT,
  FrameParser,
  INTERFACE,
  MAX_FRAME_BYTES,
  RESPONSE,
  encodeCommand,
  readStatus,
  type Frame,
} from './protocol.js';

export interface UsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber?: string;
  readonly configuration?: {
    configurationValue: number;
    interfaces: readonly {
      interfaceNumber: number;
      alternates: readonly {
        endpoints: readonly { endpointNumber: number; direction: string; type: string; packetSize: number }[];
      }[];
    }[];
  } | null;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  claimInterface(value: number): Promise<void>;
  releaseInterface(value: number): Promise<void>;
  transferOut(endpoint: number, data: Uint8Array): Promise<{ status: string; bytesWritten?: number }>;
  transferIn(endpoint: number, length: number): Promise<{ status: string; data?: DataView }>;
}
export interface UsbApi {
  requestDevice(options: { filters: { vendorId: number; productId: number }[] }): Promise<UsbDevice>;
  getDevices(): Promise<UsbDevice[]>;
  addEventListener?(type: string, listener: (event: { device: UsbDevice }) => void): void;
  removeEventListener?(type: string, listener: (event: { device: UsbDevice }) => void): void;
}
export function browserUsb(): UsbApi {
  const usb = (globalThis.navigator as (Navigator & { usb?: UsbApi }) | undefined)?.usb;
  if (!usb) throw new Error('WebUSB requires Chrome/Edge on HTTPS or localhost');
  return usb;
}
export async function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const errors = [
  'OK',
  'invalid configuration/session',
  'resource busy (stop USB benchmark first)',
  'capture overflow',
  'device disconnected',
  'heartbeat expired',
  'USB failure',
  'capture stopped',
  'input pins are occupied; change the channel selection or release the pins in the management page',
];
export function statusError(error: number, samples?: bigint): Error {
  const detail = samples === undefined ? '' : ` after ${samples.toString()} samples`;
  return new Error(`H417: ${errors[error] ?? `device error ${error}`}${detail}`);
}
export const USB_READ_DEPTH = 32;
export const USB_READ_BYTES = 256 * 1024;
const FRAMES_PER_READ = Math.ceil(USB_READ_BYTES / BLOCK_BYTES) + 1;
export const USB_QUEUE_BLOCKS = 2048;
export const TRANSPORT_WORKING_BYTES =
  USB_READ_BYTES * (USB_READ_DEPTH + 1) + MAX_FRAME_BYTES * (USB_QUEUE_BLOCKS + FRAMES_PER_READ + 6) + 1024;

export class H417Transport {
  packet: 512 | 1024 = 1024;
  session = 0;
  active = false;
  private closed = false;
  private error: Error | null = null;
  private requestId = crypto.getRandomValues(new Uint32Array(1))[0]!;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<
    number,
    { type: number; resolve(frame: Frame): void; reject(error: unknown): void }
  >();
  private readonly queue: Frame[] = [];
  private wake: (() => void) | null = null;
  private room: (() => void) | null = null;
  private endWake: (() => void) | null = null;
  private ended = false;
  private discarding = false;
  private starting = false;
  private first = 0n;
  private analogFirst = [0n, 0n];
  private sequence = 0;
  private shutdown: Promise<void> | null = null;
  private readonly counters = { reads: 0, receivedBytes: 0, parserMs: 0, queuePeak: 0, dataFrames: 0 };
  constructor(readonly device: UsbDevice) {}
  get metrics(): Readonly<typeof this.counters> {
    return this.counters;
  }
  async open(): Promise<void> {
    await this.device.open();
    if (this.device.configuration?.configurationValue !== 1)
      throw new Error('H417 is not configured; initialize UHSIF in the management webpage first');
    const iface = this.device.configuration?.interfaces.find((i) => i.interfaceNumber === INTERFACE);
    const endpoints = iface?.alternates[0]?.endpoints;
    const out = endpoints?.find((e) => e.endpointNumber === EP_OUT && e.direction === 'out' && e.type === 'bulk');
    const input = endpoints?.find((e) => e.endpointNumber === EP_IN && e.direction === 'in' && e.type === 'bulk');
    if (!out || !input || ![512, 1024].includes(input.packetSize) || out.packetSize !== input.packetSize)
      throw new Error(
        'H417 logic analyzer Interface 1 is unavailable; initialize UHSIF in the management webpage first, then reconnect the analyzer',
      );
    this.packet = input.packetSize as 512 | 1024;
    await this.device.claimInterface(INTERFACE);
    void this.readLoop().catch((error) => this.fail(error));
  }
  private fail(value: unknown): void {
    if (this.closed || this.error) return;
    this.error = value instanceof Error ? value : new Error(String(value));
    for (const pending of this.pending.values()) pending.reject(this.error);
    this.pending.clear();
    this.wake?.();
    this.room?.();
    this.endWake?.();
  }
  abort(error: unknown): void {
    this.fail(error);
  }
  private receive(frame: Frame): void {
    if (frame.type & RESPONSE) {
      const pending = this.pending.get(frame.requestId);
      if (!pending && !this.active && !this.starting) return;
      if (!pending || frame.type !== (pending.type | RESPONSE)) throw new Error('Unexpected H417 response');
      this.pending.delete(frame.requestId);
      pending.resolve(frame);
      return;
    }
    if (!this.active && !this.starting && !this.session) return;
    if (!this.active && !this.starting) throw new Error('Unexpected H417 sample session');
    if (!this.session && this.starting) this.session = frame.session;
    if (
      !frame.session ||
      frame.session !== this.session ||
      frame.sequence !== this.sequence ||
      (frame.type !== ANALOG && frame.firstSample !== this.first) ||
      frame.requestId !== 0
    )
      throw new Error('H417 stream discontinuity (session, sequence or sample index)');
    if (frame.type === DATA) {
      this.first += BigInt(frame.payload.length);
      this.sequence = (this.sequence + 1) >>> 0;
      this.counters.dataFrames++;
    } else if (frame.type === ANALOG) {
      const a = frame.analog!;
      const stream = a.timing.bits === 10 ? 1 : 0;
      const channels = (a.mask & 1 ? 1 : 0) + (a.mask & 2 ? 1 : 0);
      if (frame.firstSample !== this.analogFirst[stream] || frame.payload.length % (2 * channels))
        throw new Error('H417 analog stream discontinuity');
      this.analogFirst[stream] += BigInt(frame.payload.length / 2 / channels);
      this.sequence = (this.sequence + 1) >>> 0;
      this.counters.dataFrames++;
    } else {
      const status = readStatus(frame.payload);
      const counts = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
      if (
        frame.payload.length !== 32 ||
        status.samples !== this.first ||
        counts.getBigUint64(16, true) !== this.analogFirst[0] ||
        counts.getBigUint64(24, true) !== this.analogFirst[1]
      )
        throw new Error('Invalid H417 final sample count');
      this.ended = true;
      this.endWake?.();
      this.wake?.();
      this.wake = null;
    }
    if (!this.discarding) {
      if (this.queue.length >= USB_QUEUE_BLOCKS + FRAMES_PER_READ) throw new Error('H417 host receive queue overflow');
      this.queue.push(frame);
      this.counters.queuePeak = Math.max(this.counters.queuePeak, this.queue.length);
      this.wake?.();
      this.wake = null;
    }
  }
  private async readLoop(): Promise<void> {
    const parser = new FrameParser(this.packet, (frame) => this.receive(frame));
    const frameBytes = this.packet + BLOCK_BYTES,
      readBytes = USB_READ_BYTES - (USB_READ_BYTES % frameBytes);
    const read = () => {
      this.counters.reads++;
      return this.device.transferIn(EP_IN, readBytes).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    };
    const inflight = Array.from({ length: USB_READ_DEPTH }, read);
    while (!this.closed) {
      const result = await inflight.shift()!;
      if (this.closed) return;
      if ('error' in result) throw result.error;
      if (result.value.status !== 'ok' || !result.value.data?.byteLength)
        throw new Error('H417 bulk IN failed or stalled');
      const data = result.value.data;
      this.counters.receivedBytes += data.byteLength;
      inflight.push(read());
      const parseStarted = performance.now();
      parser.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      this.counters.parserMs += performance.now() - parseStarted;
      while (this.queue.length >= USB_QUEUE_BLOCKS && !this.discarding && !this.closed && !this.error)
        await new Promise<void>((resolve) => {
          this.room = resolve;
        });
      if (this.closed || this.error) return;
    }
  }
  command(type: number, payload?: Uint8Array): Promise<Frame> {
    const run = this.serial.then(async () => {
      if (this.closed || this.error) throw this.error ?? new Error('H417 connection closed');
      this.requestId = (this.requestId + 1) >>> 0 || 1;
      const id = this.requestId;
      const bytes = encodeCommand(type, id, this.session, this.packet, payload);
      let rejectReply!: (error: unknown) => void;
      const reply = new Promise<Frame>((resolve, reject) => {
        rejectReply = reject;
        this.pending.set(id, { type, resolve, reject });
      });
      void reply.catch(() => {});
      try {
        const frame = await deadline(
          (async () => {
            const sent = await this.device.transferOut(EP_OUT, bytes);
            if (sent.status !== 'ok' || sent.bytesWritten !== bytes.length)
              throw new Error('H417 bulk OUT failed or stalled');
            return await reply;
          })(),
          2000,
          'H417 command timeout',
        );
        const status = readStatus(frame.payload);
        if (status.error) throw statusError(status.error);
        return frame;
      } catch (error) {
        rejectReply(error);
        throw error;
      } finally {
        this.pending.delete(id);
      }
    });
    this.serial = run.catch(() => {});
    return run;
  }
  async start(payload: Uint8Array): Promise<void> {
    await this.command(Command.config, payload);
    this.starting = true;
    try {
      const frame = await this.command(Command.start);
      if (!frame.session || (this.session && this.session !== frame.session))
        throw new Error('Invalid H417 START session');
      this.session = frame.session;
      this.active = true;
    } finally {
      this.starting = false;
    }
  }
  async next(): Promise<Frame | null> {
    while (!this.queue.length && !this.error && !this.closed && !this.ended)
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    const frame = this.queue.shift();
    this.room?.();
    this.room = null;
    if (frame) return frame;
    if (this.error) throw this.error;
    return null;
  }
  stop(): Promise<void> {
    if (!this.active || this.ended || this.closed || this.error) return Promise.resolve();
    return (this.shutdown ??= (async () => {
      this.discarding = true;
      this.queue.length = 0;
      this.room?.();
      this.wake?.();
      if (!this.active || this.ended || this.closed || this.error) return;
      try {
        await deadline(
          (async () => {
            await this.command(Command.stop);
            if (!this.ended && !this.error)
              await new Promise<void>((resolve) => {
                this.endWake = resolve;
              });
            if (this.error) throw this.error;
          })(),
          2200,
          'H417 STOP/drain timeout',
        );
      } finally {
        this.active = false;
      }
    })());
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.serial;
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    this.room?.();
    this.endWake?.();
    for (const pending of this.pending.values()) pending.reject(new Error('H417 connection closed'));
    this.pending.clear();
    if (this.device.opened) await deadline(this.device.close(), 2000, 'H417 close timeout');
  }
}
