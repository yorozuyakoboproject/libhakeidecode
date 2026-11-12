import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { UsbSpeed } from '../usb_signalling/index.js';
import { USB_LEAD_BITS, signallingPacketLayout, usbBitWidth } from '../usb_signalling/generator.js';
import { USB_PIDS, calcCrc5, calcCrc16 } from './index.js';
import type { UsbPidName } from './index.js';

export interface UsbPacketSpec {
  readonly pid: UsbPidName;
  readonly addr?: number;
  readonly ep?: number;
  readonly frame?: number;
  readonly data?: readonly number[];
  readonly corruptSync?: boolean;
  readonly corruptCrc?: boolean;
}

export interface UsbPacketCase extends RoundtripCase<UsbPacketSpec> {
  readonly signalling: UsbSpeed;
}

export interface BuiltUsbPacket {
  readonly bits: readonly number[];
  readonly sync: string;
  readonly pidName: string;
  readonly addr: number;
  readonly ep: number;
  readonly frame: number;
  readonly data: readonly number[];
  readonly crc: number;
  readonly crcOk: boolean;
}

export interface UsbPacketLayout {
  readonly frames: readonly ExpectedFrame[];
  readonly next: bigint;
  readonly packetEnd: bigint;
  readonly payloadBits: number;
}

const SYNC_BITS = [0, 0, 0, 0, 0, 0, 0, 1];
const TOKEN_NAMES = new Set(['OUT', 'IN', 'SOF', 'SETUP', 'PING']);
const DATA_NAMES = new Set(['DATA0', 'DATA1', 'DATA2', 'MDATA']);

function appendNumber(bits: number[], value: number, count: number): void {
  for (let index = 0; index < count; index++) bits.push((value >>> index) & 1);
}

function appendBits(bits: number[], text: string): void {
  for (const bit of text) bits.push(Number(bit));
}

function bitText(bits: readonly number[], start: number, end?: number): string {
  return bits
    .slice(start, end)
    .map((bit) => String(bit & 1))
    .join('');
}

export function buildPacket(spec: UsbPacketSpec): BuiltUsbPacket {
  const bits = SYNC_BITS.slice();
  if (spec.corruptSync) bits[4] = 1;
  const pidName = spec.pid;
  const pidBits = USB_PIDS[pidName as Exclude<UsbPidName, 'UNKNOWN'>] ?? '00000000';
  appendBits(bits, pidBits);

  const addr = spec.addr ?? 0;
  const ep = spec.ep ?? 0;
  const frame = spec.frame ?? 0;
  const data = [...(spec.data ?? [])];
  let crc = 0;

  if (TOKEN_NAMES.has(pidName)) {
    if (pidName === 'SOF') appendNumber(bits, frame & 0x7ff, 11);
    else {
      appendNumber(bits, addr & 0x7f, 7);
      appendNumber(bits, ep & 0x0f, 4);
    }
    crc = calcCrc5(bitText(bits, 16));
    if (spec.corruptCrc) crc ^= 1;
    appendNumber(bits, crc, 5);
  } else if (DATA_NAMES.has(pidName)) {
    for (const value of data) appendNumber(bits, value & 0xff, 8);
    crc = calcCrc16(bitText(bits, 16));
    if (spec.corruptCrc) crc ^= 1;
    appendNumber(bits, crc, 16);
  }

  return {
    bits,
    sync: bitText(bits, 0, 8),
    pidName,
    addr,
    ep,
    frame,
    data,
    crc,
    crcOk: !spec.corruptCrc,
  };
}

function protocol(ss: bigint, es: bigint, data: readonly unknown[]): ExpectedFrame {
  return { ss, es, protoId: 'usb_packet', kind: 'protocol', data };
}

function packetCategory(name: string): string {
  if (['OUT', 'IN', 'SOF', 'SETUP'].includes(name)) return 'TOKEN';
  if (DATA_NAMES.has(name)) return 'DATA';
  if (['ACK', 'NAK', 'STALL', 'NYET', 'ERR'].includes(name)) return 'HANDSHAKE';
  return 'SPECIAL';
}

export function packetLayout(spec: UsbPacketSpec, start: bigint, width: number): UsbPacketLayout {
  const built = buildPacket(spec);
  const layout = signallingPacketLayout(built.bits, start, width);
  const { wireMap, cells } = layout;
  const span = (first: number, last: number): readonly [bigint, bigint] => [
    cells[wireMap[first]!]!.ss,
    cells[wireMap[last]!]!.es,
  ];
  const frames: ExpectedFrame[] = [];
  let field = span(0, 7);
  frames.push(protocol(field[0], field[1], [built.sync === '00000001' ? 'SYNC' : 'SYNC ERROR', built.sync]));
  field = span(8, 15);
  frames.push(protocol(field[0], field[1], ['PID', built.pidName]));
  const pidEnd = field[1];

  if (TOKEN_NAMES.has(built.pidName)) {
    if (built.pidName === 'SOF') {
      field = span(16, 26);
      frames.push(protocol(field[0], field[1], ['FRAMENUM', built.frame]));
    } else {
      field = span(16, 22);
      frames.push(protocol(field[0], field[1], ['ADDR', built.addr]));
      field = span(23, 26);
      frames.push(protocol(field[0], field[1], ['EP', built.ep]));
    }
    field = span(27, 31);
    frames.push(protocol(field[0], field[1], [built.crcOk ? 'CRC5' : 'CRC5 ERROR', built.crc]));
  } else if (DATA_NAMES.has(built.pidName)) {
    for (let index = 0; index < built.data.length; index++) {
      field = span(16 + index * 8, 23 + index * 8);
      frames.push(protocol(field[0], field[1], ['DATABYTE', built.data[index]!]));
    }
    const dataStart = 16;
    const crcStart = built.bits.length - 16;
    frames.push(protocol(span(dataStart, dataStart)[0], span(crcStart, crcStart)[1], ['DATABYTES', built.data]));
    field = span(crcStart, built.bits.length - 1);
    frames.push(protocol(field[0], field[1], [built.crcOk ? 'CRC16' : 'CRC16 ERROR', built.crc]));
  }

  const packetEnd = built.pidName === 'PRE' ? pidEnd : layout.packetEnd;
  let info: readonly unknown[];
  if (built.pidName === 'SOF') info = [built.sync, built.pidName, built.frame, built.crc];
  else if (TOKEN_NAMES.has(built.pidName)) info = [built.sync, built.pidName, built.addr, built.ep, built.crc];
  else if (DATA_NAMES.has(built.pidName)) info = [built.sync, built.pidName, built.data, built.crc];
  else info = [built.sync, built.pidName];
  frames.push(protocol(start, packetEnd, ['PACKET', [packetCategory(built.pidName), built.pidName, info]]));

  return {
    frames,
    next: layout.next,
    packetEnd,
    payloadBits: layout.wireBits,
  };
}

function caseOptions(speed: UsbSpeed): Record<string, string> {
  return { signalling: speed };
}

function packetCase(
  name: string,
  seed: number,
  startSample: bigint,
  speed: UsbSpeed,
  packets: readonly UsbPacketSpec[],
): UsbPacketCase {
  const sampleRate = speed === 'full-speed' ? 48_000_000 : 6_000_000;
  return {
    name,
    kind: 'boundary',
    seed,
    sampleRate,
    startSample,
    channels: { dp: 2, dm: 5 },
    options: caseOptions(speed),
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'usb_signalling', options: caseOptions(speed) }],
    signalling: speed,
    *generate() {
      const width = usbBitWidth(sampleRate, speed);
      let cursor = startSample + BigInt(USB_LEAD_BITS * width);
      const expected: ExpectedFrame[] = [];
      let payloadBits = 0;
      for (const packet of packets) {
        const layout = packetLayout(packet, cursor, width);
        expected.push(...layout.frames);
        payloadBits += layout.payloadBits;
        cursor = layout.next;
      }
      yield { data: [...packets], expected, payloadBits };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x55534250,
}: GenerationOptions = {}): Iterable<UsbPacketCase> {
  yield packetCase('token-field-boundaries', seed, 17n, 'full-speed', [
    { pid: 'OUT', addr: 0, ep: 0 },
    { pid: 'IN', addr: 127, ep: 15 },
    { pid: 'SETUP', addr: 1, ep: 2 },
    { pid: 'PING', addr: 42, ep: 7 },
    { pid: 'SOF', frame: 0 },
    { pid: 'SOF', frame: 2047 },
  ]);
  yield packetCase('crc-and-sync-errors', seed ^ 1, 77n, 'low-speed', [
    { pid: 'OUT', addr: 3, ep: 4, corruptCrc: true },
    { pid: 'DATA0', data: [0x00, 0xff, 0x55], corruptCrc: true },
    { pid: 'ACK', corruptSync: true },
    { pid: 'NAK' },
    { pid: 'STALL' },
    { pid: 'NYET' },
    { pid: 'PRE' },
    { pid: 'Reserved' },
  ]);
  yield packetCase('data-length-boundaries', seed ^ 2, 9_007_199_254_740_000n, 'full-speed', [
    { pid: 'DATA0' },
    { pid: 'DATA1', data: [0x00] },
    {
      pid: 'DATA0',
      data: Array.from({ length: 64 }, (_, index) => index & 0xff),
    },
  ]);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 24;
  yield {
    name: 'seeded-long-data-packets',
    kind: 'long',
    seed,
    sampleRate: 48_000_000,
    startSample: 0n,
    channels: { dp: 2, dm: 5 },
    options: caseOptions('full-speed'),
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'usb_signalling', options: caseOptions('full-speed') }],
    signalling: 'full-speed',
    *generate() {
      const random = randomWords(seed);
      const width = usbBitWidth(48_000_000, 'full-speed');
      let cursor = BigInt(USB_LEAD_BITS * width);
      let total = 0;
      while (total < required) {
        const data: UsbPacketSpec[] = [];
        const expected: ExpectedFrame[] = [];
        let payloadBits = 0;
        for (let index = 0; index < perBlock; index++) {
          const packet: UsbPacketSpec = {
            pid: index & 1 ? 'DATA1' : 'DATA0',
            data: Array.from({ length: 64 }, () => random() & 0xff),
          };
          const layout = packetLayout(packet, cursor, width);
          cursor = layout.next;
          payloadBits += layout.payloadBits;
          data.push(packet);
          expected.push(...layout.frames);
        }
        total += payloadBits;
        yield { data, expected, payloadBits };
      }
    },
  };
}
