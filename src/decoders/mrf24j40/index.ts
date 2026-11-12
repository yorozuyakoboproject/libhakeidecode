import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const RX = 0;
const TX = 1;

const SHORT_REGISTERS: Readonly<Record<number, string>> = {
  0x00: 'RXMCR',
  0x01: 'PANIDL',
  0x02: 'PANIDH',
  0x03: 'SADRL',
  0x04: 'SADRH',
  0x05: 'EADR0',
  0x06: 'EADR1',
  0x07: 'EADR2',
  0x08: 'EADR3',
  0x09: 'EADR4',
  0x0a: 'EADR5',
  0x0b: 'EADR6',
  0x0c: 'EADR7',
  0x0d: 'RXFLUSH',
  0x0e: 'Reserved',
  0x0f: 'Reserved',
  0x10: 'ORDER',
  0x11: 'TXMCR',
  0x12: 'ACKTMOUT',
  0x13: 'ESLOTG1',
  0x14: 'SYMTICKL',
  0x15: 'SYMTICKH',
  0x16: 'PACON0',
  0x17: 'PACON1',
  0x18: 'PACON2',
  0x19: 'Reserved',
  0x1a: 'TXBCON0',
  0x1b: 'TXNCON',
  0x1c: 'TXG1CON',
  0x1d: 'TXG2CON',
  0x1e: 'ESLOTG23',
  0x1f: 'ESLOTG45',
  0x20: 'ESLOTG67',
  0x21: 'TXPEND',
  0x22: 'WAKECON',
  0x23: 'FRMOFFSET',
  0x24: 'TXSTAT',
  0x25: 'TXBCON1',
  0x26: 'GATECLK',
  0x27: 'TXTIME',
  0x28: 'HSYMTIMRL',
  0x29: 'HSYMTIMRH',
  0x2a: 'SOFTRST',
  0x2b: 'Reserved',
  0x2c: 'SECCON0',
  0x2d: 'SECCON1',
  0x2e: 'TXSTBL',
  0x2f: 'Reserved',
  0x30: 'RXSR',
  0x31: 'INTSTAT',
  0x32: 'INTCON',
  0x33: 'GPIO',
  0x34: 'TRISGPIO',
  0x35: 'SLPACK',
  0x36: 'RFCTL',
  0x37: 'SECCR2',
  0x38: 'BBREG0',
  0x39: 'BBREG1',
  0x3a: 'BBREG2',
  0x3b: 'BBREG3',
  0x3c: 'BBREG4',
  0x3d: 'Reserved',
  0x3e: 'BBREG6',
  0x3f: 'CCAEDTH',
};

const LONG_REGISTERS: Readonly<Record<number, string>> = {
  0x200: 'RFCON0',
  0x201: 'RFCON1',
  0x202: 'RFCON2',
  0x203: 'RFCON3',
  0x204: 'Reserved',
  0x205: 'RFCON5',
  0x206: 'RFCON6',
  0x207: 'RFCON7',
  0x208: 'RFCON8',
  0x209: 'SLPCAL0',
  0x20a: 'SLPCAL1',
  0x20b: 'SLPCAL2',
  0x20c: 'Reserved',
  0x20d: 'Reserved',
  0x20e: 'Reserved',
  0x20f: 'RFSTATE',
  0x210: 'RSSI',
  0x211: 'SLPCON0',
  0x212: 'Reserved',
  0x213: 'Reserved',
  0x214: 'Reserved',
  0x215: 'Reserved',
  0x216: 'Reserved',
  0x217: 'Reserved',
  0x218: 'Reserved',
  0x219: 'Reserved',
  0x21a: 'Reserved',
  0x21b: 'Reserved',
  0x21c: 'Reserved',
  0x21d: 'Reserved',
  0x21e: 'Reserved',
  0x21f: 'Reserved',
  0x220: 'SLPCON1',
  0x221: 'Reserved',
  0x222: 'WAKETIMEL',
  0x223: 'WAKETIMEH',
  0x224: 'REMCNTL',
  0x225: 'REMCNTH',
  0x226: 'MAINCNT0',
  0x227: 'MAINCNT1',
  0x228: 'MAINCNT2',
  0x229: 'MAINCNT3',
  0x22a: 'Reserved',
  0x22b: 'Reserved',
  0x22c: 'Reserved',
  0x22d: 'Reserved',
  0x22e: 'Reserved',
  0x22f: 'TESTMODE',
  0x230: 'ASSOEADR0',
  0x231: 'ASSOEADR1',
  0x232: 'ASSOEADR2',
  0x233: 'ASSOEADR3',
  0x234: 'ASSOEADR4',
  0x235: 'ASSOEADR5',
  0x236: 'ASSOEADR6',
  0x237: 'ASSOEADR7',
  0x238: 'ASSOSADR0',
  0x239: 'ASSOSADR1',
  0x23a: 'Reserved',
  0x23b: 'Reserved',
  0x23c: 'Unimplemented',
  0x23d: 'Unimplemented',
  0x23e: 'Unimplemented',
  0x23f: 'Unimplemented',
  0x240: 'UPNONCE0',
  0x241: 'UPNONCE1',
  0x242: 'UPNONCE2',
  0x243: 'UPNONCE3',
  0x244: 'UPNONCE4',
  0x245: 'UPNONCE5',
  0x246: 'UPNONCE6',
  0x247: 'UPNONCE7',
  0x248: 'UPNONCE8',
  0x249: 'UPNONCE9',
  0x24a: 'UPNONCE10',
  0x24b: 'UPNONCE11',
  0x24c: 'UPNONCE12',
};

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

function byteWidth(value: number): number {
  if (value === 0) return 1;
  return Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function wordHex(value: number): string {
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

export class Mrf24j40Decoder extends Decoder {
  static descriptor = descriptor;

  private outAnn = -1;
  private mosi: WireByte[] = [];
  private miso: WireByte[] = [];
  private commandStart: bigint | null = null;
  private commandEnd: bigint | null = null;
  private frameStart: [bigint, bigint] = [0n, 0n];
  private frameEnd: [bigint, bigint] = [0n, 0n];
  private frameCache: [number[], number[]] = [[], []];
  private lastWordEnd: bigint | null = null;
  private lastWordSpan = 0n;

  override reset(): void {
    this.mosi = [];
    this.miso = [];
    this.commandStart = null;
    this.commandEnd = null;
    this.frameStart = [0n, 0n];
    this.frameEnd = [0n, 0n];
    this.frameCache = [[], []];
    this.lastWordEnd = null;
    this.lastWordSpan = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  onEof(): void {
    if (this.mosi.length === 1) this.warn(this.commandStart ?? 0n, this.lastWordEnd ?? this.samplenum, 'Misplaced CS!');
    this.resetBytes();
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private warn(ss: bigint, es: bigint, message: string): void {
    this.annotate(ss, es, 4, [message]);
  }

  private resetBytes(): void {
    this.mosi = [];
    this.miso = [];
    this.commandStart = null;
    this.commandEnd = null;
  }

  private flushFrames(shortWriteValue: number): void {
    for (const direction of [RX, TX]) {
      if (!this.frameCache[direction]!.length) continue;
      const bit0 = shortWriteValue & 1,
        register = (this.mosi[0]!.value >> 1) & 0x3f,
        registerName = SHORT_REGISTERS[register] ?? 'illegal';
      if (direction === TX && !(registerName === 'TXNCON' && bit0 === 1)) continue;
      if (direction === RX && !(registerName === 'RXFLUSH' && bit0 === 1)) continue;
      const label = direction === TX ? 'TX' : 'RX',
        bytes = this.frameCache[direction]!.map((value) => wordHex(value)).join(' ');
      this.annotate(this.frameStart[direction]!, this.frameEnd[direction]!, direction === TX ? 5 : 6, [
        `${label} frame: ${bytes}`,
      ]);
      this.frameCache[direction] = [];
    }
  }

  private handleShort(): void {
    const write = this.mosi[0]!.value & 1,
      register = (this.mosi[0]!.value >> 1) & 0x3f,
      registerName = SHORT_REGISTERS[register] ?? 'illegal',
      value = write ? this.mosi[1]!.value : this.miso[1]!.value;
    this.flushFrames(this.mosi[1]!.value);
    this.annotate(this.commandStart!, this.commandEnd!, write ? 1 : 0, [`${registerName}: ${hex(value)}`]);
    if (!write && registerName === 'TXSTAT') {
      const retries = (value & 0xc0) >> 6;
      if (retries > 0) {
        const failed = (value & 1) !== 0,
          index = 6 + retries + (failed ? 1 : 0);
        this.annotate(
          this.commandStart!,
          this.commandEnd!,
          index,
          failed ? ['TX fail (>= 4 retries)', 'TX fail'] : [`TX retries: ${retries}`],
        );
      }
      if (value & 0x20) this.annotate(this.commandStart!, this.commandEnd!, 11, ['CCAFAIL (channel busy)', 'CCAFAIL']);
    }
  }

  private longRegisterName(register: number): string {
    let name = `TX:${hex(register)}`;
    if (register >= 0x80) name = `TX beacon:${hex(register)}`;
    if (register >= 0x100) name = `TX GTS1:${hex(register)}`;
    if (register >= 0x180) name = `TX GTS2:${hex(register)}`;
    if (register >= 0x200) name = LONG_REGISTERS[register] ?? 'illegal';
    if (register >= 0x280) name = `Security keys:${hex(register)}`;
    if (register >= 0x2c0) name = `Reserved:${hex(register)}`;
    if (register >= 0x300) name = `RX:${hex(register)}`;
    return name;
  }

  private handleLong(): void {
    const value = (this.mosi[0]!.value << 8) | this.mosi[1]!.value,
      write = value & 0x10,
      register = (value >> 5) & 0x3ff,
      registerName = this.longRegisterName(register),
      data = write ? this.mosi[2]!.value : this.miso[2]!.value;
    this.annotate(this.commandStart!, this.commandEnd!, write ? 3 : 2, [`${registerName}: ${hex(data)}`]);
    for (const direction of [RX, TX]) {
      if (direction === RX && !registerName.startsWith('RX:')) continue;
      if (direction === TX && !registerName.startsWith('TX:')) continue;
      if (!this.frameCache[direction]!.length) this.frameStart[direction] = this.commandStart!;
      this.frameEnd[direction] = this.commandEnd!;
      this.frameCache[direction]!.push(data);
    }
  }

  private consumeByte(mosi: WireByte, miso: WireByte): void {
    if (!this.mosi.length) this.commandStart = mosi.ss;
    this.mosi.push(mosi);
    this.miso.push(miso);
    if (this.mosi.length < 2) return;
    if (this.mosi[0]!.value & 0x80) {
      if (this.mosi.length === 3) {
        this.commandEnd = mosi.es;
        this.handleLong();
        this.resetBytes();
      }
    } else {
      this.commandEnd = mosi.es;
      this.handleShort();
      this.resetBytes();
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING' && typeof data[1] === 'string') {
      if (data[1].startsWith('Chip select deasserted') && this.mosi.length === 1) {
        this.warn(this.commandStart ?? es, this.lastWordEnd ?? es, 'Misplaced CS!');
        this.resetBytes();
      }
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word || word.mosi === null || word.miso === null) return;
    if (this.mosi.length === 1 && this.lastWordEnd !== null && ss - this.lastWordEnd > this.lastWordSpan) {
      this.warn(this.commandStart ?? ss, this.lastWordEnd, 'Misplaced CS!');
      this.resetBytes();
    }
    const [mosi, miso] = splitWord(word);
    for (let index = 0; index < mosi.length; index++) this.consumeByte(mosi[index]!, miso[index]!);
    this.lastWordEnd = es;
    this.lastWordSpan = es > ss ? es - ss : 0n;
  }
}

export default Mrf24j40Decoder;
