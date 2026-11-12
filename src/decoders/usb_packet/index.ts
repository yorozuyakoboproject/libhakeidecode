import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export type UsbPidName =
  | 'OUT'
  | 'IN'
  | 'SOF'
  | 'SETUP'
  | 'DATA0'
  | 'DATA1'
  | 'DATA2'
  | 'MDATA'
  | 'ACK'
  | 'NAK'
  | 'STALL'
  | 'NYET'
  | 'PRE'
  | 'SPLIT'
  | 'PING'
  | 'Reserved'
  | 'UNKNOWN';

export type UsbPacketProtocol =
  | readonly ['SYNC' | 'SYNC ERROR', string]
  | readonly ['PID', string]
  | readonly ['FRAMENUM' | 'ADDR' | 'EP' | 'CRC5' | 'CRC5 ERROR' | 'CRC16' | 'CRC16 ERROR' | 'DATABYTE', number]
  | readonly ['DATABYTES', readonly number[]]
  | readonly ['PACKET', readonly [category: string, name: string, info: readonly unknown[]]];

export interface UsbPacketOptions {
  signalling: 'full-speed' | 'low-speed';
}

interface PacketBit {
  readonly bit: string;
  readonly ss: bigint;
  readonly es: bigint;
}

type State = 'WAIT FOR SOP' | 'GET BIT';

export const USB_PIDS: Readonly<Record<Exclude<UsbPidName, 'UNKNOWN'>, string>> = {
  OUT: '10000111',
  IN: '10010110',
  SOF: '10100101',
  SETUP: '10110100',
  DATA0: '11000011',
  DATA1: '11010010',
  DATA2: '11100001',
  MDATA: '11110000',
  ACK: '01001011',
  NAK: '01011010',
  STALL: '01111000',
  NYET: '01101001',
  PRE: '00111100',
  SPLIT: '00011110',
  PING: '00101101',
  Reserved: '00001111',
};

const PID_NAMES = new Map(Object.entries(USB_PIDS).map(([name, bits]) => [bits, name]));
const TOKEN_NAMES = new Set(['OUT', 'IN', 'SOF', 'SETUP', 'PING']);
const DATA_NAMES = new Set(['DATA0', 'DATA1', 'DATA2', 'MDATA']);
const HANDSHAKE_NAMES = new Set(['ACK', 'NAK', 'STALL', 'NYET', 'ERR']);
const PACKET_ANNOTATIONS = [
  'OUT',
  'IN',
  'SOF',
  'SETUP',
  'DATA0',
  'DATA1',
  'DATA2',
  'MDATA',
  'ACK',
  'NAK',
  'STALL',
  'NYET',
  'PRE',
  'ERR',
  'SPLIT',
  'PING',
  'Reserved',
];

function category(name: string): string {
  if (['OUT', 'IN', 'SOF', 'SETUP'].includes(name)) return 'TOKEN';
  if (DATA_NAMES.has(name)) return 'DATA';
  if (HANDSHAKE_NAMES.has(name)) return 'HANDSHAKE';
  return 'SPECIAL';
}

function annotationIndex(name: string): number {
  const index = PACKET_ANNOTATIONS.indexOf(name);
  return index < 0 ? 28 : index + 11;
}

function bitStringToNumber(bits: string): number {
  let value = 0;
  for (let index = 0; index < bits.length; index++) if (bits[index] === '1') value |= 1 << index;
  return value;
}

function reverseNumber(value: number, count: number): number {
  let result = 0;
  for (let index = 0; index < count; index++) if ((value >>> index) & 1) result |= 1 << (count - index - 1);
  return result;
}

export function calcCrc5(bits: string): number {
  let crc = 0x1f;
  for (const bit of bits) {
    crc <<= 1;
    if (Number(bit) !== crc >>> 5) crc ^= 0x25;
    crc &= 0x1f;
  }
  return reverseNumber(crc ^ 0x1f, 5);
}

export function calcCrc16(bits: string): number {
  let crc = 0xffff;
  for (const bit of bits) {
    crc <<= 1;
    if (Number(bit) !== crc >>> 16) crc ^= 0x18005;
    crc &= 0xffff;
  }
  return reverseNumber(crc ^ 0xffff, 16);
}

export class UsbPacketDecoder extends Decoder<UsbPacketOptions> {
  static descriptor = descriptor;

  private outProtocol = -1;
  private outAnn = -1;
  private bits: PacketBit[] = [];
  private packet: unknown[] = [];
  private packetSummary = '';
  private fieldStart = 0n;
  private fieldEnd = 0n;
  private packetStart: bigint | null = null;
  private packetEnd: bigint | null = null;
  private state: State = 'WAIT FOR SOP';

  constructor(options: Partial<UsbPacketOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.bits = [];
    this.packet = [];
    this.packetSummary = '';
    this.fieldStart = 0n;
    this.fieldEnd = 0n;
    this.packetStart = null;
    this.packetEnd = null;
    this.state = 'WAIT FOR SOP';
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putpb(data: readonly unknown[]): void {
    this.put(this.fieldStart, this.fieldEnd, this.outProtocol, data);
  }

  private putb(data: readonly [number, readonly string[]]): void {
    this.put(this.fieldStart, this.fieldEnd, this.outAnn, data);
  }

  private putpp(data: readonly unknown[]): void {
    this.put(this.packetStart ?? 0n, this.packetEnd ?? 0n, this.outProtocol, data);
  }

  private putp(data: readonly [number, readonly string[]]): void {
    this.put(this.packetStart ?? 0n, this.packetEnd ?? 0n, this.outAnn, data);
  }

  private invalid(message: string): void {
    this.putp([28, [message]]);
  }

  private handlePacket(): void {
    const bits = this.bits;
    let packet = '';
    for (const item of bits) packet += item.bit;

    if (packet.length < 8) {
      this.invalid('Invalid packet (shorter than 8 bits)');
      return;
    }

    const sync = packet.slice(0, 8);
    this.fieldStart = bits[0]!.ss;
    this.fieldEnd = bits[7]!.es;
    if (sync !== '00000001') {
      this.putpb(['SYNC ERROR', sync]);
      this.putb([1, [`SYNC ERROR: ${sync}`, `SYNC ERR: ${sync}`, 'SYNC ERR', 'SE', 'S']]);
    } else {
      this.putpb(['SYNC', sync]);
      this.putb([0, [`SYNC: ${sync}`, 'SYNC', 'S']]);
    }
    this.packet.push(sync);

    if (packet.length < 16) {
      this.invalid('Invalid packet (shorter than 16 bits)');
      return;
    }

    const pidBits = packet.slice(8, 16);
    const pidName = PID_NAMES.get(pidBits) ?? 'UNKNOWN';
    this.fieldStart = bits[8]!.ss;
    this.fieldEnd = bits[15]!.es;
    this.putpb(['PID', pidName]);
    this.putb([2, [`PID: ${pidName}`, pidName, pidName[0] ?? '?']]);
    this.packet.push(pidName);
    this.packetSummary += pidName;

    if (TOKEN_NAMES.has(pidName)) {
      if (packet.length < 32) {
        this.invalid('Invalid packet (shorter than 32 bits)');
        return;
      }
      if (pidName === 'SOF') {
        const frame = bitStringToNumber(packet.slice(16, 27));
        this.fieldStart = bits[16]!.ss;
        this.fieldEnd = bits[26]!.es;
        this.putpb(['FRAMENUM', frame]);
        this.putb([3, [`Frame: ${frame}`, 'Frame', 'Fr', 'F']]);
        this.packet.push(frame);
        this.packetSummary += ` ${frame}`;
      } else {
        const address = bitStringToNumber(packet.slice(16, 23));
        this.fieldStart = bits[16]!.ss;
        this.fieldEnd = bits[22]!.es;
        this.putpb(['ADDR', address]);
        this.putb([4, [`Address: ${address}`, `Addr: ${address}`, 'Addr', 'A']]);
        this.packet.push(address);
        this.packetSummary += ` ADDR ${address}`;

        const endpoint = bitStringToNumber(packet.slice(23, 27));
        this.fieldStart = bits[23]!.ss;
        this.fieldEnd = bits[26]!.es;
        this.putpb(['EP', endpoint]);
        this.putb([5, [`Endpoint: ${endpoint}`, `EP: ${endpoint}`, 'EP', 'E']]);
        this.packet.push(endpoint);
        this.packetSummary += ` EP ${endpoint}`;
      }

      const crc5 = bitStringToNumber(packet.slice(27, 32));
      const calculated = calcCrc5(packet.slice(16, 27));
      this.fieldStart = bits[27]!.ss;
      this.fieldEnd = bits[31]!.es;
      if (crc5 === calculated) {
        this.putpb(['CRC5', crc5]);
        this.putb([6, [`CRC5: 0x${crc5.toString(16).toUpperCase().padStart(2, '0')}`, 'CRC5', 'C']]);
      } else {
        this.putpb(['CRC5 ERROR', crc5]);
        this.putb([7, [`CRC5 ERROR: 0x${crc5.toString(16).toUpperCase().padStart(2, '0')}`, 'CRC5 ERR', 'CE', 'C']]);
      }
      this.packet.push(crc5);
    } else if (DATA_NAMES.has(pidName)) {
      const data = packet.slice(16, Math.max(16, packet.length - 16));
      const bytes: number[] = [];
      this.packetSummary += ' [';
      for (let offset = 0; offset + 8 <= data.length; offset += 8) {
        const value = bitStringToNumber(data.slice(offset, offset + 8));
        this.fieldStart = bits[16 + offset]!.ss;
        this.fieldEnd = bits[23 + offset]!.es;
        this.putpb(['DATABYTE', value]);
        const text = value.toString(16).toUpperCase().padStart(2, '0');
        this.putb([8, [`Databyte: ${text}`, `Data: ${text}`, `DB: ${text}`, text]]);
        bytes.push(value);
        this.packetSummary += ` ${text}`;
      }
      this.packetSummary += ' ]';

      if (packet.length < 32) {
        this.invalid('Invalid packet (shorter than 32 bits)');
        return;
      }

      this.fieldStart = bits[16]!.ss;
      this.fieldEnd = bits[bits.length - 16]!.es;
      this.putpb(['DATABYTES', bytes]);
      this.packet.push(bytes);

      const crc16 = bitStringToNumber(packet.slice(-16));
      const calculated = calcCrc16(data);
      this.fieldStart = bits[bits.length - 16]!.ss;
      this.fieldEnd = bits[bits.length - 1]!.es;
      if (crc16 === calculated) {
        this.putpb(['CRC16', crc16]);
        this.putb([9, [`CRC16: 0x${crc16.toString(16).toUpperCase().padStart(4, '0')}`, 'CRC16', 'C']]);
      } else {
        this.putpb(['CRC16 ERROR', crc16]);
        this.putb([
          10,
          [`CRC16 ERROR: 0x${crc16.toString(16).toUpperCase().padStart(4, '0')}`, 'CRC16 ERR', 'CE', 'C'],
        ]);
      }
      this.packet.push(crc16);
    }

    const packetCategory = category(pidName);
    this.putpp(['PACKET', [packetCategory, pidName, this.packet]]);
    this.putp([annotationIndex(pidName), [this.packetSummary]]);
    this.packet = [];
    this.packetSummary = '';
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || data.length !== 2) return;
    const [type, value] = data as [string, unknown];
    if (!['SOP', 'BIT', 'EOP', 'ERR'].includes(type)) return;

    if (this.state === 'WAIT FOR SOP') {
      if (type !== 'SOP') return;
      this.packetStart = ss;
      this.state = 'GET BIT';
      return;
    }
    if (type === 'BIT') {
      this.bits.push({ bit: String(value), ss, es });
      return;
    }
    this.packetEnd = es;
    this.handlePacket();
    this.bits = [];
    this.state = 'WAIT FOR SOP';
  }
}

export default UsbPacketDecoder;
