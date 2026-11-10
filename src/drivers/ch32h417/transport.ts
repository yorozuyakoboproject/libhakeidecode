import { ComponentError } from '../../components.js';
import type { TransferProgress } from '../../libhakei/device.js';
import {
  BLOCK_BYTES,
  Command,
  DATA,
  ANALOG,
  EP_IN,
  EP_OUT,
  FrameParser,
  INTERFACE,
  ALTERNATE,
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
        alternateSetting: number;
        endpoints: readonly {
          endpointNumber: number;
          direction: string;
          type: string;
          packetSize: number;
        }[];
      }[];
    }[];
  } | null;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  claimInterface(value: number): Promise<void>;
  selectAlternateInterface(iface: number, alternate: number): Promise<void>;
  releaseInterface(value: number): Promise<void>;
  clearHalt?(direction: 'in' | 'out', endpoint: number): Promise<void>;
  transferOut(endpoint: number, data: Uint8Array): Promise<{ status: string; bytesWritten?: number }>;
  transferIn(endpoint: number, length: number): Promise<{ status: string; data?: DataView }>;
  consumeTransfer?(value: DataView): void;
  controlTransferIn?(
    setup: {
      requestType: 'vendor';
      recipient: 'device';
      request: number;
      value: number;
      index: number;
    },
    length: number,
  ): Promise<{ status: string; data?: DataView }>;
}
export interface UsbApi {
  requestDevice(options: { filters: { vendorId: number; productId: number }[] }): Promise<UsbDevice>;
  getDevices(): Promise<UsbDevice[]>;
  addEventListener?(type: string, listener: (event: { device: UsbDevice }) => void): void;
  removeEventListener?(type: string, listener: (event: { device: UsbDevice }) => void): void;
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
  'compression processing deadline exceeded',
  'input sequence error',
  'invalid DMA block length',
  'capture resource registry is full',
];
export function statusError(error: number, samples?: bigint): Error {
  const category =
    error === 3
      ? 'captureOverflow'
      : error === 6
        ? 'usbTransfer'
        : error === 9
          ? 'encoding'
          : error === 10
            ? 'inputSequence'
            : error === 11
              ? 'dmaTransfer'
              : error === 12
                ? 'resourceFull'
                : undefined;
  if (category) return new ComponentError(`driver.ch32h417.error.${category}`, { samples: samples?.toString() ?? '0' });
  const detail = samples === undefined ? '' : ` after ${samples.toString()} samples`;
  return new Error(`H417: ${errors[error] ?? `device error ${error}`}${detail}`);
}
export const USB_READ_DEPTH = 32;
export const USB_READ_BYTES = 768 * 1024;
const FRAMES_PER_READ = Math.ceil(USB_READ_BYTES / 512) + 1;
export const USB_QUEUE_BLOCKS = 2048;
export const TRANSPORT_WORKING_BYTES =
  USB_READ_BYTES * (USB_READ_DEPTH + 1) + MAX_FRAME_BYTES * (USB_QUEUE_BLOCKS + FRAMES_PER_READ + 6) + 1024;

export class H417Transport {
  onTransferProgress?: (progress: TransferProgress) => void;
  private transfer?: {
    started: number;
    reportedAt: number;
    reportedBytes: number;
    bytes: number;
    receivedAt: number;
    timer?: ReturnType<typeof setInterval>;
  };
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
  sampleBytes = 1;
  private lastReadCompleted = 0;
  private lastKeepalive = 0;
  private heartbeatPending: Promise<void> | null = null;
  private first = 0n;
  private analogFirst = [0n, 0n];
  private sequence = 0;
  private shutdown: Promise<void> | null = null;
  private readonly counters = {
    reads: 0,
    receivedBytes: 0,
    parserMs: 0,
    queuePeak: 0,
    receiveQueuePauses: 0,
    receiveQueueWaitMs: 0,
    dataFrames: 0,
    dataCore: 0,
    codecRawBytes: 0,
    codecWireBytes: 0,
    codecCycles: 0,
    codecMaxCycles: 0,
    codecDecodeMs: 0,
    codecMaxHoldMs: 0,
    codecQueuePeak: 0,
    codecBlocks: 0,
    usbReadMaxMs: 0,
    usbReadMaxGapMs: 0,
    parserStartDelayMaxMs: 0,
  };
  private parser?: FrameParser;
  constructor(readonly device: UsbDevice) {}
  get metrics(): Readonly<typeof this.counters> {
    return this.counters;
  }
  private reportTransfer(complete = false): void {
    const transfer = this.transfer;
    if (!transfer) return;
    const now = complete && transfer.receivedAt ? transfer.receivedAt : performance.now();
    const elapsedMs = now - transfer.started;
    const interval = now - transfer.reportedAt;
    const averageBytesPerSecond = elapsedMs > 0 ? (transfer.bytes * 1000) / elapsedMs : 0;
    if (complete) {
      clearInterval(transfer.timer);
      this.transfer = undefined;
    }
    this.onTransferProgress?.({
      receivedBytes: transfer.bytes,
      elapsedMs,
      bytesPerSecond: complete
        ? averageBytesPerSecond
        : interval > 0
          ? ((transfer.bytes - transfer.reportedBytes) * 1000) / interval
          : 0,
      averageBytesPerSecond,
      complete,
    });
    transfer.reportedAt = now;
    transfer.reportedBytes = transfer.bytes;
  }
  private beginTransfer(): void {
    if (!this.onTransferProgress) return;
    const now = performance.now();
    this.transfer = { started: now, reportedAt: now, reportedBytes: 0, bytes: 0, receivedAt: 0 };
    this.transfer.timer = setInterval(() => this.reportTransfer(), 200);
    this.reportTransfer();
  }
  async open(): Promise<void> {
    await this.device.open();
    if (this.device.configuration?.configurationValue !== 1)
      throw new Error('H417 is not configured; initialize UHSIF in the management webpage first');
    const iface = this.device.configuration?.interfaces.find((i) => i.interfaceNumber === INTERFACE);
    const endpoints = iface?.alternates.find((a) => a.alternateSetting === ALTERNATE)?.endpoints;
    const out = endpoints?.find((e) => e.endpointNumber === EP_OUT && e.direction === 'out' && e.type === 'bulk');
    const input = endpoints?.find((e) => e.endpointNumber === EP_IN && e.direction === 'in' && e.type === 'bulk');
    if (!out || !input || ![512, 1024].includes(input.packetSize) || out.packetSize !== input.packetSize)
      throw new Error('H417 shared data interface is unavailable; update the device firmware');
    this.packet = input.packetSize as 512 | 1024;
    await this.device.claimInterface(INTERFACE);
    await this.device.selectAlternateInterface(INTERFACE, ALTERNATE);
    if (this.device.clearHalt) {
      await this.device.clearHalt('out', EP_OUT);
      await this.device.clearHalt('in', EP_IN);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    void this.readLoop().catch((error) => this.fail(error));
  }
  private fail(value: unknown): void {
    if (this.closed || this.error) return;
    this.reportTransfer(true);
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
    if (frame.codec) {
      const c = frame.codec;
      this.counters.codecBlocks++;
      this.counters.codecRawBytes += c.rawBytes;
      this.counters.codecWireBytes += c.wireBytes;
      this.counters.codecCycles += c.cycles;
      this.counters.codecMaxCycles = Math.max(this.counters.codecMaxCycles, c.cycles);
      this.counters.codecDecodeMs += c.decodeMs;
      this.counters.codecMaxHoldMs = Math.max(this.counters.codecMaxHoldMs, c.holdMs);
      this.counters.codecQueuePeak = Math.max(this.counters.codecQueuePeak, c.queuePeak);
    }
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
      if (frame.payload.length % this.sampleBytes) throw new Error('H417 digital block has a partial sample');
      this.first += BigInt(frame.payload.length / this.sampleBytes);
      this.sequence = (this.sequence + 1) >>> 0;
      this.counters.dataFrames++;
      if (frame.dataCore !== undefined) this.counters.dataCore = frame.dataCore;
    } else if (frame.type === ANALOG) {
      const a = frame.analog!;
      const stream = a.pin;
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
      this.reportTransfer(true);
      this.endWake?.();
      this.wake?.();
      this.wake = null;
    }
    if (!this.discarding) {
      if (this.queue.length >= USB_QUEUE_BLOCKS + FRAMES_PER_READ)
        throw new ComponentError('driver.ch32h417.error.hostOverflow');
      this.queue.push(frame);
      this.counters.queuePeak = Math.max(this.counters.queuePeak, this.queue.length);
      this.wake?.();
      this.wake = null;
    }
  }
  private async readLoop(): Promise<void> {
    const parser = new FrameParser(this.packet, (frame) => this.receive(frame));
    this.parser = parser;
    const frameBytes = this.packet === 1024 ? BLOCK_BYTES : this.packet + BLOCK_BYTES,
      readBytes = USB_READ_BYTES - (USB_READ_BYTES % frameBytes);
    const read = () => {
      this.counters.reads++;
      const started = performance.now();
      return this.device.transferIn(EP_IN, readBytes).then(
        (value) => {
          const completed = performance.now();
          if (this.transfer && value.status === 'ok' && value.data) {
            this.transfer.bytes += value.data.byteLength;
            this.transfer.receivedAt = completed;
          }
          return { value, started, completed };
        },
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
      if ((this.active || this.starting) && !this.ended) {
        this.counters.usbReadMaxMs = Math.max(this.counters.usbReadMaxMs, result.completed - result.started);
        if (this.lastReadCompleted)
          this.counters.usbReadMaxGapMs = Math.max(
            this.counters.usbReadMaxGapMs,
            result.completed - this.lastReadCompleted,
          );
        this.counters.parserStartDelayMaxMs = Math.max(
          this.counters.parserStartDelayMaxMs,
          performance.now() - result.completed,
        );
        this.lastReadCompleted = result.completed;
      } else this.lastReadCompleted = 0;
      this.counters.receivedBytes += data.byteLength;
      inflight.push(read());
      const parseStarted = performance.now();
      parser.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      this.device.consumeTransfer?.(data);
      this.counters.parserMs += performance.now() - parseStarted;
      while (this.queue.length >= USB_QUEUE_BLOCKS && !this.discarding && !this.closed && !this.error) {
        const waitStarted = performance.now();
        this.counters.receiveQueuePauses++;
        await new Promise<void>((resolve) => {
          this.room = resolve;
        });
        this.counters.receiveQueueWaitMs += performance.now() - waitStarted;
      }
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
        const sent = await deadline(this.device.transferOut(EP_OUT, bytes), 2000, `H417 command ${type} OUT timeout`);
        if (sent.status !== 'ok' || sent.bytesWritten !== bytes.length)
          throw new Error('H417 bulk OUT failed or stalled');
        const frame = await deadline(reply, 2000, `H417 command ${type} reply timeout`);
        const status = readStatus(frame.payload);
        if (status.error) {
          const error = statusError(status.error);
          if (!(error instanceof ComponentError)) error.message += ` (command ${type})`;
          throw error;
        }
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
  keepalive(): Promise<void> {
    if (this.heartbeatPending) return this.heartbeatPending;
    const run = this.serial.then(async () => {
      if (this.closed || this.error) throw this.error ?? new Error('H417 connection closed');
      this.requestId = (this.requestId + 1) >>> 0 || 1;
      const bytes = encodeCommand(Command.keepalive, this.requestId, this.session, this.packet);
      const sent = await deadline(this.device.transferOut(EP_OUT, bytes), 2000, 'H417 keepalive OUT timeout');
      if (sent.status !== 'ok' || sent.bytesWritten !== bytes.length)
        throw new Error('H417 bulk OUT failed or stalled');
      this.lastKeepalive = performance.now();
    });
    this.serial = run.catch(() => {});
    const pending = run.finally(() => {
      this.heartbeatPending = null;
    });
    this.heartbeatPending = pending;
    return pending;
  }
  async start(payload: Uint8Array, sampleBytes = 1): Promise<void> {
    if (![1, 2, 3, 4].includes(sampleBytes)) throw new Error('Invalid H417 digital sample width');
    this.sampleBytes = sampleBytes;
    await this.command(Command.config, payload);
    this.starting = true;
    this.beginTransfer();
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
  async setCompression(transform = 0): Promise<void> {
    if (this.active || !this.parser) throw new Error('Set compression before capture');
    if (![0, 1].includes(transform)) throw new Error('Invalid H417 analog encoding');
    const until = performance.now() + 1000;
    while (true) {
      const status = readStatus((await this.command(Command.status)).payload);
      if (!status.state) break;
      if (status.state !== 2 || performance.now() >= until) throw new Error('H417 capture resources are busy');
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await this.command(Command.codec, new Uint8Array([0, transform, 0, 0]));
  }
  async next(): Promise<Frame | null> {
    if (this.active && !this.ended && !this.heartbeatPending && performance.now() - this.lastKeepalive >= 500)
      void this.keepalive().catch((error) => this.fail(error));
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
    this.reportTransfer(true);
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
