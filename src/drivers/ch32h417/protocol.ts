import { SS_RATES } from './descriptor.js';
import { ComponentError } from '../../components.js';
import { restoreBlock, type BlockEncoding } from './compression.js';
export { USB_VID, USB_PID, SS_RATES } from './descriptor.js';
export const APP_PROTOCOL = 22;
export const INTERFACE = 1,
  EP_OUT = 5,
  EP_IN = 6;
export const MAGIC = 0x414c3448,
  VERSION = 2,
  HEADER_BYTES = 32,
  BLOCK_BYTES = 16_384;
export const MAX_FRAME_BYTES = BLOCK_BYTES + 2048;
export const Command = {
  caps: 1,
  config: 2,
  start: 3,
  stop: 4,
  status: 5,
  keepalive: 6,
  codec: 7,
  codecStats: 8,
} as const;
const PACKED_DATA = 0x43,
  PACKED_ANALOG = 0x44;
export const DATA = 0x40,
  END = 0x41,
  ANALOG = 0x42,
  RESPONSE = 0x80;
export interface Frame {
  codec?: BlockEncoding;
  analog?: {
    pin?: number;
    sampleCount?: number;
    targetSamples?: bigint;
    mask: number;
    adc1Mask: number;
    hsadcMask: number;
    timing: import('../../libhakei/device.js').AnalogTiming;
  };
  type: number;
  requestId: number;
  session: number;
  sequence: number;
  firstSample: bigint;
  payload: Uint8Array;
}
export interface AnalogRate {
  pin: number;
  nativeBits: 10 | 12;
  outputTicks: number;
  conversionTicks: number;
  decimation: number;
}
export interface Capabilities {
  appProtocol: number;
  channelRates: AnalogRate[];
  compressionMask: number;
  hsadcBlockSamples: number;
  analogMask: number;
  adc1Mask: number;
  hsadcMask: number;
  adc1Budget: number;
  hsadcMax: number;
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
  if (status.error || ![88, 668].includes(frame.payload.length)) throw new Error('Invalid H417 capability response');
  const v = new DataView(frame.payload.buffer, frame.payload.byteOffset + 16, 56);
  const packet = v.getUint16(2, true),
    count = v.getUint8(13);
  const actual = v.getUint16(0, true);
  if (![19, 20, 21, APP_PROTOCOL].includes(actual))
    throw new ComponentError('driver.ch32h417.error.protocol', { actual, expected: APP_PROTOCOL });
  if (
    (packet !== 512 && packet !== 1024) ||
    v.getUint32(4, true) !== BLOCK_BYTES ||
    v.getUint32(8, true) !== 5000 ||
    v.getUint8(12) !== 8 ||
    count !== (packet === 1024 ? 10 : 4) ||
    status.speed !== (packet === 1024 ? 3 : 2) ||
    (actual === 19
      ? v.getUint16(14, true) !== 0
      : !!(v.getUint16(14, true) & ~(actual >= 22 ? 3 : actual >= 21 ? 31 : 7)))
  )
    throw new Error('Unsupported H417 USB capabilities');
  const rates = Array.from({ length: count }, (_, i) => v.getUint32(16 + i * 4, true));
  if (rates.some((rate, i) => rate !== SS_RATES[i])) throw new Error('Invalid H417 rate table');
  const extra = new DataView(frame.payload.buffer, frame.payload.byteOffset + 72, 16);
  if (
    extra.getUint8(3) !== (actual >= 21 ? 2 : 1) ||
    (extra.getUint8(1) | extra.getUint8(2)) & ~3 ||
    extra.getUint8(1) & extra.getUint8(2) ||
    extra.getUint8(2) === 3 ||
    extra.getUint8(0) !== (extra.getUint8(1) | extra.getUint8(2))
  )
    throw new Error('Invalid analog capabilities');
  const channelRates: AnalogRate[] = [];
  if (actual >= 21) {
    if (frame.payload.length !== 668) throw new Error('Truncated channel capabilities');
    const c = new DataView(frame.payload.buffer, frame.payload.byteOffset + 88, 580);
    if (c.getUint8(0) !== 2 || c.getUint8(1) !== (actual >= 22 ? 0 : 1) || c.getUint8(2) > 48 || c.getUint8(3))
      throw new Error('Invalid channel capabilities');
    for (let i = 0; i < c.getUint8(2); ++i) {
      const at = 4 + i * 12,
        outputTicks = c.getUint32(at, true),
        conversionTicks = c.getUint32(at + 4, true),
        decimation = c.getUint16(at + 8, true),
        nativeBits = c.getUint8(at + 10),
        pin = c.getUint8(at + 11);
      if (
        pin > 1 ||
        !(extra.getUint8(0) & (1 << pin)) ||
        nativeBits !== (extra.getUint8(2) & (1 << pin) ? 10 : 12) ||
        !conversionTicks ||
        !decimation ||
        decimation > 32 ||
        decimation & (decimation - 1) ||
        outputTicks !== conversionTicks * decimation
      )
        throw new Error('Invalid analog rate table');
      channelRates.push({
        pin,
        nativeBits: nativeBits as 10 | 12,
        outputTicks,
        conversionTicks,
        decimation,
      });
    }
  } else if (frame.payload.length !== 88) throw new Error('Invalid legacy capabilities');
  return {
    appProtocol: actual,
    channelRates,
    compressionMask: actual >= 20 ? v.getUint16(14, true) : 0,
    hsadcBlockSamples: actual === 19 ? 1024 : 4096,
    packetBytes: packet,
    blockBytes: BLOCK_BYTES,
    heartbeatMs: 5000,
    channels: 8,
    rates,
    analogMask: extra.getUint8(0),
    adc1Mask: extra.getUint8(1),
    hsadcMask: extra.getUint8(2),
    adc1Budget: extra.getUint32(4, true),
    hsadcMax: extra.getUint32(8, true),
  };
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
  codecEnabled = false;
  appProtocol = 19;
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
    if (view.getUint32(0, true) === MAGIC && view.getUint8(4) !== VERSION)
      throw new ComponentError('driver.ch32h417.error.protocol', {
        actual: view.getUint8(4),
        expected: VERSION,
      });
    if (
      view.getUint32(0, true) !== MAGIC ||
      view.getUint8(4) !== VERSION ||
      (type === DATA ||
      type === ANALOG ||
      ((type === PACKED_DATA || type === PACKED_ANALOG) && (this.codecEnabled || this.appProtocol >= 21))
        ? (header !== this.packet &&
            !(this.appProtocol >= 22 && header === HEADER_BYTES + (type === PACKED_ANALOG ? 56 : 0) + 24)) ||
          payload < 1 ||
          payload > BLOCK_BYTES + (this.appProtocol >= 22 ? 1024 : 0)
        : header !== HEADER_BYTES || payload < 16 || payload > 992 || (type !== END && !(type & RESPONSE)))
    )
      throw new Error('Invalid H417 frame header');
    const length = header + payload;
    if (length > this.bytes.length) throw new Error('Oversized H417 frame');
    return length;
  }
  private emit(view: DataView, payload: Uint8Array): void {
    const header = view.getUint16(6, true);
    const wireType = view.getUint8(5);
    const packed = wireType === PACKED_DATA || wireType === PACKED_ANALOG;
    const type = wireType === PACKED_DATA ? DATA : wireType === PACKED_ANALOG ? ANALOG : wireType;
    let samples = payload.subarray(header);
    let codec: BlockEncoding | undefined;
    if (packed) {
      const c = new DataView(
        payload.buffer,
        payload.byteOffset + HEADER_BYTES + (type === ANALOG ? (this.appProtocol >= 21 ? 56 : 32) : 0),
        24,
      );
      codec = {
        rawBytes: c.getUint32(0, true),
        cycles: c.getUint32(8, true),
        holdMs: c.getUint32(12, true),
        encoding: c.getUint8(16),
        transform: c.getUint8(17),
        channels: c.getUint8(18),
        outputSlot: c.getUint8(20),
        queuePeak: c.getUint8(21),
        wireBytes: samples.length,
        decodeMs: 0,
      };
      if (this.appProtocol >= 22) {
        const encodedBytes = c.getUint32(4, true);
        if (!encodedBytes || encodedBytes > samples.length || samples.length - encodedBytes >= this.packet)
          throw new Error('Invalid H417 payload length');
        samples = samples.subarray(0, encodedBytes);
        codec.wireBytes = encodedBytes;
      }
      if (
        !codec.rawBytes ||
        codec.rawBytes > BLOCK_BYTES ||
        codec.encoding > (this.appProtocol >= 21 ? 3 : 1) ||
        codec.transform > 2 ||
        c.getUint16(22, true) ||
        codec.channels < 1 ||
        codec.channels > 2 ||
        (codec.outputSlot !== 255 && codec.outputSlot > 3) ||
        (type === DATA && (codec.transform || codec.channels !== 1)) ||
        (type === ANALOG && codec.rawBytes % (2 * codec.channels)) ||
        (!codec.encoding && (codec.transform || samples.length !== codec.rawBytes)) ||
        ((codec.encoding === 1 || (codec.encoding === 2 && this.appProtocol < 22)) &&
          samples.length >= codec.rawBytes) ||
        (codec.encoding === 2 && type !== DATA) ||
        (codec.encoding === 3 && (type !== ANALOG || codec.transform))
      )
        throw new Error('Invalid H417 block encoding');
      const analogBits = type === ANALOG ? payload[HEADER_BYTES + 3]! : 8;
      samples = restoreBlock(samples, codec, analogBits);
    }
    let analog: Frame['analog'];
    if (type === ANALOG) {
      const a = new DataView(payload.buffer, payload.byteOffset + HEADER_BYTES, this.appProtocol >= 21 ? 56 : 32);
      const bits = a.getUint8(3);
      if (
        (this.appProtocol >= 21 ? bits < 8 || bits > 12 : bits !== 10 && bits !== 12) ||
        !a.getUint8(0) ||
        a.getUint8(0) & ~3 ||
        !a.getUint32(4, true) ||
        !a.getBigUint64(8, true) ||
        !a.getUint32(28, true) ||
        samples.length % 2 ||
        (codec && codec.channels !== Number(!!(a.getUint8(0) & 1)) + Number(!!(a.getUint8(0) & 2)))
      )
        throw new Error('Invalid analog frame');
      let independent: Pick<NonNullable<Frame['analog']>, 'pin' | 'sampleCount' | 'targetSamples'> = {};
      let extraTiming = {};
      if (this.appProtocol >= 21) {
        const nativeBits = a.getUint8(46),
          pin = a.getUint8(47),
          conversionTicks = a.getBigUint64(32, true),
          sampleCount = a.getUint32(40, true),
          decimation = a.getUint16(44, true),
          targetSamples = a.getBigUint64(48, true);
        if (
          pin > 1 ||
          a.getUint8(0) !== 1 << pin ||
          nativeBits !== (a.getUint8(2) & (1 << pin) ? 10 : 12) ||
          bits > nativeBits ||
          !conversionTicks ||
          !decimation ||
          decimation > 32 ||
          decimation & (decimation - 1) ||
          a.getBigUint64(8, true) !== conversionTicks * BigInt(decimation) ||
          sampleCount * 2 !== samples.length ||
          !targetSamples ||
          view.getBigUint64(20, true) + BigInt(sampleCount) > targetSamples
        )
          throw new Error('Invalid independent analog stream');
        independent = { pin, sampleCount, targetSamples };
        extraTiming = { nativeBits, conversionTicks, decimation };
      }
      analog = {
        ...independent,
        mask: a.getUint8(0),
        adc1Mask: a.getUint8(1),
        hsadcMask: a.getUint8(2),
        timing: {
          bits: bits as import('../../libhakei/device.js').AnalogTiming['bits'],
          ...extraTiming,
          clockHz: a.getUint32(4, true),
          periodTicks: a.getBigUint64(8, true),
          firstTick: a.getBigUint64(16, true),
          uncertaintyTicks: a.getUint32(24, true),
          referenceMv: a.getUint32(28, true),
        },
      };
    }
    if (type === (RESPONSE | Command.caps) && samples.length >= 18) {
      this.appProtocol = new DataView(samples.buffer, samples.byteOffset).getUint16(16, true);
    }
    this.onFrame({
      ...(codec ? { codec } : {}),
      ...(analog ? { analog } : {}),
      type,
      requestId: view.getUint32(8, true),
      session: view.getUint32(12, true),
      sequence: view.getUint32(16, true),
      firstSample: view.getBigUint64(20, true),
      payload: samples,
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
        this.emit(v, this.bytes.slice(0, this.needed));
        this.used = 0;
        this.needed = HEADER_BYTES;
      }
    }
  }
}

export function readCodecStatistics(frame: Frame) {
  if (
    frame.type !== (RESPONSE | Command.codecStats) ||
    ![528, 536, 600].includes(frame.payload.length) ||
    readStatus(frame.payload).error
  )
    throw new Error('Invalid codec statistics');
  const v = new DataView(frame.payload.buffer, frame.payload.byteOffset + 16);
  const streams = Array.from({ length: 3 }, (_, stream) => ({
    queuePeak: v.getUint32(stream * 4, true),
    maxHoldMs: v.getUint32(12 + stream * 4, true),
    inputBytes: v.getBigUint64(44 + stream * 8, true),
    outputBytes: v.getBigUint64(68 + stream * 8, true),
    cycles: v.getBigUint64(92 + stream * 8, true),
    maxCycles: v.getUint32(116 + stream * 4, true),
    candidates: Array.from({ length: 5 }, (_, path) => {
      const index = stream * 5 + path;
      return {
        bytes: v.getBigUint64(128 + index * 8, true),
        cycles: v.getBigUint64(248 + index * 8, true),
        maxCycles: v.getUint32(368 + index * 4, true),
        blocks: v.getUint32(428 + index * 4, true),
      };
    }),
  }));
  return {
    streams,
    workspaceBytes: v.getUint32(40, true),
    ...(frame.payload.length === 600
      ? {
          timerHz: v.getUint32(488, true),
          timing: Array.from({ length: 4 }, (_, stage) => ({
            ticks: v.getBigUint64(492 + stage * 16, true),
            maximum: v.getUint32(500 + stage * 16, true),
            blocks: v.getUint32(504 + stage * 16, true),
          })),
          failure: {
            kind: v.getUint32(556, true),
            pending: v.getUint32(560, true),
            outputs: v.getUint32(564, true),
            txKind: v.getUint32(568, true),
            txTicks: v.getUint32(572, true),
          },
          usbShortPackets: v.getUint32(576, true),
          usbTransfers: v.getUint32(580, true),
        }
      : {}),
  };
}
