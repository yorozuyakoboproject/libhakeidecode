import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const ST25_ANN = Object.freeze({
  READ: 0,
  WRITE: 1,
  READ_B: 2,
  WRITE_B: 3,
  READ_T: 4,
  WRITE_T: 5,
  CMD: 6,
  FIFO_WRITE: 7,
  FIFO_READ: 8,
  STATUS: 9,
  WARNING: 10,
});

const DIRECT_COMMANDS: Readonly<Record<number, string>> = {
  0xc0: 'SET_DEFAULT',
  0xc1: 'SET_DEFAULT',
  0xc2: 'STOP',
  0xc3: 'STOP',
  0xc4: 'TXCRC',
  0xc5: 'TXNOCRC',
  0xc6: 'TXREQA',
  0xc7: 'TXWUPA',
  0xc8: 'NFCINITFON',
  0xc9: 'NFCRESFON',
  0xcd: 'GOIDLE',
  0xce: 'GOHALT',
  0xd0: 'STOPRX',
  0xd1: 'STARRX',
  0xd2: 'SETAMSTATE',
  0xd3: 'MAMP',
  0xd5: 'RSTRXGAIN',
  0xd6: 'ADJREG',
  0xd8: 'CALDRVTIM',
  0xd9: 'MPHASE',
  0xda: 'CLRRSSI',
  0xdb: 'CLRFIFO',
  0xdc: 'TRMODE',
  0xdd: 'CALCAPA',
  0xde: 'MCAPA',
  0xdf: 'MPOWER',
  0xe0: 'STARGPTIM',
  0xe1: 'STARWTIM',
  0xe2: 'STARMSKTIM',
  0xe3: 'STARNRESPTIM',
  0xe4: 'STARPPON2TIM',
  0xe8: 'STOPNRESTIM',
  0xfa: 'RFU',
  0xfb: 'REGSPACEB',
  0xfc: 'TESTACCESS',
};

const SPACE_A: Readonly<Record<number, string>> = {
  0x00: 'IOCFG1',
  0x01: 'IOCFG2',
  0x02: 'OPCTRL',
  0x03: 'MODEDEF',
  0x04: 'BITRATE',
  0x05: 'TYPEA',
  0x06: 'TYPEB',
  0x07: 'TYPEBF',
  0x08: 'NFCIP1',
  0x09: 'STREAM',
  0x0a: 'AUX',
  0x0b: 'RXCFG1',
  0x0c: 'RXCFG2',
  0x0d: 'RXCFG3',
  0x0e: 'RXCFG4',
  0x0f: 'MSKRXTIM',
  0x10: 'NRESPTIM1',
  0x11: 'NRESPTIM2',
  0x12: 'TIMEMV',
  0x13: 'GPTIM1',
  0x14: 'GPTIM2',
  0x15: 'PPON2',
  0x16: 'MSKMAINIRQ',
  0x17: 'MSKTIMNFCIRQ',
  0x18: 'MSKERRWAKEIRQ',
  0x19: 'TARGIRQ',
  0x1a: 'MAINIRQ',
  0x1b: 'TIMNFCIRQ',
  0x1c: 'ERRWAKEIRQ',
  0x1d: 'TARGIRQ',
  0x1e: 'FIFOSTAT1',
  0x1f: 'FIFOSTAT2',
  0x20: 'COLLDISP',
  0x21: 'TARGDISP',
  0x22: 'NBTXB1',
  0x23: 'NBTXB2',
  0x24: 'BITRATEDET',
  0x25: 'ADCONVOUT',
  0x26: 'ANTTUNECTRL1',
  0x27: 'ANTTUNECTRL2',
  0x28: 'TXDRV',
  0x29: 'TARGMOD',
  0x2a: 'EXTFIELDON',
  0x2b: 'EXTFIELDOFF',
  0x2c: 'REGVDDCTRL',
  0x2d: 'RSSIDISP',
  0x2e: 'GAINSTATE',
  0x2f: 'CAPACTRL',
  0x30: 'CAPADISP',
  0x31: 'AUXDISP',
  0x32: 'WAKETIMCTRL',
  0x33: 'AMPCFG',
  0x34: 'AMPREF',
  0x35: 'AMPAAVGDISP',
  0x36: 'AMPDISP',
  0x37: 'PHASECFG',
  0x38: 'PHASEREF',
  0x39: 'PHASEAAVGDISP',
  0x3a: 'PHASEDISP',
  0x3b: 'CAPACFG',
  0x3c: 'CAPAREF',
  0x3d: 'CAPAAAVGDISP',
  0x3e: 'CAPADISP',
  0x3f: 'ICIDENT',
  0xa0: 'PT_memLoadA',
  0xa8: 'PT_memLoadF',
  0xac: 'PT_memLoadTSN',
  0xbf: 'PT_memRead',
};

const SPACE_B: Readonly<Record<number, string>> = {
  0x05: 'EMDSUPPRCONF',
  0x06: 'SUBCSTARTIM',
  0x0b: 'P2PRXCONF',
  0x0c: 'CORRCONF1',
  0x0d: 'CORRCONF2',
  0x0f: 'SQUELSHTIM',
  0x15: 'NFCGUARDTIM',
  0x28: 'AUXMODSET',
  0x29: 'TXDRVTIM',
  0x2a: 'RESAMMODE',
  0x2b: 'TXDRVTIMDISP',
  0x2c: 'REGDISP',
  0x30: 'OSHOOTCONF1',
  0x31: 'OSHOOTCONF2',
  0x32: 'USHOOTCONF1',
  0x33: 'USHOOTCONF2',
};

const TEST_SPACE: Readonly<Record<number, string>> = { 0x01: 'ANTSTOBS' };

type Command =
  | 'Write'
  | 'Read'
  | 'WriteB'
  | 'ReadB'
  | 'WriteT'
  | 'ReadT'
  | 'FIFOW'
  | 'FIFOR'
  | 'Cmd'
  | 'Space B'
  | 'TestAccess';

interface ByteSpan {
  readonly mosi: number;
  readonly miso: number;
  readonly ss: bigint;
  readonly es: bigint;
}

interface ParsedCommand {
  readonly cmd: Command;
  readonly dat: number;
  readonly min: number;
  readonly max: number;
}

type SPIWordPacket = ['WORD', number | null, number | null, boolean | null, number] | ['WARNING', string];

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function bytesOf(value: number): number[] {
  const bytes: number[] = [];
  do {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  } while (value > 0);
  return bytes;
}

export class St25r39xxSpiDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private requirementsMet = true;
  private first = true;
  private cmd: Command | null = null;
  private dat = 0;
  private min = 0;
  private max = 0;
  private bytes: ByteSpan[] = [];
  private ssBytes = -1n;
  private esBytes = -1n;
  private lastWordStart: bigint | null = null;
  private lastWordEnd: bigint | null = null;
  private warned = false;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.requirementsMet = true;
    this.lastWordStart = null;
    this.lastWordEnd = null;
    this.warned = false;
    this.next();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private next(): void {
    this.first = true;
    this.cmd = null;
    this.min = 0;
    this.max = 0;
    this.bytes = [];
    this.ssBytes = -1n;
    this.esBytes = -1n;
  }

  private warn(ss: bigint, es: bigint, message: string): void {
    this.put(ss, es, this.outAnn, [ST25_ANN.WARNING, [message]]);
  }

  private formatCommand(): string {
    if (this.cmd === 'Cmd') return `Cmd ${DIRECT_COMMANDS[this.dat] ?? 'Unknown direct command'}`;
    return this.cmd ?? '';
  }

  private parseCommand(byte: number): ParsedCommand | null {
    const address = byte & 0x3f;
    if (this.cmd === 'Space B') {
      if ((byte & 0xc0) === 0x00) return { cmd: 'WriteB', dat: address, min: 1, max: 99_999 };
      if ((byte & 0xc0) === 0x40) return { cmd: 'ReadB', dat: address, min: 1, max: 99_999 };
      return null;
    }
    if (this.cmd === 'TestAccess') {
      if ((byte & 0xc0) === 0x00) return { cmd: 'WriteT', dat: address, min: 1, max: 99_999 };
      if ((byte & 0xc0) === 0x40) return { cmd: 'ReadT', dat: address, min: 1, max: 99_999 };
      return null;
    }
    if (byte <= 0x7f) {
      if ((byte & 0xc0) === 0x00) return { cmd: 'Write', dat: address, min: 1, max: 99_999 };
      if ((byte & 0xc0) === 0x40) return { cmd: 'Read', dat: address, min: 1, max: 99_999 };
      return null;
    }
    if (byte === 0x80) return { cmd: 'FIFOW', dat: byte, min: 1, max: 99_999 };
    if (byte === 0xa0 || byte === 0xa8 || byte === 0xac) return { cmd: 'Write', dat: byte, min: 1, max: 99_999 };
    if (byte === 0xbf) return { cmd: 'Read', dat: byte, min: 1, max: 99_999 };
    if (byte === 0x9f) return { cmd: 'FIFOR', dat: byte, min: 1, max: 99_999 };
    if (byte >= 0x0c && byte <= 0xe8) return { cmd: 'Cmd', dat: byte, min: 0, max: 0 };
    if (byte === 0xfb) return { cmd: 'Space B', dat: byte, min: 0, max: 0 };
    if (byte === 0xfc) return { cmd: 'TestAccess', dat: byte, min: 0, max: 0 };
    return null;
  }

  private decodeCommand(ss: bigint, es: bigint, byte: number): void {
    const parsed = this.parseCommand(byte);
    if (!parsed) {
      this.warn(ss, es, 'Unknown command');
      return;
    }
    this.cmd = parsed.cmd;
    this.dat = parsed.dat;
    this.min = parsed.min;
    this.max = parsed.max;
    if (this.cmd === 'Cmd') {
      this.put(ss, es, this.outAnn, [ST25_ANN.CMD, [this.formatCommand()]]);
      this.next();
    } else if (this.cmd === 'Space B' || this.cmd === 'TestAccess') {
      this.first = true;
    } else {
      this.ssBytes = ss;
    }
  }

  private registerName(ann: number, address: number): string | null {
    if (ann === ST25_ANN.FIFO_READ || ann === ST25_ANN.FIFO_WRITE) return '';
    let table: Readonly<Record<number, string>> = SPACE_A;
    let kind = 'SpaceA';
    if (ann === ST25_ANN.READ_B || ann === ST25_ANN.WRITE_B) {
      table = SPACE_B;
      kind = 'SpaceB';
    } else if (ann === ST25_ANN.READ_T || ann === ST25_ANN.WRITE_T) {
      table = TEST_SPACE;
      kind = 'Test';
    }
    const name = table[address];
    if (!name) {
      this.warn(
        this.ssBytes >= 0n ? this.ssBytes : 0n,
        this.esBytes >= 0n ? this.esBytes : 0n,
        `Unknown register ${kind}`,
      );
      return null;
    }
    return `${name} (${hex(address)})`;
  }

  private finishCommand(ss: bigint, es: bigint): void {
    let ann: number = ST25_ANN.WARNING;
    let data: number[] = [];
    if (this.cmd === 'Write') {
      ann = ST25_ANN.WRITE;
      data = this.bytes.map((item) => item.mosi);
    } else if (this.cmd === 'Read') {
      ann = ST25_ANN.READ;
      data = this.bytes.map((item) => item.miso);
    } else if (this.cmd === 'WriteB') {
      ann = ST25_ANN.WRITE_B;
      data = this.bytes.map((item) => item.mosi);
    } else if (this.cmd === 'ReadB') {
      ann = ST25_ANN.READ_B;
      data = this.bytes.map((item) => item.miso);
    } else if (this.cmd === 'WriteT') {
      ann = ST25_ANN.WRITE_T;
      data = this.bytes.map((item) => item.mosi);
    } else if (this.cmd === 'ReadT') {
      ann = ST25_ANN.READ_T;
      data = this.bytes.map((item) => item.miso);
    } else if (this.cmd === 'FIFOW') {
      ann = ST25_ANN.FIFO_WRITE;
      data = this.bytes.map((item) => item.mosi);
    } else if (this.cmd === 'FIFOR') {
      ann = ST25_ANN.FIFO_READ;
      data = this.bytes.map((item) => item.miso);
    } else {
      return;
    }
    const address = this.cmd === 'Write' || this.cmd === 'Read' ? this.dat & 0x3f : this.dat;
    const name = this.registerName(ann, address);
    if (name === null) return;
    const payload = data.map(hex).join(' ');
    const label = `${this.formatCommand()}: ${name}`;
    const text =
      ann === ST25_ANN.FIFO_WRITE || ann === ST25_ANN.FIFO_READ ? `${label}${payload}` : `${label} = ${payload}`;
    this.put(ss, es, this.outAnn, [ann, [text]]);
  }

  private closePending(ss: bigint, es: bigint): void {
    if (!this.cmd) return;
    if (this.cmd === 'Cmd' || this.cmd === 'Space B' || this.cmd === 'TestAccess') {
      this.next();
      return;
    }
    if (this.bytes.length < this.min) this.warn(ss, es, 'Missing data bytes');
    else if (this.bytes.length) this.finishCommand(this.ssBytes, this.esBytes);
    this.next();
  }

  private processByte(ss: bigint, es: bigint, mosi: number, miso: number): void {
    if (this.first) {
      this.first = false;
      this.decodeCommand(ss, es, mosi);
      return;
    }
    if (!this.cmd || this.bytes.length >= this.max) {
      this.warn(ss, es, 'Excess byte');
      return;
    }
    if (this.ssBytes < 0n) this.ssBytes = ss;
    this.esBytes = es;
    this.bytes.push({ mosi, miso, ss, es });
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!this.requirementsMet) return;
    const packet = data as SPIWordPacket;
    if (packet[0] !== 'WORD') return;
    const [, mosi, miso, cs] = packet;
    if (mosi === null || miso === null) {
      if (!this.warned) this.warn(ss, es, 'Both MISO and MOSI pins are required.');
      this.warned = true;
      this.requirementsMet = false;
      return;
    }
    if (cs === null) {
      if (!this.warned) this.warn(ss, es, 'CS# pin required.');
      this.warned = true;
      this.requirementsMet = false;
      return;
    }
    if (!cs) {
      this.closePending(ss, es);
      this.lastWordStart = null;
      this.lastWordEnd = null;
      return;
    }
    if (this.lastWordStart !== null && this.lastWordEnd !== null) {
      const span = Number(this.lastWordEnd - this.lastWordStart);
      const gap = Number(ss - this.lastWordEnd);
      if (gap > Math.max(32, span * 4))
        this.closePending(this.ssBytes >= 0n ? this.ssBytes : ss, this.esBytes >= 0n ? this.esBytes : es);
    }
    const mosiBytes = bytesOf(mosi);
    const misoBytes = bytesOf(miso);
    const width = Math.max(mosiBytes.length, misoBytes.length);
    for (let index = 0; index < width; index++) {
      const mosiByte = mosiBytes[index] ?? 0;
      const misoByte = misoBytes[index] ?? 0;
      this.processByte(ss, es, mosiByte, misoByte);
      if (this.first && this.cmd !== 'Space B' && this.cmd !== 'TestAccess') break;
    }
    this.lastWordStart = ss;
    this.lastWordEnd = es;
  }

  onEof(): void {
    if (this.requirementsMet && this.cmd) this.closePending(this.ssBytes >= 0n ? this.ssBytes : 0n, this.samplenum);
  }
}

export default St25r39xxSpiDecoder;
