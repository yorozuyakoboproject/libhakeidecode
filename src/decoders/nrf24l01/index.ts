import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const ANN = Object.freeze({ CMD: 0, TX: 1, REG: 2, RX: 3, WARN: 4 });

const REGISTERS: Readonly<Record<number, readonly [string, number]>> = {
  0x00: ['CONFIG', 1],
  0x01: ['EN_AA', 1],
  0x02: ['EN_RXADDR', 1],
  0x03: ['SETUP_AW', 1],
  0x04: ['SETUP_RETR', 1],
  0x05: ['RF_CH', 1],
  0x06: ['RF_SETUP', 1],
  0x07: ['STATUS', 1],
  0x08: ['OBSERVE_TX', 1],
  0x09: ['RPD', 1],
  0x0a: ['RX_ADDR_P0', 5],
  0x0b: ['RX_ADDR_P1', 5],
  0x0c: ['RX_ADDR_P2', 1],
  0x0d: ['RX_ADDR_P3', 1],
  0x0e: ['RX_ADDR_P4', 1],
  0x0f: ['RX_ADDR_P5', 1],
  0x10: ['TX_ADDR', 5],
  0x11: ['RX_PW_P0', 1],
  0x12: ['RX_PW_P1', 1],
  0x13: ['RX_PW_P2', 1],
  0x14: ['RX_PW_P3', 1],
  0x15: ['RX_PW_P4', 1],
  0x16: ['RX_PW_P5', 1],
  0x17: ['FIFO_STATUS', 1],
  0x1c: ['DYNPD', 1],
  0x1d: ['FEATURE', 1],
};

const XN297_REGISTERS: Readonly<Record<number, readonly [string, number]>> = {
  0x19: ['DEMOD_CAL', 5],
  0x1e: ['RF_CAL', 7],
  0x1f: ['BB_CAL', 5],
};

interface Nrf24l01Options {
  chip: string;
}

interface SPIWord {
  readonly ss: bigint;
  readonly es: bigint;
  readonly mosi: number | null;
  readonly miso: number | null;
  readonly cs: boolean | null;
}

interface WireByte {
  readonly value: number;
  readonly ss: bigint;
  readonly es: bigint;
}

interface Command {
  readonly name: string;
  readonly dat: number | null;
  readonly min: number;
  readonly max: number;
}

function byteWidth(value: number): number {
  if (value === 0) return 1;
  return Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function spiWord(ss: bigint, es: bigint, data: unknown): SPIWord | null {
  if (!Array.isArray(data) || data.length !== 5 || data[0] !== 'WORD') return null;
  const mosi = data[1],
    miso = data[2],
    cs = data[3];
  for (const value of [mosi, miso])
    if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) return null;
  if (cs !== null && typeof cs !== 'boolean') return null;
  return { ss, es, mosi, miso, cs };
}

function splitWord(word: SPIWord): [WireByte[], WireByte[]] {
  const count = Math.max(byteWidth(word.mosi ?? 0), byteWidth(word.miso ?? 0), 1),
    span = word.es - word.ss,
    mosi: WireByte[] = [],
    miso: WireByte[] = [];
  for (let index = 0; index < count; index++) {
    const ss = word.ss + (span * BigInt(index)) / BigInt(count),
      es = word.ss + (span * BigInt(index + 1)) / BigInt(count),
      shift = 8 * (count - index - 1);
    mosi.push({ value: word.mosi === null ? 0 : Math.floor(word.mosi / 2 ** shift) & 0xff, ss, es });
    miso.push({ value: word.miso === null ? 0 : Math.floor(word.miso / 2 ** shift) & 0xff, ss, es });
  }
  return [mosi, miso];
}

function printableByte(value: number): boolean {
  return /^[\x20-\x7e\xa1-\xac\xae-\xff]$/.test(String.fromCharCode(value));
}

export class Nrf24l01Decoder extends Decoder<Nrf24l01Options> {
  static descriptor = descriptor;

  private outAnn = -1;
  private active = false;
  private first = true;
  private command: Command | null = null;
  private commandStart: bigint | null = null;
  private multiStart: bigint | null = null;
  private multiEnd: bigint | null = null;
  private data: { mosi: number; miso: number; ss: bigint; es: bigint }[] = [];
  private lastWordEnd: bigint | null = null;
  private lastWordSpan = 0n;

  override reset(): void {
    this.active = false;
    this.first = true;
    this.command = null;
    this.commandStart = null;
    this.multiStart = null;
    this.multiEnd = null;
    this.data = [];
    this.lastWordEnd = null;
    this.lastWordSpan = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  onEof(): void {
    if (this.active) this.finishCommand(this.lastWordEnd ?? this.samplenum);
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private warn(ss: bigint, es: bigint, message: string): void {
    this.annotate(ss, es, ANN.WARN, [message]);
  }

  private registerInfo(reg: number): readonly [string, number] | undefined {
    if (this.options.chip === 'xn297') return XN297_REGISTERS[reg] ?? REGISTERS[reg];
    return REGISTERS[reg];
  }

  private parseCommand(value: number): Command | null {
    const group = value & 0xe0;
    if (group === 0x00 || group === 0x20) {
      const name = group ? 'W_REGISTER' : 'R_REGISTER',
        dat = value & 0x1f,
        size = this.registerInfo(dat)?.[1] ?? 1;
      return { name, dat, min: 1, max: size };
    }
    switch (value) {
      case 0x50:
        return { name: 'ACTIVATE', dat: null, min: 1, max: 1 };
      case 0x61:
        return { name: 'R_RX_PAYLOAD', dat: null, min: 1, max: 32 };
      case 0x60:
        return { name: 'R_RX_PL_WID', dat: null, min: 1, max: 1 };
      case 0xa0:
        return { name: 'W_TX_PAYLOAD', dat: null, min: 1, max: 32 };
      case 0xb0:
        return { name: 'W_TX_PAYLOAD_NOACK', dat: null, min: 1, max: 32 };
      case 0xe1:
        return { name: 'FLUSH_TX', dat: null, min: 0, max: 0 };
      case 0xe2:
        return { name: 'FLUSH_RX', dat: null, min: 0, max: 0 };
      case 0xe3:
        return { name: 'REUSE_TX_PL', dat: null, min: 0, max: 0 };
      case 0xff:
        return { name: 'NOP', dat: null, min: 0, max: 0 };
      default:
        if ((value & 0xf8) === 0xa8) return { name: 'W_ACK_PAYLOAD', dat: value & 7, min: 1, max: 32 };
        return null;
    }
  }

  private formatCommand(): string {
    const command = this.command;
    if (!command) return 'Cmd None';
    if (command.name === 'R_REGISTER') {
      const name =
        command.dat === null ? 'unknown register' : (this.registerInfo(command.dat)?.[0] ?? 'unknown register');
      return `Cmd R_REGISTER "${name}"`;
    }
    return `Cmd ${command.name}`;
  }

  private decodeMulti(
    ss: bigint,
    es: bigint,
    classIndex: number,
    values: readonly number[],
    label: string,
    alwaysHex: boolean,
  ): void {
    const data = values
      .map((value) => (alwaysHex ? hex(value) : printableByte(value) ? String.fromCharCode(value) : `\\x${hex(value)}`))
      .join('');
    this.annotate(ss, es, classIndex, [`${label} = "${data}"`]);
  }

  private decodeRegister(
    ss: bigint,
    es: bigint,
    classIndex: number,
    registerId: number | string,
    values: readonly number[],
  ): void {
    let name: string;
    if (typeof registerId === 'number') {
      name = this.registerInfo(registerId)?.[0] ?? '';
      if (!name) {
        this.warn(ss, es, 'unknown register');
        return;
      }
    } else name = registerId;
    const ordered = [...values].reverse(),
      label =
        this.command?.name === 'W_REGISTER' && classIndex === ANN.CMD
          ? `${this.formatCommand()}: ${name}`
          : `Reg ${name}`;
    this.decodeMulti(ss, es, classIndex, ordered, label, true);
  }

  private finishCommand(end: bigint): void {
    const command = this.command;
    if (command) {
      if (this.data.length < command.min) this.warn(end, end, 'missing data bytes');
      else if (this.data.length) {
        const ss = this.multiStart ?? this.commandStart ?? end,
          es = this.multiEnd ?? end,
          mosi = this.data.map((byte) => byte.mosi),
          miso = this.data.map((byte) => byte.miso);
        if (command.name === 'R_REGISTER') this.decodeRegister(ss, es, ANN.REG, command.dat!, miso);
        else if (command.name === 'W_REGISTER') this.decodeRegister(ss, es, ANN.CMD, command.dat!, mosi);
        else if (command.name === 'R_RX_PAYLOAD') this.decodeMulti(ss, es, ANN.RX, miso, 'RX payload', false);
        else if (command.name === 'W_TX_PAYLOAD' || command.name === 'W_TX_PAYLOAD_NOACK')
          this.decodeMulti(ss, es, ANN.TX, mosi, 'TX payload', false);
        else if (command.name === 'W_ACK_PAYLOAD')
          this.decodeMulti(ss, es, ANN.TX, mosi, `ACK payload for pipe ${command.dat}`, false);
        else if (command.name === 'R_RX_PL_WID')
          this.annotate(ss, es, ANN.REG, [`Payload width = ${this.data[0]!.miso}`]);
        else if (command.name === 'ACTIVATE') {
          this.annotate(ss, es, ANN.CMD, [this.formatCommand()]);
          if (this.data[0]!.mosi !== 0x73) this.warn(ss, es, 'wrong data for "ACTIVATE" command');
        }
      }
    }
    this.active = false;
    this.first = true;
    this.command = null;
    this.commandStart = null;
    this.multiStart = null;
    this.multiEnd = null;
    this.data = [];
  }

  private consumeByte(mosi: WireByte, miso: WireByte): void {
    if (!this.active) {
      this.active = true;
      this.first = true;
    }
    if (this.first) {
      this.first = false;
      this.commandStart = mosi.ss;
      this.command = this.parseCommand(mosi.value);
      if (!this.command) this.warn(mosi.ss, mosi.es, 'unknown command');
      else if (this.command.name === 'W_REGISTER' || this.command.name === 'ACTIVATE') this.multiStart = mosi.ss;
      else this.annotate(mosi.ss, mosi.es, ANN.CMD, [this.formatCommand()]);
      this.decodeRegister(mosi.ss, mosi.es, ANN.REG, 'STATUS', [miso.value]);
      return;
    }
    if (!this.command || this.data.length >= this.command.max) {
      this.warn(mosi.ss, mosi.es, 'excess byte');
      return;
    }
    if (this.multiStart === null) this.multiStart = mosi.ss;
    this.multiEnd = miso.es;
    this.data.push({ mosi: mosi.value, miso: miso.value, ss: mosi.ss, es: miso.es });
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING' && typeof data[1] === 'string') {
      if (data[1].startsWith('Chip select deasserted') && this.active) this.finishCommand(this.lastWordEnd ?? es);
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word || word.mosi === null || word.miso === null) return;
    if (this.active && this.lastWordEnd !== null && ss - this.lastWordEnd > this.lastWordSpan)
      this.finishCommand(this.lastWordEnd);
    if (word.cs === false) {
      if (this.active) this.finishCommand(es);
      this.lastWordEnd = es;
      this.lastWordSpan = es > ss ? es - ss : 0n;
      return;
    }
    const [mosi, miso] = splitWord(word);
    for (let index = 0; index < mosi.length; index++) this.consumeByte(mosi[index]!, miso[index]!);
    this.lastWordEnd = es;
    this.lastWordSpan = es > ss ? es - ss : 0n;
  }
}

export default Nrf24l01Decoder;
