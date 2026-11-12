import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const IRMP_BASE_RATE = 20_000;
export const IRMP_FRAME_GAP_TICKS = 310;
const IRMP_REPEAT_WINDOW_TICKS = 3_000;
const IRMP_NEC_REPEAT_WINDOW_TICKS = 2_400;
const IRMP_TRAILING_GAP_TICKS = IRMP_FRAME_GAP_TICKS + 2;
const STOP_BIT_PROTOCOLS = new Set([
  2, 3, 4, 5, 6, 8, 10, 11, 12, 13, 14, 18, 19, 20, 22, 25, 27, 28, 29, 30, 31, 34, 36, 37, 38, 39, 40, 41, 43, 46, 47,
  48, 49, 50, 51, 52, 53, 56, 57,
]);

export type IrmpProtocolFamily = 'pulse-distance' | 'manchester' | 'rcmm';

export interface IrmpProtocolSpec {
  readonly id: number;
  readonly name: string;
  readonly family: IrmpProtocolFamily;
  readonly bits: number;
  readonly headerPulse: number;
  readonly headerGap: number;
  readonly addressOffset: number;
  readonly addressBits: number;
  readonly commandOffset: number;
  readonly commandBits: number;
  readonly lsbFirst: boolean;
  readonly pulseOne: number;
  readonly pulseZero: number;
  readonly gapOne: number;
  readonly gapZero: number;
  readonly half: number;
  readonly rcmmPulse: number;
  readonly rcmmGaps: readonly number[];
  readonly syncAfterBit: number;
  readonly stopPulse: number;
  readonly stopBit: boolean;
}

export interface IrmpFrame {
  readonly protocol: number;
  readonly address: number;
  readonly command: number;
  readonly repeat?: boolean;
  readonly raw?: readonly number[];
  readonly startMultiplier?: number;
  readonly gapTicks?: number;
}

interface ProtocolInput extends Partial<IrmpProtocolSpec> {
  readonly id: number;
  readonly name: string;
  readonly family: IrmpProtocolFamily;
  readonly bits: number;
}

const tick = (microseconds: number): number => Math.max(1, Math.round((microseconds * IRMP_BASE_RATE) / 1_000_000));
const IRMP_NIKON_TIMEOUT_TICKS = tick(29_500);

export const IRMP_NEC_REPEAT_HEADER_TICKS = tick(9000);
export const IRMP_NEC_REPEAT_GAP_TICKS = tick(2250);
export const IRMP_NEC_REPEAT_STOP_TICKS = tick(560);

function define(input: ProtocolInput): IrmpProtocolSpec {
  return Object.freeze({
    headerPulse: 0,
    headerGap: 0,
    addressOffset: 0,
    addressBits: 0,
    commandOffset: 0,
    commandBits: input.bits,
    lsbFirst: false,
    pulseOne: 0,
    pulseZero: 0,
    gapOne: 0,
    gapZero: 0,
    half: 0,
    rcmmPulse: 0,
    rcmmGaps: [0, 0, 0, 0],
    syncAfterBit: 0,
    stopPulse: 0,
    stopBit: STOP_BIT_PROTOCOLS.has(input.id),
    ...input,
  });
}

function pd(
  id: number,
  name: string,
  bits: number,
  header: readonly [number, number],
  fields: readonly [number, number, number, number],
  lsbFirst: boolean,
  timing: readonly [number, number, number, number],
  syncAfterBit = 0,
  stopMicroseconds = 0,
): IrmpProtocolSpec {
  return define({
    id,
    name,
    family: 'pulse-distance',
    bits,
    headerPulse: tick(header[0]),
    headerGap: tick(header[1]),
    addressOffset: fields[0],
    addressBits: fields[1],
    commandOffset: fields[2],
    commandBits: fields[3],
    lsbFirst,
    pulseOne: tick(timing[0]),
    pulseZero: tick(timing[1]),
    gapOne: tick(timing[2]),
    gapZero: tick(timing[3]),
    syncAfterBit,
    stopPulse: stopMicroseconds ? tick(stopMicroseconds) : 0,
  });
}

function manchester(
  id: number,
  name: string,
  bits: number,
  header: readonly [number, number],
  halfUs: number,
  fields: readonly [number, number, number, number],
  lsbFirst: boolean,
): IrmpProtocolSpec {
  return define({
    id,
    name,
    family: 'manchester',
    bits,
    headerPulse: tick(header[0]),
    headerGap: tick(header[1]),
    addressOffset: fields[0],
    addressBits: fields[1],
    commandOffset: fields[2],
    commandBits: fields[3],
    lsbFirst,
    half: tick(halfUs),
  });
}

function rcmm(
  id: number,
  name: string,
  bits: number,
  fields: readonly [number, number, number, number],
  lsbFirst: boolean,
): IrmpProtocolSpec {
  return define({
    id,
    name,
    family: 'rcmm',
    bits,
    headerPulse: tick(500),
    headerGap: tick(220),
    addressOffset: fields[0],
    addressBits: fields[1],
    commandOffset: fields[2],
    commandBits: fields[3],
    lsbFirst,
    rcmmPulse: tick(230),
    rcmmGaps: [tick(220), tick(370), tick(540), tick(720)],
  });
}

export const IRMP_PROTOCOLS: readonly IrmpProtocolSpec[] = Object.freeze([
  pd(1, 'SIRCS', 20, [2400, 600], [15, 5, 0, 15], true, [1200, 600, 600, 600]),
  pd(2, 'NEC', 32, [9000, 4500], [0, 16, 16, 16], true, [560, 560, 1690, 560]),
  pd(3, 'SAMSUNG', 37, [4500, 4500], [0, 16, 21, 16], true, [550, 550, 1500, 500], 16),
  pd(4, 'MATSUSH', 24, [3488, 3488], [12, 12, 0, 12], true, [872, 872, 2616, 872]),
  pd(5, 'KASEIKYO', 48, [3380, 1690], [0, 16, 28, 12], true, [423, 423, 1269, 423]),
  pd(6, 'RECS80', 10, [158, 7432], [1, 3, 4, 6], false, [158, 158, 7432, 4902]),
  manchester(7, 'RC5', 13, [889, 889], 889, [1, 6, 7, 6], false),
  pd(8, 'DENON', 15, [310, 745], [0, 5, 5, 10], false, [310, 310, 1780, 745]),
  manchester(9, 'RC6', 21, [2666, 889], 444, [5, 8, 13, 8], false),
  pd(10, 'SAMSG32', 32, [4500, 4500], [0, 16, 16, 16], true, [550, 550, 1500, 500]),
  pd(11, 'APPLE', 32, [9000, 4500], [0, 16, 16, 16], true, [560, 560, 1690, 560]),
  pd(12, 'RECS80EX', 12, [158, 3637], [2, 4, 6, 6], false, [158, 158, 7432, 4902]),
  pd(13, 'NUBERT', 10, [1340, 340], [0, 0, 0, 10], false, [1340, 500, 340, 1300]),
  pd(14, 'BANG OLU', 20, [200, 3125], [0, 0, 3, 16], false, [200, 200, 9375, 3125]),
  manchester(15, 'GRUNDIG', 10, [528, 2639], 528, [0, 0, 1, 9], true),
  manchester(16, 'NOKIA', 17, [528, 2639], 528, [9, 8, 1, 8], true),
  manchester(17, 'SIEMENS', 22, [370, 550], 275, [0, 11, 11, 11], false),
  pd(18, 'FDC', 40, [2085, 966], [0, 14, 20, 12], true, [300, 300, 715, 220]),
  pd(19, 'RCCAR', 13, [2000, 2000], [0, 0, 0, 13], true, [600, 600, 450, 900]),
  pd(20, 'JVC', 16, [9000, 4500], [0, 4, 4, 12], true, [560, 560, 1690, 560], 0, 560),
  manchester(21, 'RC6A', 36, [2666, 889], 444, [5, 15, 21, 15], false),
  pd(22, 'NIKON', 2, [2200, 27100], [0, 0, 0, 2], false, [500, 500, 3500, 1500]),
  manchester(23, 'RUWIDO', 17, [370, 550], 275, [0, 9, 9, 8], false),
  manchester(24, 'IR60', 7, [528, 2639], 528, [0, 0, 0, 7], true),
  pd(25, 'KATHREIN', 13, [210, 6218], [1, 4, 5, 7], false, [210, 210, 3000, 1400]),
  pd(26, 'NETBOX', 16, [2400, 800], [0, 3, 3, 13], true, [800, 800, 1600, 800]),
  pd(27, 'NEC16', 16, [9000, 4500], [0, 8, 8, 8], true, [560, 560, 1690, 560], 8),
  pd(28, 'NEC42', 42, [9000, 4500], [0, 13, 26, 8], true, [560, 560, 1690, 560]),
  pd(29, 'LEGO', 16, [158, 1026], [0, 0, 0, 16], false, [158, 158, 553, 263]),
  pd(30, 'THOMSON', 12, [550, 2000], [0, 4, 5, 7], false, [550, 550, 4500, 2000]),
  pd(31, 'BOSE', 16, [1060, 1425], [0, 0, 0, 16], true, [550, 550, 1425, 437]),
  manchester(32, 'A1TVBOX', 17, [300, 340], 250, [1, 8, 9, 8], false),
  manchester(33, 'ORTEK', 18, [2000, 1000], 500, [0, 8, 8, 6], false),
  pd(34, 'TELEFUNKEN', 15, [600, 1500], [0, 0, 0, 15], false, [600, 600, 1500, 600]),
  pd(35, 'ROOMBA', 7, [2790, 930], [0, 0, 0, 7], false, [2790, 930, 930, 2790]),
  rcmm(36, 'RCMM32', 32, [0, 16, 17, 15], false),
  rcmm(37, 'RCMM24', 24, [0, 16, 17, 7], false),
  rcmm(38, 'RCMM12', 12, [0, 4, 4, 8], false),
  pd(39, 'SPEAKER', 10, [440, 1250], [0, 0, 0, 10], false, [1250, 440, 440, 1250]),
  pd(40, 'LGAIR', 28, [9000, 4500], [0, 8, 8, 16], false, [560, 560, 1690, 560]),
  pd(41, 'SAMSG48', 48, [4500, 4500], [0, 16, 16, 32], true, [550, 550, 1500, 500]),
  manchester(42, 'MERLIN', 45, [210, 420], 210, [2, 9, 11, 32], false),
  pd(43, 'PENTAX', 6, [13000, 3000], [0, 0, 0, 6], false, [1000, 1000, 3000, 1000]),
  pd(44, 'FAN', 11, [1280, 380], [0, 0, 0, 11], false, [1280, 380, 380, 1280]),
  manchester(45, 'S100', 14, [889, 889], 889, [1, 6, 7, 7], false),
  pd(46, 'ACP24', 70, [390, 950], [0, 0, 0, 16], false, [390, 390, 1300, 950]),
  pd(47, 'TECHNICS', 22, [3488, 3488], [0, 0, 0, 11], true, [872, 872, 2616, 872]),
  pd(48, 'PANASONIC', 56, [3600, 1600], [24, 16, 40, 16], true, [565, 565, 1140, 316]),
  pd(49, 'MITSU_HEAVY', 88, [3200, 1560], [40, 16, 56, 16], false, [400, 400, 1200, 430]),
  pd(50, 'VINCENT', 32, [2500, 4600], [0, 16, 16, 16], false, [550, 550, 1540, 550]),
  pd(51, 'SAMSUNGAH', 48, [2500, 1900], [0, 16, 32, 16], true, [450, 450, 1100, 450]),
  pd(52, 'IRMP16', 16, [842, 1052], [0, 0, 0, 16], true, [421, 421, 842, 421]),
  pd(53, 'GREE', 32, [12000, 6000], [0, 16, 16, 16], true, [900, 900, 700, 2100]),
  manchester(54, 'RCII', 10, [512, 2560], 512, [0, 0, 0, 10], false),
  pd(55, 'METZ', 20, [870, 2300], [1, 6, 7, 13], false, [435, 435, 1680, 960]),
  pd(56, 'ONKYO', 32, [9000, 4500], [0, 16, 16, 16], true, [560, 560, 1690, 560]),
  pd(57, 'RADIO1', 23, [3000, 7000], [4, 16, 20, 3], true, [1000, 500, 500, 1000]),
]);

const SPEC_BY_ID = new Map(IRMP_PROTOCOLS.map((spec) => [spec.id, spec]));

export function getProtocolSpec(protocol: number): IrmpProtocolSpec {
  const spec = SPEC_BY_ID.get(protocol);
  if (!spec) throw new RangeError(`Unknown IRMP protocol: ${protocol}`);
  return spec;
}

export function protocolFields(spec: IrmpProtocolSpec): { addressBits: number; commandBits: number } {
  switch (spec.id) {
    case 2:
    case 11:
    case 31:
    case 50:
      return { addressBits: spec.id === 2 ? 16 : spec.id === 11 ? 8 : spec.id === 31 ? 0 : 16, commandBits: 8 };
    case 3:
      return { addressBits: 16, commandBits: 12 };
    case 5:
      return { addressBits: 16, commandBits: 16 };
    case 7:
    case 45:
      return { addressBits: 5, commandBits: spec.id === 45 ? 7 : 6 };
    case 17:
      return { addressBits: 11, commandBits: 10 };
    case 18:
      return { addressBits: 6, commandBits: 16 };
    case 19:
      return { addressBits: 2, commandBits: 11 };
    case 23:
      return { addressBits: 9, commandBits: 7 };
    case 26:
      return { addressBits: 3, commandBits: 8 };
    case 27:
      return { addressBits: 8, commandBits: 8 };
    case 29:
      return { addressBits: 0, commandBits: 12 };
    case 33:
      return { addressBits: 6, commandBits: 6 };
    case 37:
      return { addressBits: 16, commandBits: 7 };
    case 38:
      return { addressBits: 4, commandBits: 8 };
    case 41:
      return { addressBits: 16, commandBits: 16 };
    case 46:
      return { addressBits: 0, commandBits: 16 };
    case 49:
      return { addressBits: 8, commandBits: 8 };
    case 55:
      return { addressBits: 3, commandBits: 6 };
    default:
      return { addressBits: spec.addressBits, commandBits: spec.commandBits };
  }
}

function writeBits(bits: number[], offset: number, width: number, value: number, lsbFirst: boolean): void {
  for (let index = 0; index < width; index++) {
    const bit = Math.floor(value / 2 ** (lsbFirst ? index : width - index - 1)) % 2;
    if (offset + index < bits.length) bits[offset + index] = bit;
  }
}

export function frameBits(spec: IrmpProtocolSpec, frame: IrmpFrame): number[] {
  const bits = new Array<number>(spec.bits).fill(0);
  const address = frame.address >>> 0;
  const command = frame.command >>> 0;
  const write = (offset: number, width: number, value: number, lsbFirst = spec.lsbFirst): void =>
    writeBits(bits, offset, width, value, lsbFirst);

  switch (spec.id) {
    case 1: {
      const length = Math.max(12, Math.min(20, 11 + ((address >>> 8) & 0x0f)));
      write(0, Math.min(15, length), command);
      if (length === 20) write(15, 5, address);
      return bits.slice(0, length);
    }
    case 2: {
      const low = command & 0xff;
      write(0, 16, address);
      write(16, 16, low | ((~low & 0xff) << 8));
      break;
    }
    case 3: {
      const low = command & 0xff;
      write(0, 16, address);
      write(17, 4, (command >> 8) & 0x0f);
      write(21, 16, low | ((~low & 0xff) << 8));
      break;
    }
    case 5: {
      const parity = ((address >>> 12) ^ (address >>> 8) ^ (address >>> 4) ^ address) & 0x0f;
      const genre1 = (command >>> 12) & 0x0f;
      const genre2 = command & 0x0f;
      const byte2 = (genre1 << 4) | parity;
      const byte3 = (genre2 << 4) | genre1;
      const byte4 = (command >>> 4) & 0xff;
      write(0, 16, address);
      write(16, 8, byte2);
      write(24, 8, byte3);
      write(32, 8, byte4);
      write(40, 8, byte2 ^ byte3 ^ byte4);
      break;
    }
    case 7:
    case 45:
      write(0, 1, 0);
      write(1, spec.id === 45 ? 6 : 6, address & 0x1f);
      write(spec.commandOffset, spec.commandBits, command);
      break;
    case 11: {
      const low = command & 0xff;
      write(0, 16, 0x87ee);
      write(16, 16, low | ((address & 0xff) << 8));
      break;
    }
    case 17:
      write(0, 11, address);
      write(11, 11, ((command & 0x03ff) << 1) | (~(command >>> 0) & 1 ? 1 : 0));
      break;
    case 18: {
      const rawCommand = command & 0x80 ? ((command & 0x7f) << 4) | 1 : (command & 0xff) << 4;
      write(0, 14, (address & 0x3f) | (((command >>> 8) & 0x0f) << 6));
      write(20, 12, rawCommand);
      break;
    }
    case 19:
      write(
        0,
        13,
        ((address & 0x03) << 2) | ((command & 0xff) << 4) | ((command >>> 8) & 0x03) | (((command >>> 10) & 1) << 12),
      );
      break;
    case 21:
      bits[1] = 1;
      write(5, 15, address);
      write(21, 15, command);
      break;
    case 23:
      write(0, 9, address);
      write(9, 8, ((command & 0x7f) << 1) | (~(command >>> 0) & 1 ? 1 : 0));
      break;
    case 26:
      write(0, 3, address);
      write(3, 13, 0x1000 | ((command & 0x7f) << 5) | (command & 0x80 ? 0x10 : 0x15));
      break;
    case 27:
      write(0, 8, address);
      write(8, 8, command & 0xff);
      break;
    case 29: {
      const crc = 0x0f ^ ((command >>> 8) & 0x0f) ^ ((command >>> 4) & 0x0f) ^ (command & 0x0f);
      write(0, 12, command & 0x0fff, false);
      write(12, 4, crc, false);
      break;
    }
    case 31: {
      const low = command & 0xff;
      write(0, 16, low | ((~low & 0xff) << 8));
      break;
    }
    case 32:
      write(0, 1, 1, false);
      write(1, 8, address);
      write(9, 8, command);
      break;
    case 33:
      write(0, 8, (address & 0x3f) << 2, false);
      write(8, 6, command, false);
      {
        let parity = 0;
        for (let index = 0; index < 14; index++) parity ^= bits[index] ?? 0;
        bits[14] = parity === 0 ? 1 : 0;
      }
      break;
    case 40:
      write(0, 8, address, false);
      write(8, 16, command, false);
      break;
    case 41:
      write(0, 16, address);
      write(16, 8, command & 0xff);
      write(32, 8, (command >>> 8) & 0xff);
      break;
    case 46: {
      const mapping: readonly (readonly [number, number])[] = [
        [15, 0],
        [14, 24],
        [13, 2],
        [12, 3],
        [11, 22],
        [10, 4],
        [9, 5],
        [8, 6],
        [7, 23],
        [6, 20],
        [5, 26],
        [4, 44],
        [3, 66],
        [2, 67],
        [1, 68],
        [0, 69],
      ];
      for (const [source, target] of mapping) {
        if ((command >>> source) & 1) bits[target] = 1;
      }
      break;
    }
    case 47: {
      write(0, 11, command & 0x07ff);
      write(11, 1, ~(command >>> 0) & 1 ? 1 : 0);
      write(12, 10, (~(command >>> 0) & 0x07ff) >>> 1);
      break;
    }
    case 49: {
      const lowAddress = address & 0xff;
      const highAddress = (address >>> 8) & 0xff;
      const lowCommand = command & 0xff;
      write(40, 8, ~highAddress & 0xff, false);
      write(48, 8, highAddress, false);
      write(56, 8, ~lowAddress & 0xff, false);
      write(64, 8, lowAddress, false);
      write(72, 8, ~lowCommand & 0xff, false);
      write(80, 8, lowCommand, false);
      break;
    }
    case 50: {
      const low = command & 0xff;
      write(0, 16, address, false);
      write(16, 16, low | (low << 8), false);
      break;
    }
    case 55: {
      const low = command & 0x3f;
      write(1, 6, ((address & 0x07) << 3) | (~address & 0x07), false);
      write(7, 13, ((low << 6) | (~low & 0x3f)) & 0x1fff, false);
      break;
    }
    default:
      write(spec.addressOffset, spec.addressBits, address);
      write(spec.commandOffset, spec.commandBits, command);
      break;
  }
  return bits;
}

function readField(bits: readonly number[], offset: number, width: number, lsbFirst: boolean): number {
  let value = 0;
  for (let index = 0; index < width; index++) {
    const bit = bits[offset + index] ?? 0;
    value += bit * 2 ** (lsbFirst ? index : width - index - 1);
  }
  return value;
}

export function annotationTexts(frame: IrmpFrame): readonly string[] {
  const spec = getProtocolSpec(frame.protocol);
  const repeat = frame.repeat === true;
  const longFlags = repeat ? 'repeat' : '-';
  const mediumFlags = repeat ? 'rep' : '-';
  const shortFlags = repeat ? 'r' : '-';
  const address = frame.address >>> 0;
  const command = frame.command >>> 0;
  return [
    `Protocol: ${spec.name} (${spec.id}), Address 0x${address.toString(16).padStart(4, '0')}, Command: 0x${command.toString(16).padStart(4, '0')}, Flags: ${longFlags}`,
    `P: ${spec.name} (${spec.id}), Addr: 0x${address.toString(16)}, Cmd: 0x${command.toString(16)}, Flg: ${mediumFlags}`,
    `P: ${spec.id} A: 0x${address.toString(16)} C: 0x${command.toString(16)} F: ${mediumFlags}`,
    `C:${command.toString(16)} A:${address.toString(16)} ${shortFlags}`,
    `C:${command.toString(16)}`,
  ];
}

interface Interval {
  readonly active: boolean;
  readonly ticks: number;
}

interface ParsedFrame {
  readonly frame: IrmpFrame;
  readonly endTick: number;
  readonly score: number;
}

function durationError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(2, expected);
}

function closeEnough(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(1.5, expected * 0.35);
}

function decodedFrame(
  spec: IrmpProtocolSpec,
  bits: readonly number[],
): { protocol: number; address: number; command: number } | null {
  const address = readField(bits, spec.addressOffset, spec.addressBits, spec.lsbFirst);
  const command = readField(bits, spec.commandOffset, spec.commandBits, spec.lsbFirst);

  switch (spec.id) {
    case 2: {
      const high = (command >>> 8) & 0xff;
      const low = command & 0xff;
      if (high === (~low & 0xff)) return { protocol: 2, address, command: low };
      if (address === 0x87ee) return { protocol: 11, address: high, command: low };
      return { protocol: 56, address, command };
    }
    case 3: {
      const high = (command >>> 8) & 0xff;
      const low = command & 0xff;
      if (high !== (~low & 0xff)) return null;
      return { protocol: 3, address, command: low | (readField(bits, 17, 4, true) << 8) };
    }
    case 5: {
      const byte2 = readField(bits, 16, 8, true);
      const byte3 = readField(bits, 24, 8, true);
      const byte4 = readField(bits, 32, 8, true);
      const byte5 = readField(bits, 40, 8, true);
      const customerCheck =
        ((address & 0x0f) ^ ((address >>> 4) & 0x0f) ^ ((address >>> 8) & 0x0f) ^ ((address >>> 12) & 0x0f)) & 0x0f;
      if ((byte2 & 0x0f) !== customerCheck || (byte2 ^ byte3 ^ byte4) !== byte5) return null;
      return {
        protocol: 5,
        address,
        command: (readField(bits, 20, 4, true) << 12) | readField(bits, 28, 12, true),
      };
    }
    case 7:
      return { protocol: 7, address: address & 0x1f, command };
    case 11: {
      const high = (command >>> 8) & 0xff;
      const low = command & 0xff;
      return { protocol: 11, address: high, command: low };
    }
    case 17:
      if (((command >>> 1) & 1) !== (~command & 1)) return null;
      return { protocol: 17, address, command: command >>> 1 };
    case 18: {
      let output = command & 0x0f ? (command >>> 4) | 0x80 : command >>> 4;
      output |= (address << 2) & 0x0f00;
      return { protocol: 18, address: address & 0x3f, command: output };
    }
    case 19:
      return {
        protocol: 19,
        address: (command >>> 2) & 0x03,
        command: (((command >>> 12) & 1) << 10) | ((command & 0x03) << 8) | ((command >>> 4) & 0xff),
      };
    case 23:
      if (((command >>> 1) & 1) !== (~command & 1)) return null;
      return { protocol: 23, address, command: command >>> 1 };
    case 26: {
      if (!(command & 0x1000)) return null;
      const code = command & 0x1f;
      if (code === 0x15) return { protocol: 26, address, command: (command >>> 5) & 0x7f };
      if (code === 0x10) return { protocol: 26, address, command: ((command >>> 5) & 0x7f) | 0x80 };
      return null;
    }
    case 27:
      return { protocol: 27, address, command };
    case 29: {
      const data = readField(bits, 0, 12, false);
      const crc = 0x0f ^ ((data >>> 8) & 0x0f) ^ ((data >>> 4) & 0x0f) ^ (data & 0x0f);
      if (crc !== readField(bits, 12, 4, false)) return null;
      return { protocol: 29, address: 0, command: data };
    }
    case 31: {
      const high = (command >>> 8) & 0xff;
      const low = command & 0xff;
      if (high !== (~low & 0xff)) return null;
      return { protocol: 31, address: 0, command: low };
    }
    case 33: {
      let parity = 0;
      for (let index = 0; index < 14; index++) parity ^= bits[index] ?? 0;
      if ((bits[14] ?? 0) !== (parity === 0 ? 1 : 0)) return null;
      if ((address & 0x03) === 0x02) return null;
      return { protocol: 33, address: (address >>> 2) & 0x3f, command };
    }
    case 40:
      return {
        protocol: 40,
        address: readField(bits, 0, 8, false),
        command: readField(bits, 8, 16, false),
      };
    case 41:
      return {
        protocol: 41,
        address,
        command: readField(bits, 16, 8, true) | (readField(bits, 32, 8, true) << 8),
      };
    case 45:
      return { protocol: 45, address: address & 0x1f, command };
    case 46: {
      const mapping: readonly (readonly [number, number])[] = [
        [15, 0],
        [14, 24],
        [13, 2],
        [12, 3],
        [11, 22],
        [10, 4],
        [9, 5],
        [8, 6],
        [7, 23],
        [6, 20],
        [5, 26],
        [4, 44],
        [3, 66],
        [2, 67],
        [1, 68],
        [0, 69],
      ];
      let output = 0;
      for (const [target, source] of mapping) if (bits[source]) output |= 1 << target;
      return { protocol: 46, address: 0, command: output };
    }
    case 47: {
      const low = readField(bits, 0, 11, true);
      const check = (readField(bits, 12, 10, true) << 1) | (bits[11] ?? 0);
      if (low !== (~check & 0x07ff)) return null;
      return { protocol: 47, address: 0, command: low };
    }
    case 49: {
      const highAddress = readField(bits, 48, 8, false);
      const lowAddress = readField(bits, 64, 8, false);
      const command = readField(bits, 80, 8, false);
      if (readField(bits, 40, 8, false) !== (~highAddress & 0xff)) return null;
      if (readField(bits, 56, 8, false) !== (~lowAddress & 0xff)) return null;
      if (readField(bits, 72, 8, false) !== (~command & 0xff)) return null;
      return {
        protocol: 49,
        address: (highAddress << 8) | lowAddress,
        command,
      };
    }
    case 50: {
      const high = (command >>> 8) & 0xff;
      const low = command & 0xff;
      if (high !== low) return null;
      return { protocol: 50, address, command: low };
    }
    case 55: {
      const rawAddress = readField(bits, 1, 6, false);
      const rawCommand = readField(bits, 7, 13, false);
      if ((~rawAddress & 0x07) !== rawAddress >>> 3 || (~rawCommand & 0x3f) !== rawCommand >>> 6) {
        return null;
      }
      return { protocol: 55, address: rawAddress >>> 3, command: (rawCommand >>> 6) & 0x3f };
    }
    case 38:
      return {
        protocol: 38,
        address: readField(bits, 0, 4, false),
        command: readField(bits, 4, 8, false),
      };
    default:
      return { protocol: spec.id, address, command };
  }
}

function frameFromBits(
  spec: IrmpProtocolSpec,
  bits: readonly number[],
  endTick: number,
  score: number,
): ParsedFrame | null {
  const frame = decodedFrame(spec, bits);
  return frame ? { frame, endTick, score } : null;
}

function tryPulseDistance(spec: IrmpProtocolSpec, intervals: readonly Interval[]): ParsedFrame | null {
  if (intervals.length < 2) return null;
  if (!closeEnough(intervals[0]!.ticks, spec.headerPulse)) return null;
  if (!closeEnough(intervals[1]!.ticks, spec.headerGap)) return null;
  const bits = new Array<number>(spec.bits).fill(0);
  let score = durationError(intervals[0]!.ticks, spec.headerPulse);
  score += durationError(intervals[1]!.ticks, spec.headerGap);
  let cursor = 2;
  let bitIndex = 0;
  let syncDone = false;
  let finalBitCandidates: readonly number[] | null = null;
  let endTick = intervals[0]!.ticks + intervals[1]!.ticks;
  while (bitIndex < spec.bits) {
    if (!syncDone && spec.syncAfterBit > 0 && bitIndex === spec.syncAfterBit) {
      const syncPulse = intervals[cursor];
      const syncGap = intervals[cursor + 1];
      if (
        !syncPulse ||
        !syncGap ||
        !syncPulse.active ||
        syncGap.active ||
        !closeEnough(syncPulse.ticks, spec.pulseZero) ||
        !closeEnough(syncGap.ticks, spec.headerGap)
      ) {
        return null;
      }
      score += durationError(syncPulse.ticks, spec.pulseZero);
      score += durationError(syncGap.ticks, spec.headerGap);
      endTick += syncPulse.ticks + syncGap.ticks;
      cursor += 2;
      syncDone = true;
      bitIndex++;
      continue;
    }
    const pulseInterval = intervals[cursor];
    const gapInterval = intervals[cursor + 1];
    if (!pulseInterval || !gapInterval || !pulseInterval.active || gapInterval.active) return null;
    const pulse = pulseInterval.ticks;
    const gap = gapInterval.ticks;
    const pulseOne = closeEnough(pulse, spec.pulseOne);
    const pulseZero = closeEnough(pulse, spec.pulseZero);
    const gapOne = closeEnough(gap, spec.gapOne);
    const gapZero = closeEnough(gap, spec.gapZero);
    if (!pulseOne && !pulseZero) return null;
    if (!gapOne && !gapZero) {
      if (bitIndex !== spec.bits - 1 || spec.stopPulse || !hasNativeTail(intervals, endTick)) return null;
      finalBitCandidates = pulseOne && pulseZero ? [0, 1] : [pulseOne ? 1 : 0];
      bits[bitIndex] = finalBitCandidates[0]!;
      score += durationError(pulse, bits[bitIndex] ? spec.pulseOne : spec.pulseZero);
      endTick += pulse + gap;
      bitIndex++;
      cursor += 2;
      continue;
    }
    const oneError = durationError(pulse, spec.pulseOne) + durationError(gap, spec.gapOne);
    const zeroError = durationError(pulse, spec.pulseZero) + durationError(gap, spec.gapZero);
    bits[bitIndex] = oneError <= zeroError ? 1 : 0;
    score += Math.min(oneError, zeroError);
    cursor += 2;
    endTick += pulse + gap;
    bitIndex++;
  }
  if (!hasNativeTail(intervals, endTick)) return null;
  const stopPulse = spec.stopPulse || spec.pulseZero;
  if (spec.stopBit && !hasStopPulse(intervals, endTick, stopPulse)) return null;
  if (finalBitCandidates) {
    for (const candidate of finalBitCandidates) {
      bits[bits.length - 1] = candidate;
      const parsed = frameFromBits(spec, bits, endTick, score);
      if (parsed) return parsed;
    }
    return null;
  }
  return frameFromBits(spec, bits, endTick, score);
}

function activeAt(intervals: readonly Interval[], target: number): 0 | 1 | null {
  let cursor = 0;
  for (const interval of intervals) {
    const next = cursor + interval.ticks;
    if (target < next) return interval.active ? 1 : 0;
    cursor = next;
  }
  return null;
}

function activeRunEnd(intervals: readonly Interval[], target: number): number | null {
  let cursor = 0;
  for (const interval of intervals) {
    const next = cursor + interval.ticks;
    if (interval.active && cursor <= target && target < next) return next;
    cursor = next;
  }
  return null;
}

function hasStopPulse(intervals: readonly Interval[], endTick: number, ticks: number): boolean {
  const end = activeRunEnd(intervals, endTick + 0.25);
  return end !== null && closeEnough(end - endTick, ticks);
}

function hasNativeTail(intervals: readonly Interval[], endTick: number): boolean {
  let cursor = 0;
  let activeRuns = 0;
  for (const interval of intervals) {
    const start = cursor;
    const end = cursor + interval.ticks;
    cursor = end;
    if (interval.active && end > endTick + 0.5 && start >= endTick - 0.5) activeRuns++;
  }
  return activeRuns <= 1;
}

function tryManchester(spec: IrmpProtocolSpec, intervals: readonly Interval[]): ParsedFrame | null {
  if (intervals.length < 2) return null;
  const nominalHeader = closeEnough(intervals[0]!.ticks, spec.headerPulse);
  const extendedHeader =
    (spec.id === 7 || spec.id === 45) &&
    closeEnough(intervals[0]!.ticks, spec.headerPulse * 2) &&
    intervals[1]!.ticks >= spec.headerGap;
  if (!nominalHeader && !extendedHeader) return null;
  const dataStart = intervals[0]!.ticks + (extendedHeader ? spec.headerGap * 2 : spec.headerGap);
  if (activeAt(intervals, dataStart - 0.25) !== 0) return null;
  let cursor = 0;
  let half = Number.POSITIVE_INFINITY;
  for (const interval of intervals) {
    const start = cursor;
    cursor += interval.ticks;
    if (start >= dataStart && interval.ticks > 0 && interval.ticks < IRMP_FRAME_GAP_TICKS) {
      half = Math.min(half, interval.ticks);
    }
  }
  if (!Number.isFinite(half) || half < 1) return null;
  const bits = new Array<number>(spec.bits).fill(0);
  const score = extendedHeader ? 0 : durationError(intervals[0]!.ticks, spec.headerPulse);
  for (let index = 0; index < spec.bits; index++) {
    const first = activeAt(intervals, dataStart + (index * 2 + 0.5) * half);
    const second = activeAt(intervals, dataStart + (index * 2 + 1.5) * half);
    if (first === null || second === null || first === second) return null;
    bits[index] = first;
  }
  const endTick = dataStart + spec.bits * 2 * half;
  if (!hasNativeTail(intervals, endTick)) return null;
  const parsed = frameFromBits(spec, bits, endTick, score);
  if (parsed && extendedHeader && (spec.id === 7 || spec.id === 45)) {
    return {
      ...parsed,
      frame: { ...parsed.frame, command: parsed.frame.command | 0x40 },
    };
  }
  return parsed;
}

function trySircs(spec: IrmpProtocolSpec, intervals: readonly Interval[]): ParsedFrame | null {
  if (spec.id !== 1 || intervals.length < 4) return null;
  if (!intervals[0]!.active || !closeEnough(intervals[0]!.ticks, spec.headerPulse)) return null;
  if (intervals[1]!.active || !closeEnough(intervals[1]!.ticks, spec.headerGap)) return null;
  const bits: number[] = [];
  let score = durationError(intervals[0]!.ticks, spec.headerPulse) + durationError(intervals[1]!.ticks, spec.headerGap);
  let endTick = intervals[0]!.ticks + intervals[1]!.ticks;
  let cursor = 2;
  while (bits.length < 20 && cursor + 1 < intervals.length) {
    const pulse = intervals[cursor]!;
    const gap = intervals[cursor + 1]!;
    if (!pulse.active || gap.active) break;
    const hasNextPulse = intervals.slice(cursor + 2).some((interval) => interval.active);
    const zeroGap = closeEnough(gap.ticks, spec.gapZero) || !hasNextPulse;
    const oneGap = closeEnough(gap.ticks, spec.gapOne) || !hasNextPulse;
    const zero = closeEnough(pulse.ticks, spec.pulseZero) && zeroGap;
    const one = closeEnough(pulse.ticks, spec.pulseOne) && oneGap;
    if (!zero && !one) break;
    bits.push(one && !zero ? 1 : 0);
    score += Math.min(durationError(pulse.ticks, spec.pulseZero), durationError(pulse.ticks, spec.pulseOne));
    endTick += pulse.ticks + gap.ticks;
    cursor += 2;
  }
  if (bits.length < 12 || !hasNativeTail(intervals, endTick)) return null;
  return {
    frame: {
      protocol: 1,
      address: (bits.length - 11) << 8,
      command: readField(bits, 0, Math.min(15, bits.length), true),
    },
    endTick,
    score,
  };
}

function tryNetbox(spec: IrmpProtocolSpec, intervals: readonly Interval[]): ParsedFrame | null {
  if (spec.id !== 26 || intervals.length < 2) return null;
  if (!intervals[0]!.active || !closeEnough(intervals[0]!.ticks, spec.headerPulse)) return null;
  if (intervals[1]!.active || !closeEnough(intervals[1]!.ticks, spec.headerGap)) return null;
  const dataStart = spec.headerPulse + spec.headerGap;
  const slot = tick(800);
  const bits = new Array<number>(spec.bits).fill(0);
  for (let index = 0; index < bits.length; index++) {
    const level = activeAt(intervals, dataStart + (index + 0.5) * slot);
    if (level === null) return null;
    bits[index] = level;
  }
  const endTick = dataStart + bits.length * slot;
  if (!hasNativeTail(intervals, endTick)) return null;
  return frameFromBits(spec, bits, endTick, durationError(intervals[0]!.ticks, spec.headerPulse));
}

function tryRcmm(spec: IrmpProtocolSpec, intervals: readonly Interval[]): ParsedFrame | null {
  if (intervals.length < 2) return null;
  if (!closeEnough(intervals[0]!.ticks, spec.headerPulse)) return null;
  if (!closeEnough(intervals[1]!.ticks, spec.headerGap)) return null;
  const bits = new Array<number>(spec.bits).fill(0);
  let score = durationError(intervals[0]!.ticks, spec.headerPulse);
  score += durationError(intervals[1]!.ticks, spec.headerGap);
  let cursor = 2;
  let endTick = intervals[0]!.ticks + intervals[1]!.ticks;
  for (let symbol = 0; symbol < spec.bits / 2; symbol++) {
    const pulseInterval = intervals[cursor];
    const gapInterval = intervals[cursor + 1];
    if (!pulseInterval || !gapInterval || !pulseInterval.active || gapInterval.active) return null;
    if (!closeEnough(pulseInterval.ticks, spec.rcmmPulse)) return null;
    let code = 0;
    let error = Number.POSITIVE_INFINITY;
    spec.rcmmGaps.forEach((gap, index) => {
      const candidate = durationError(gapInterval.ticks, gap);
      if (candidate < error) {
        error = candidate;
        code = index;
      }
    });
    if (!closeEnough(gapInterval.ticks, spec.rcmmGaps[code]!)) return null;
    score += error;
    bits[symbol * 2] = (code >> 1) & 1;
    bits[symbol * 2 + 1] = code & 1;
    cursor += 2;
    endTick += pulseInterval.ticks + gapInterval.ticks;
  }
  if (!hasNativeTail(intervals, endTick)) return null;
  if (spec.stopBit && !hasStopPulse(intervals, endTick, spec.rcmmPulse)) return null;
  return frameFromBits(spec, bits, endTick, score);
}

function parseFrame(intervals: readonly Interval[]): ParsedFrame | null {
  if (!intervals.length || !intervals[0]!.active) return null;
  let best: ParsedFrame | null = null;
  for (const spec of IRMP_PROTOCOLS) {
    const parsed =
      spec.id === 1
        ? trySircs(spec, intervals)
        : spec.id === 26
          ? tryNetbox(spec, intervals)
          : spec.family === 'pulse-distance'
            ? tryPulseDistance(spec, intervals)
            : spec.family === 'manchester'
              ? tryManchester(spec, intervals)
              : tryRcmm(spec, intervals);
    if (
      parsed &&
      (!best || parsed.score < best.score || (parsed.score === best.score && parsed.endTick > best.endTick))
    )
      best = parsed;
  }
  return best;
}

function necRepeatWaveform(intervals: readonly Interval[]): boolean {
  if (intervals.length < 3 || intervals.length > 5) return false;
  const headerPulse = tick(9000);
  const repeatGap = tick(2250);
  const stopPulse = tick(560);
  if (!intervals[0]!.active || !closeEnough(intervals[0]!.ticks, headerPulse)) return false;
  if (intervals[1]!.active || !closeEnough(intervals[1]!.ticks, repeatGap)) return false;
  if (!intervals[2]!.active || !closeEnough(intervals[2]!.ticks, stopPulse)) return false;
  return intervals.slice(3).every((interval) => !interval.active);
}

function isNecFamily(protocol: number): boolean {
  return protocol === 2 || protocol === 11 || protocol === 20 || protocol === 56;
}

function lastActiveEndTick(intervals: readonly Interval[]): number | null {
  let cursor = 0;
  let end: number | null = null;
  for (const interval of intervals) {
    cursor += interval.ticks;
    if (interval.active) end = cursor;
  }
  return end;
}

function isNikonHeaderGap(intervals: readonly Interval[], gapTicks: number): boolean {
  if (intervals.length !== 1 || !intervals[0]!.active) return false;
  return closeEnough(intervals[0]!.ticks, getProtocolSpec(22).headerPulse) && gapTicks <= IRMP_NIKON_TIMEOUT_TICKS;
}

export class IrIrmpDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private rateFactor = 1;
  private activeHigh = false;
  private outAnn = -1;
  private intervals: Interval[] = [];
  private frameStart = 0n;
  private lastActive: 0 | 1 = 0;
  private lastSample = 0n;
  private lastSampleKnown = false;
  private lastFrame: IrmpFrame | null = null;
  private lastFrameEnd = 0n;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.intervals = [];
    this.frameStart = 0n;
    this.lastActive = 0;
    this.lastSample = 0n;
    this.lastSampleKnown = false;
    this.lastFrame = null;
    this.lastFrameEnd = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.rateFactor = value / IRMP_BASE_RATE;
    this.activeHigh = this.options.polarity === 'active-high';
  }

  private active(raw: number): 0 | 1 {
    return (raw !== 0) === this.activeHigh ? 1 : 0;
  }

  private finishFrame(gapTicks: number | null = null): void {
    if (!this.intervals.length) return;
    if (this.lastFrame && isNecFamily(this.lastFrame.protocol) && necRepeatWaveform(this.intervals)) {
      const gap = gapTicks ?? Number(this.frameStart - this.lastFrameEnd) / this.rateFactor;
      if (gap < IRMP_NEC_REPEAT_WINDOW_TICKS) {
        this.emitFrame(
          { ...this.lastFrame, repeat: true },
          lastActiveEndTick(this.intervals) ?? this.intervalEndTick(),
        );
      }
      this.intervals = [];
      return;
    }
    const parsed = parseFrame(this.intervals);
    if (parsed) {
      const repeat =
        this.lastFrame !== null &&
        this.lastFrame.protocol === parsed.frame.protocol &&
        this.lastFrame.address === parsed.frame.address &&
        this.lastFrame.command === parsed.frame.command &&
        (gapTicks ?? Number(this.frameStart - this.lastFrameEnd) / this.rateFactor) < IRMP_REPEAT_WINDOW_TICKS;
      this.emitFrame(
        repeat ? { ...parsed.frame, repeat: true } : parsed.frame,
        lastActiveEndTick(this.intervals) ?? this.intervalEndTick(),
      );
    }
    this.intervals = [];
  }

  private appendTrailingSpace(ticks: number): void {
    const dataGap = ticks - IRMP_TRAILING_GAP_TICKS;
    if (dataGap > 0) this.intervals.push({ active: false, ticks: dataGap });
  }

  private intervalEndTick(): number {
    let end = 0;
    for (const interval of this.intervals) end += interval.ticks;
    return Math.max(1, end);
  }

  private emitFrame(frame: IrmpFrame, ticks: number): void {
    const es = this.frameStart + BigInt(Math.round(ticks * this.rateFactor));
    this.put(this.frameStart, es, this.outAnn, [0, annotationTexts(frame)]);
    this.lastFrame = frame;
    this.lastFrameEnd = es;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    if (this.samplerate % IRMP_BASE_RATE)
      throw new Error(`Capture samplerate must be multiple of library samplerate (${IRMP_BASE_RATE})`);

    const pins = yield this.wait();
    this.lastActive = this.active(Number(pins[0]));
    this.lastSample = this.samplenum;
    this.lastSampleKnown = true;
    if (this.lastActive === 1) this.frameStart = this.samplenum;

    while (true) {
      const next = yield this.wait({ ir: 'e' });
      const sample = this.samplenum;
      const ticks = Math.max(1, Math.round(Number(sample - this.lastSample) / this.rateFactor));
      if (this.lastActive === 0 && ticks >= IRMP_FRAME_GAP_TICKS && !isNikonHeaderGap(this.intervals, ticks)) {
        if (this.intervals.length) this.appendTrailingSpace(ticks);
        this.finishFrame(ticks);
      } else if (this.intervals.length || this.lastActive === 1) {
        if (!this.intervals.length) this.frameStart = this.lastSample;
        this.intervals.push({ active: this.lastActive === 1, ticks });
      }
      this.lastActive = this.active(Number(next[0]));
      if (!this.intervals.length && this.lastActive === 1) this.frameStart = sample;
      this.lastSample = sample;
      this.lastSampleKnown = true;
    }
  }

  onEof(info: { sample: bigint }): void {
    if (!this.lastSampleKnown) return;
    const ticks = Math.max(1, Math.round(Number(info.sample - this.lastSample) / this.rateFactor));
    if (this.lastActive === 1) {
      if (!this.intervals.length) this.frameStart = this.lastSample;
      this.intervals.push({ active: true, ticks });
    } else if (this.intervals.length) {
      this.appendTrailingSpace(ticks);
    }
    this.finishFrame();
    this.lastSampleKnown = false;
  }
}

export default IrIrmpDecoder;
