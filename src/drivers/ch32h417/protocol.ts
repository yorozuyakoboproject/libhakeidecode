import { SS_RATES } from './descriptor.js';
import { ComponentError } from '../../components.js';
export { USB_VID, USB_PID, SS_RATES } from './descriptor.js';
export const APP_PROTOCOL = 16;
export const INTERFACE = 1,
  EP_OUT = 5,
  EP_IN = 6;
export const MAGIC = 0x414c3448,
  VERSION = 1,
  HEADER_BYTES = 32,
  BLOCK_BYTES = 16_384;
export const MAX_FRAME_BYTES = BLOCK_BYTES + 1024;
export const Command = { caps: 1, config: 2, start: 3, stop: 4, status: 5, keepalive: 6 } as const;
export const DATA = 0x40,
  END = 0x41,
  RESPONSE = 0x80;
export interface Frame {
  type: number;
  requestId: number;
  session: number;
  sequence: number;
  firstSample: bigint;
  payload: Uint8Array;
}
export interface Capabilities {
  packetBytes: 512 | 1024;
  blockBytes: number;
  heartbeatMs: number;
  channels: number;
  rates: number[];
}
export interface DeviceStatus {
  error: number;
  state: number;
  channels: number;
  speed: number;
  sampleRate: number;
  samples: bigint;
}
export function readStatus(payload: Uint8Array): DeviceStatus {
  if (payload.length < 16) throw new Error('Truncated H417 status');
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    error: v.getUint8(0),
    state: v.getUint8(1),
    channels: v.getUint8(2),
    speed: v.getUint8(3),
    sampleRate: v.getUint32(4, true),
    samples: v.getBigUint64(8, true),
  };
}
export function readCapabilities(frame: Frame): Capabilities {
  const status = readStatus(frame.payload);
  if (status.error || frame.payload.length !== 72) throw new Error('Invalid H417 capability response');
  const v = new DataView(frame.payload.buffer, frame.payload.byteOffset + 16, 56);
  const packet = v.getUint16(2, true),
    count = v.getUint8(13);
  const actual = v.getUint16(0, true);
  if (actual !== APP_PROTOCOL)
    throw new ComponentError('driver.ch32h417.error.protocol', { actual, expected: APP_PROTOCOL });
  if (
    (packet !== 512 && packet !== 1024) ||
    v.getUint32(4, true) !== BLOCK_BYTES ||
    v.getUint32(8, true) !== 5000 ||
    v.getUint8(12) !== 8 ||
    count !== (packet === 1024 ? 10 : 4) ||
    status.speed !== (packet === 1024 ? 3 : 2) ||
    v.getUint16(14, true) !== 0
  )
    throw new Error('Unsupported H417 USB capabilities');
  const rates = Array.from({ length: count }, (_, i) => v.getUint32(16 + i * 4, true));
  if (rates.some((rate, i) => rate !== SS_RATES[i])) throw new Error('Invalid H417 rate table');
  return { packetBytes: packet, blockBytes: BLOCK_BYTES, heartbeatMs: 5000, channels: 8, rates };
}
export function encodeCommand(
  type: number,
  requestId: number,
  session: number,
  packetBytes: number,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array {
  const bytes = new Uint8Array(packetBytes),
    v = new DataView(bytes.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint8(4, VERSION);
  v.setUint8(5, type);
  v.setUint16(6, HEADER_BYTES, true);
  v.setUint32(8, requestId, true);
  v.setUint32(12, session, true);
  v.setUint32(28, payload.length, true);
  bytes.set(payload, HEADER_BYTES);
  return bytes;
}

export class FrameParser {
  private readonly bytes = new Uint8Array(MAX_FRAME_BYTES);
  private used = 0;
  private needed = HEADER_BYTES;
  constructor(
    private readonly packet: number,
    private readonly onFrame: (frame: Frame) => void,
  ) {}
  private frameLength(view: DataView): number {
    const type = view.getUint8(5),
      header = view.getUint16(6, true),
      payload = view.getUint32(28, true);
    if (
      view.getUint32(0, true) !== MAGIC ||
      view.getUint8(4) !== VERSION ||
      (type === DATA
        ? header !== this.packet || payload < 1 || payload > BLOCK_BYTES
        : header !== HEADER_BYTES || payload < 16 || payload > 72 || (type !== END && !(type & RESPONSE)))
    )
      throw new Error('Invalid H417 frame header');
    const length = header + payload;
    if (length > this.bytes.length) throw new Error('Oversized H417 frame');
    return length;
  }
  private emit(view: DataView, payload: Uint8Array): void {
    const header = view.getUint16(6, true);
    this.onFrame({
      type: view.getUint8(5),
      requestId: view.getUint32(8, true),
      session: view.getUint32(12, true),
      sequence: view.getUint32(16, true),
      firstSample: view.getBigUint64(20, true),
      payload: payload.subarray(header),
    });
  }
  push(input: Uint8Array): void {
    let offset = 0;
    while (offset < input.length) {
      const remaining = input.length - offset;
      if (!this.used && remaining >= HEADER_BYTES) {
        const view = new DataView(input.buffer, input.byteOffset + offset, remaining);
        const length = this.frameLength(view);
        if (remaining >= length) {
          this.emit(view, input.subarray(offset, offset + length));
          offset += length;
          continue;
        }
      }
      const n = Math.min(remaining, this.needed - this.used);
      this.bytes.set(input.subarray(offset, offset + n), this.used);
      this.used += n;
      offset += n;
      if (this.used < this.needed) continue;
      const v = new DataView(this.bytes.buffer);
      if (this.needed === HEADER_BYTES) {
        this.needed = this.frameLength(v);
      }
      if (this.used === this.needed) {
        this.emit(v, this.bytes.subarray(0, this.needed));
        this.used = 0;
        this.needed = HEADER_BYTES;
      }
    }
  }
}
