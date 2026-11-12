import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const ANN = Object.freeze({
  STROBE: 0,
  SINGLE_READ: 1,
  SINGLE_WRITE: 2,
  BURST_READ: 3,
  BURST_WRITE: 4,
  STATUS_READ: 5,
  STATUS: 6,
  WARN: 7,
});

const REGISTERS: Readonly<Record<number, string>> = {
  0x00: 'IOCFG2',
  0x01: 'IOCFG1',
  0x02: 'IOCFG0',
  0x03: 'FIFOTHR',
  0x04: 'SYNC1',
  0x05: 'SYNC0',
  0x06: 'PKTLEN',
  0x07: 'PKTCTRL1',
  0x08: 'PKTCTRL0',
  0x09: 'ADDR',
  0x0a: 'CHANNR',
  0x0b: 'FSCTRL1',
  0x0c: 'FSCTRL0',
  0x0d: 'FREQ2',
  0x0e: 'FREQ1',
  0x0f: 'FREQ0',
  0x10: 'MDMCFG4',
  0x11: 'MDMCFG3',
  0x12: 'MDMCFG2',
  0x13: 'MDMCFG1',
  0x14: 'MDMCFG0',
  0x15: 'DEVIATN',
  0x16: 'MCSM2',
  0x17: 'MCSM1',
  0x18: 'MCSM0',
  0x19: 'FOCCFG',
  0x1a: 'BSCFG',
  0x1b: 'AGCTRL2',
  0x1c: 'AGCTRL1',
  0x1d: 'AGCTRL0',
  0x1e: 'WOREVT1',
  0x1f: 'WOREVT0',
  0x20: 'WORCTRL',
  0x21: 'FREND1',
  0x22: 'FREND0',
  0x23: 'FSCAL3',
  0x24: 'FSCAL2',
  0x25: 'FSCAL1',
  0x26: 'FSCAL0',
  0x27: 'RCCTRL1',
  0x28: 'RCCTRL0',
  0x29: 'FSTEST',
  0x2a: 'PTEST',
  0x2b: 'AGCTEST',
  0x2c: 'TEST2',
  0x2d: 'TEST1',
  0x2e: 'TEST0',
  0x30: 'PARTNUM',
  0x31: 'VERSION',
  0x32: 'FREQEST',
  0x33: 'LQI',
  0x34: 'RSSI',
  0x35: 'MARCSTATE',
  0x36: 'WORTIME1',
  0x37: 'WORTIME0',
  0x38: 'PKTSTATUS',
  0x39: 'VCO_VC_DAC',
  0x3a: 'TXBYTES',
  0x3b: 'RXBYTES',
  0x3c: 'RCCTRL1_STATUS',
  0x3d: 'RCCTRL0_STATUS',
  0x3e: 'PATABLE',
  0x3f: 'FIFO',
};

const STROBES: Readonly<Record<number, string>> = {
  0x30: 'SRES',
  0x31: 'SFSTXON',
  0x32: 'SXOFF',
  0x33: 'SCAL',
  0x34: 'SRX',
  0x35: 'STX',
  0x36: 'SIDLE',
  0x37: '',
  0x38: 'SWOR',
  0x39: 'SPWD',
  0x3a: 'SFRX',
  0x3b: 'SFTX',
  0x3c: 'SWORRST',
  0x3d: 'SNOP',
};

const STATES = ['IDLE', 'RX', 'TX', 'FSTXON', 'CALIBRATE', 'SETTLING', 'RXFIFO_OVERFLOW', 'TXFIFO_OVERFLOW'];

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
  readonly dat: number;
  readonly min: number;
  readonly max: number;
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function byteWidth(value: number): number {
  if (value === 0) return 1;
  return Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
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

export class Cc1101Decoder extends Decoder {
  static descriptor = descriptor;

  private outAnn = -1;
  private active = false;
  private first = true;
  private command: Command | null = null;
  private commandStart: bigint | null = null;
  private dataEnd: bigint | null = null;
  private data: { mosi: number; miso: number }[] = [];
  private lastWordEnd: bigint | null = null;
  private lastWordSpan = 0n;

  override reset(): void {
    this.active = false;
    this.first = true;
    this.command = null;
    this.commandStart = null;
    this.dataEnd = null;
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

  private parseCommand(value: number): Command | null {
    const address = value & 0x3f;
    if (address < 0x30 || address === 0x3e || address === 0x3f) {
      if ((value & 0xc0) === 0x00) return { name: 'Write', dat: address, min: 1, max: 1 };
      if ((value & 0xc0) === 0x40) return { name: 'Burst write', dat: address, min: 1, max: 99_999 };
      if ((value & 0xc0) === 0x80) return { name: 'Read', dat: address, min: 1, max: 1 };
      return { name: 'Burst read', dat: address, min: 1, max: 99_999 };
    }
    if ((value & 0xc0) === 0x00) return { name: 'Strobe', dat: address, min: 0, max: 0 };
    if ((value & 0xc0) === 0x80) return { name: 'Read', dat: address, min: 1, max: 1 };
    if ((value & 0xc0) === 0xc0) return { name: 'Status read', dat: address, min: 1, max: 99_999 };
    return null;
  }

  private formatCommand(): string {
    const command = this.command;
    if (!command) return 'Cmd None';
    if (['Read', 'Burst read', 'Write', 'Burst write', 'Status read'].includes(command.name)) return command.name;
    if (command.name === 'Strobe') return `${command.name} ${STROBES[command.dat] ?? 'unknown strobe'}`;
    return `Cmd ${command.name}`;
  }

  private decodeStatus(ss: bigint, es: bigint, status: number): void {
    const chipReady = status & 0x80 ? 'CHIP_RDYn is high! ' : '',
      state = STATES[(status & 0x70) >> 4] ?? 'unknown',
      fifo = status & 0x0f,
      fifoText =
        this.command && ['Single read', 'Status read', 'Burst read'].includes(this.command.name)
          ? `${fifo} bytes available in RX FIFO`
          : `${fifo} bytes free in TX FIFO`,
      text = `Status = ${hex(status)}`;
    this.annotate(ss, es, ANN.STATUS, [text + '; ' + chipReady + `STATE is ${state}, ` + fifoText, text]);
  }

  private decodeRegister(
    ss: bigint,
    es: bigint,
    annotation: number,
    registerId: number | string,
    values: readonly number[],
  ): void {
    let name: string;
    if (typeof registerId === 'number') {
      name = REGISTERS[registerId];
      if (!name) {
        this.warn(ss, es, 'unknown register');
        return;
      }
      name = `${name} (${hex(registerId)})`;
    } else name = registerId;

    if (registerId === 'STATUS' && annotation === ANN.STATUS) {
      this.decodeStatus(ss, es, values[0] ?? 0);
      return;
    }

    let label: string;
    if (this.command && ['Write', 'Read', 'Status read', 'Burst read', 'Burst write'].includes(this.command.name))
      label = `${this.formatCommand()}: ${name}`;
    else label = `Reg (${this.command?.name ?? 'None'}) ${name}`;
    this.annotate(ss, es, annotation, [`${label} = ${values.map(hex).join(' ')}`]);
  }

  private finishCommand(end: bigint): void {
    const command = this.command;
    if (command) {
      if (this.data.length < command.min) this.warn(end, end, 'missing data bytes');
      else if (this.data.length) {
        const ss = this.commandStart ?? end,
          es = this.dataEnd ?? end,
          mosi = this.data.map((byte) => byte.mosi),
          miso = this.data.map((byte) => byte.miso);
        if (command.name === 'Write') this.decodeRegister(ss, es, ANN.SINGLE_WRITE, command.dat, mosi);
        else if (command.name === 'Burst write') this.decodeRegister(ss, es, ANN.BURST_WRITE, command.dat, mosi);
        else if (command.name === 'Read') this.decodeRegister(ss, es, ANN.SINGLE_READ, command.dat, miso);
        else if (command.name === 'Burst read') this.decodeRegister(ss, es, ANN.BURST_READ, command.dat, miso);
        else if (command.name === 'Status read') this.decodeRegister(ss, es, ANN.STATUS_READ, command.dat, miso);
      }
    }
    this.active = false;
    this.first = true;
    this.command = null;
    this.commandStart = null;
    this.dataEnd = null;
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
      else if (this.command.name === 'Strobe') this.annotate(mosi.ss, mosi.es, ANN.STROBE, [this.formatCommand()]);
      this.decodeStatus(mosi.ss, mosi.es, miso.value);
      return;
    }
    if (!this.command || this.data.length >= this.command.max) {
      this.warn(mosi.ss, mosi.es, 'excess byte');
      return;
    }
    this.data.push({ mosi: mosi.value, miso: miso.value });
    this.dataEnd = miso.es;
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING' && typeof data[1] === 'string') {
      if (data[1].startsWith('Chip select deasserted') && this.active) this.finishCommand(es);
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

export default Cc1101Decoder;
