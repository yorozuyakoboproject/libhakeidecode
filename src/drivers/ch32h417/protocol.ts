import { SS_RATES } from './descriptor.js';
import { ComponentError } from '../../components.js';
import { restoreBlock, type BlockEncoding } from './compression.js';
export { USB_VID, USB_PID, SS_RATES } from './descriptor.js';
export const APP_PROTOCOL = 32;
export const INTERFACE = 1,
  ALTERNATE = 1,
  EP_OUT = 1,
  EP_IN = 2;
export const MAGIC = 0x414c3448,
  VERSION = 2,
  HEADER_BYTES = 32,
  BLOCK_BYTES = 16_384;
export const DIGITAL_FRAME_BYTES = 64_512,
  DIGITAL_HEADER_BYTES = 96,
  DIGITAL_BLOCK_BYTES = DIGITAL_FRAME_BYTES - DIGITAL_HEADER_BYTES;
export const MAX_FRAME_BYTES = DIGITAL_FRAME_BYTES;
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
const PACKED_ANALOG = 0x44;
export const DATA = 0x40,
  END = 0x41,
  ANALOG = 0x42,
  RESPONSE = 0x80;
export interface Frame {
  dataCore?: number;
  codec?: BlockEncoding;
  analog?: {
    pin: number;
    sampleCount: number;
    targetSamples: bigint;
    mask: number;
    adc1Mask: number;
    hsadcMask: number;
    timing: import('../../libhakei/device.js').AnalogTiming & { conversionTicks: bigint };
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
  analogMask: number;
  adc1Mask: number;
  hsadcMask: number;
  adc1Budget: number;
  hsadcMax: number;
  digitalMask: number;
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
const digitalWidth = (mask: number): number => {
  const value = mask >>> 0;
  return value ? Math.ceil((32 - Math.clz32(value)) / 8) * 8 : 0;
};
const extraMask = (frame: Frame): number =>
  new DataView(frame.payload.buffer, frame.payload.byteOffset + 84, 4).getUint32(0, true);
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
  if (status.error || frame.payload.length !== 668) throw new Error('Invalid H417 capability response');
  const v = new DataView(frame.payload.buffer, frame.payload.byteOffset + 16, 56);
  const packet = v.getUint16(2, true),
    count = v.getUint8(13);
  const actual = v.getUint16(0, true);
  if (actual !== APP_PROTOCOL)
    throw new ComponentError('driver.ch32h417.error.protocol', { actual, expected: APP_PROTOCOL });
  const blockBytes = v.getUint32(4, true),
    digitalMask = extraMask(frame);
  const width = digitalWidth(digitalMask);
  if (
    (packet !== 512 && packet !== 1024) ||
    blockBytes !== (packet === 1024 ? DIGITAL_BLOCK_BYTES : width === 24 ? 12_288 : BLOCK_BYTES) ||
    v.getUint32(8, true) !== 5000 ||
    v.getUint8(12) !== 32 ||
    count !== (packet === 1024 ? 10 : 4) ||
    status.speed !== (packet === 1024 ? 3 : 2) ||
    !!(v.getUint16(14, true) & ~0x107)
  )
    throw new Error('Unsupported H417 USB capabilities');
  const rates = Array.from({ length: count }, (_, i) => v.getUint32(16 + i * 4, true));
  if (rates.some((rate, i) => rate !== SS_RATES[i])) throw new Error('Invalid H417 rate table');
  const extra = new DataView(frame.payload.buffer, frame.payload.byteOffset + 72, 16);
  if (
    extra.getUint8(3) !== 2 ||
    (extra.getUint8(1) | extra.getUint8(2)) & ~3 ||
    extra.getUint8(1) & extra.getUint8(2) ||
    extra.getUint8(2) === 3 ||
    extra.getUint8(0) !== (extra.getUint8(1) | extra.getUint8(2))
  )
    throw new Error('Invalid analog capabilities');
  const channelRates: AnalogRate[] = [];
  const c = new DataView(frame.payload.buffer, frame.payload.byteOffset + 88, 580);
  if (c.getUint8(0) !== 2 || c.getUint8(1) !== 0 || c.getUint8(2) > 48 || c.getUint8(3))
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
      decimation !== 1 ||
      outputTicks !== conversionTicks
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
  return {
    appProtocol: actual,
    channelRates,
    compressionMask: v.getUint16(14, true) & 7,
    packetBytes: packet,
    blockBytes,
    heartbeatMs: 5000,
    channels: 32,
    rates,
    analogMask: extra.getUint8(0),
    adc1Mask: extra.getUint8(1),
    hsadcMask: extra.getUint8(2),
    adc1Budget: extra.getUint32(4, true),
    hsadcMax: extra.getUint32(8, true),
    digitalMask,
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
      (type === DATA || type === ANALOG || type === PACKED_ANALOG
        ? (type === PACKED_ANALOG
            ? header !== HEADER_BYTES + 56 + 24
            : header !== this.packet && !(type === DATA && this.packet === 1024 && header === DIGITAL_HEADER_BYTES)) ||
          payload < 1 ||
          payload > (header === DIGITAL_HEADER_BYTES ? DIGITAL_BLOCK_BYTES : BLOCK_BYTES + 1024)
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
    const packed = wireType === PACKED_ANALOG;
    const type = packed ? ANALOG : wireType;
    let samples = payload.subarray(header);
    let codec: BlockEncoding | undefined;
    if (packed) {
      const c = new DataView(payload.buffer, payload.byteOffset + HEADER_BYTES + 56, 24);
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
      const encodedBytes = c.getUint32(4, true);
      if (!encodedBytes || encodedBytes > samples.length || samples.length - encodedBytes >= this.packet)
        throw new Error('Invalid H417 payload length');
      samples = samples.subarray(0, encodedBytes);
      codec.wireBytes = encodedBytes;
      const analogEncoding = [0, 1, 3].includes(codec.encoding);
      if (
        !codec.rawBytes ||
        codec.rawBytes > BLOCK_BYTES ||
        codec.transform > 2 ||
        c.getUint16(22, true) ||
        codec.channels < 1 ||
        codec.channels > 2 ||
        (codec.outputSlot !== 255 && codec.outputSlot > 3) ||
        !analogEncoding ||
        codec.rawBytes % (2 * codec.channels) ||
        (!codec.encoding && (codec.transform || samples.length !== codec.rawBytes)) ||
        (codec.encoding === 1 && samples.length >= codec.rawBytes) ||
        (codec.encoding === 3 && (c.getUint8(19) < 8 || c.getUint8(19) > 12 || codec.transform))
      )
        throw new Error('Invalid H417 block encoding');
      const analogBits = payload[HEADER_BYTES + 3]!;
      samples = restoreBlock(samples, codec, analogBits);
      if (c.getUint8(19) !== analogBits) throw new Error('Invalid H417 analog encoding width');
    }
    let analog: Frame['analog'];
    if (type === ANALOG) {
      const a = new DataView(payload.buffer, payload.byteOffset + HEADER_BYTES, 56);
      const bits = a.getUint8(3);
      if (
        bits < 8 ||
        bits > 12 ||
        !a.getUint8(0) ||
        a.getUint8(0) & ~3 ||
        !a.getUint32(4, true) ||
        !a.getBigUint64(8, true) ||
        !a.getUint32(28, true) ||
        samples.length % 2 ||
        (codec && codec.channels !== Number(!!(a.getUint8(0) & 1)) + Number(!!(a.getUint8(0) & 2)))
      )
        throw new Error('Invalid analog frame');
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
        decimation !== 1 ||
        a.getBigUint64(8, true) !== conversionTicks ||
        sampleCount * 2 !== samples.length ||
        !targetSamples ||
        view.getBigUint64(20, true) + BigInt(sampleCount) > targetSamples
      )
        throw new Error('Invalid independent analog stream');
      analog = {
        pin,
        sampleCount,
        targetSamples,
        mask: a.getUint8(0),
        adc1Mask: a.getUint8(1),
        hsadcMask: a.getUint8(2),
        timing: {
          bits: bits as import('../../libhakei/device.js').AnalogTiming['bits'],
          nativeBits,
          conversionTicks,
          decimation,
          clockHz: a.getUint32(4, true),
          periodTicks: a.getBigUint64(8, true),
          firstTick: a.getBigUint64(16, true),
          uncertaintyTicks: a.getUint32(24, true),
          referenceMv: a.getUint32(28, true),
        },
      };
    }
    this.onFrame({
      ...(type === DATA && header === DIGITAL_HEADER_BYTES ? { dataCore: payload[HEADER_BYTES]! } : {}),
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
  if (frame.type !== (RESPONSE | Command.codecStats) || frame.payload.length !== 444 || readStatus(frame.payload).error)
    throw new Error('Invalid codec statistics');
  const v = new DataView(frame.payload.buffer, frame.payload.byteOffset + 16);
  const streams = Array.from({ length: 2 }, (_, stream) => ({
    queuePeak: v.getUint32(stream * 4, true),
    maxHoldMs: v.getUint32(8 + stream * 4, true),
    inputBytes: v.getBigUint64(36 + stream * 8, true),
    outputBytes: v.getBigUint64(52 + stream * 8, true),
    cycles: v.getBigUint64(68 + stream * 8, true),
    maxCycles: v.getUint32(84 + stream * 4, true),
    candidates: Array.from({ length: 5 }, (_, path) => {
      const index = stream * 5 + path;
      return {
        bytes: v.getBigUint64(92 + index * 8, true),
        cycles: v.getBigUint64(172 + index * 8, true),
        maxCycles: v.getUint32(252 + index * 4, true),
        blocks: v.getUint32(292 + index * 4, true),
      };
    }),
  }));
  return {
    streams,
    workspaceBytes: v.getUint32(32, true),
    timerHz: v.getUint32(332, true),
    timing: Array.from({ length: 4 }, (_, stage) => ({
      ticks: v.getBigUint64(336 + stage * 16, true),
      maximum: v.getUint32(344 + stage * 16, true),
      blocks: v.getUint32(348 + stage * 16, true),
    })),
    failure: {
      kind: v.getUint32(400, true),
      pending: v.getUint32(404, true),
      outputs: v.getUint32(408, true),
      txKind: v.getUint32(412, true),
      txTicks: v.getUint32(416, true),
    },
    usbShortPackets: v.getUint32(420, true),
    usbTransfers: v.getUint32(424, true),
  };
}
