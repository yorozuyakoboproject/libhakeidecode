import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const ANN = Object.freeze({
  RCR: 0,
  RBM: 1,
  WCR: 2,
  WBM: 3,
  BFS: 4,
  BFC: 5,
  SRC: 6,
  DATA: 7,
  REG_ADDR: 8,
  WARNING: 9,
});

const REGS: readonly (readonly string[])[] = [
  [
    'ERDPTL',
    'ERDPTH',
    'EWRPTL',
    'EWRPTH',
    'ETXSTL',
    'ETXSTH',
    'ETXNDL',
    'ETXNDH',
    'ERXSTL',
    'ERXSTH',
    'ERXNDL',
    'ERXNDH',
    'ERXRDPTL',
    'ERXRDPTH',
    'ERXWRPTL',
    'ERXWRPTH',
    'EDMASTL',
    'EDMASTH',
    'EDMANDL',
    'EDMANDH',
    'EDMADSTL',
    'EDMADSTH',
    'EDMACSL',
    'EDMACSH',
    '\u2014',
    '\u2014',
    'Reserved',
    'EIE',
    'EIR',
    'ESTAT',
    'ECON2',
    'ECON1',
  ],
  [
    'EHT0',
    'EHT1',
    'EHT2',
    'EHT3',
    'EHT4',
    'EHT5',
    'EHT6',
    'EHT7',
    'EPMM0',
    'EPMM1',
    'EPMM2',
    'EPMM3',
    'EPMM4',
    'EPMM5',
    'EPMM6',
    'EPMM7',
    'EPMCSL',
    'EPMCSH',
    '\u2014',
    '\u2014',
    'EPMOL',
    'EPMOH',
    'Reserved',
    'Reserved',
    'ERXFCON',
    'EPKTCNT',
    'Reserved',
    'EIE',
    'EIR',
    'ESTAT',
    'ECON2',
    'ECON1',
  ],
  [
    'MACON1',
    'Reserved',
    'MACON3',
    'MACON4',
    'MABBIPG',
    '\u2014',
    'MAIPGL',
    'MAIPGH',
    'MACLCON1',
    'MACLCON2',
    'MAMXFLL',
    'MAMXFLH',
    'Reserved',
    'Reserved',
    'Reserved',
    '\u2014',
    'Reserved',
    'Reserved',
    'MICMD',
    '\u2014',
    'MIREGADR',
    'Reserved',
    'MIWRL',
    'MIWRH',
    'MIRDL',
    'MIRDH',
    'Reserved',
    'EIE',
    'EIR',
    'ESTAT',
    'ECON2',
    'ECON1',
  ],
  [
    'MAADR5',
    'MAADR6',
    'MAADR3',
    'MAADR4',
    'MAADR1',
    'MAADR2',
    'EBSTSD',
    'EBSTCON',
    'EBSTCSL',
    'EBSTCSH',
    'MISTAT',
    '\u2014',
    '\u2014',
    '\u2014',
    '\u2014',
    '\u2014',
    '\u2014',
    '\u2014',
    'EREVID',
    '\u2014',
    '\u2014',
    'ECOCON',
    'Reserved',
    'EFLOCON',
    'EPAUSL',
    'EPAUSH',
    'Reserved',
    'EIE',
    'EIR',
    'ESTAT',
    'ECON2',
    'ECON1',
  ],
];

const OPCODE_MASK = 0xe0;
const REGISTER_MASK = 0x1f;
const ECON1 = 0x1f;

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

export class Enc28j60Decoder extends Decoder {
  static descriptor = descriptor;

  private outAnn = -1;
  private active = false;
  private mosi: WireByte[] = [];
  private miso: WireByte[] = [];
  private commandStart: bigint | null = null;
  private commandEnd: bigint | null = null;
  private bankSelect0: number | null = null;
  private bankSelect1: number | null = null;
  private lastWordEnd: bigint | null = null;
  private lastWordSpan = 0n;

  override reset(): void {
    this.active = false;
    this.mosi = [];
    this.miso = [];
    this.commandStart = null;
    this.commandEnd = null;
    this.bankSelect0 = null;
    this.bankSelect1 = null;
    this.lastWordEnd = null;
    this.lastWordSpan = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  onEof(): void {
    if (this.active) this.processCommand(this.lastWordEnd ?? this.samplenum);
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private commandAnnotation(classIndex: number, longText: string, shortText: string): void {
    this.annotate(this.commandStart ?? 0n, this.commandEnd ?? this.commandStart ?? 0n, classIndex, [
      longText,
      shortText,
    ]);
  }

  private commandWarning(reason: string): void {
    this.commandAnnotation(ANN.WARNING, `Warning: ${reason}`, 'Warning');
  }

  private registerName(address: number): string | null {
    if (this.bankSelect0 === null || this.bankSelect1 === null) return null;
    return REGS[(this.bankSelect1 << 1) + this.bankSelect0]?.[address] ?? null;
  }

  private putRegisterHeader(): void {
    const address = this.mosi[0]!.value & REGISTER_MASK,
      name = this.registerName(address);
    const ss = this.commandStart ?? this.mosi[0]!.ss,
      es = this.mosi[1]?.ss ?? this.commandEnd ?? this.mosi[0]!.es;
    if (name === null) {
      this.annotate(ss, es, ANN.REG_ADDR, [`Reg Bank ? Addr 0x${hex(address)}`, `?:${hex(address)}`]);
      this.annotate(ss, es, ANN.WARNING, ['Warning: Register bank not known yet.', 'Warning']);
      return;
    }
    this.annotate(ss, es, ANN.REG_ADDR, [`Reg ${name}`, name]);
    if (name === '-' || name === 'Reserved')
      this.annotate(ss, es, ANN.WARNING, ['Warning: Invalid register accessed.', 'Warning']);
  }

  private putDataByte(value: number, index: number, binary = false): void {
    const ss = this.mosi[index]!.ss,
      es = index === this.mosi.length - 1 ? (this.commandEnd ?? this.mosi[index]!.es) : this.mosi[index + 1]!.ss,
      longText = binary ? `Data 0b${value.toString(2).padStart(8, '0')}` : `Data 0x${hex(value)}`,
      shortText = binary ? value.toString(2).padStart(8, '0') : hex(value);
    this.annotate(ss, es, ANN.DATA, [longText, shortText]);
  }

  private processRCR(): void {
    this.commandAnnotation(ANN.RCR, 'Read Control Register', 'RCR');
    if (this.mosi.length !== 2 && this.mosi.length !== 3) {
      this.commandWarning('Invalid command length.');
      return;
    }
    this.putRegisterHeader();
    const name = this.registerName(this.mosi[0]!.value & REGISTER_MASK);
    if (name !== null) {
      if (name.startsWith('M') && this.mosi.length !== 3) {
        this.commandWarning('Attempting to read a MAC/MII register without using the dummy byte.');
        return;
      }
      if (!name.startsWith('M') && this.mosi.length !== 2) {
        this.commandWarning('Attempting to read a non-MAC/MII register using the dummy byte.');
        return;
      }
    }
    if (this.mosi.length === 2) this.putDataByte(this.miso[1]!.value, 1);
    else {
      this.annotate(this.mosi[1]!.ss, this.mosi[2]!.ss, ANN.DATA, ['Dummy Byte', 'Dummy']);
      this.putDataByte(this.miso[2]!.value, 2);
    }
  }

  private processRBM(): void {
    if (this.mosi[0]!.value !== 0x3a) {
      this.commandWarning('Invalid header byte.');
      return;
    }
    this.commandAnnotation(ANN.RBM, `Read Buffer Memory: Length ${this.mosi.length - 1}`, 'RBM');
    for (let index = 1; index < this.miso.length; index++) this.putDataByte(this.miso[index]!.value, index);
  }

  private processWCR(): void {
    this.commandAnnotation(ANN.WCR, 'Write Control Register', 'WCR');
    if (this.mosi.length !== 2) {
      this.commandWarning('Invalid command length.');
      return;
    }
    this.putRegisterHeader();
    this.putDataByte(this.mosi[1]!.value, 1);
    if ((this.mosi[0]!.value & REGISTER_MASK) === ECON1) {
      this.bankSelect0 = this.mosi[1]!.value & 1;
      this.bankSelect1 = (this.mosi[1]!.value >> 1) & 1;
    }
  }

  private processWBM(): void {
    if (this.mosi[0]!.value !== 0x7a) {
      this.commandWarning('Invalid header byte.');
      return;
    }
    this.commandAnnotation(ANN.WBM, `Write Buffer Memory: Length ${this.mosi.length - 1}`, 'WBM');
    for (let index = 1; index < this.mosi.length; index++) this.putDataByte(this.mosi[index]!.value, index);
  }

  private processBFS(): void {
    this.commandAnnotation(ANN.BFS, 'Bit Field Set', 'BFS');
    if (this.mosi.length !== 2) {
      this.commandWarning('Invalid command length.');
      return;
    }
    this.putRegisterHeader();
    const value = this.mosi[1]!.value;
    this.putDataByte(value, 1, true);
    if ((this.mosi[0]!.value & REGISTER_MASK) === ECON1) {
      if (value & 1) this.bankSelect0 = 1;
      if (value & 2) this.bankSelect1 = 1;
    }
  }

  private processBFC(): void {
    this.commandAnnotation(ANN.BFC, 'Bit Field Clear', 'BFC');
    if (this.mosi.length !== 2) {
      this.commandWarning('Invalid command length.');
      return;
    }
    this.putRegisterHeader();
    const value = this.mosi[1]!.value;
    this.putDataByte(value, 1, true);
    if ((this.mosi[0]!.value & REGISTER_MASK) === ECON1) {
      if (value & 1) this.bankSelect0 = 0;
      if (value & 2) this.bankSelect1 = 0;
    }
  }

  private processSRC(): void {
    this.commandAnnotation(ANN.SRC, 'System Reset Command', 'SRC');
    if (this.mosi.length !== 1) {
      this.commandWarning('Invalid command length.');
      return;
    }
    this.bankSelect0 = 0;
    this.bankSelect1 = 0;
  }

  private processCommand(end: bigint): void {
    if (!this.active) return;
    this.commandEnd = end;
    if (this.mosi.length) {
      const opcode = this.mosi[0]!.value & OPCODE_MASK;
      switch (opcode) {
        case 0x00:
          this.processRCR();
          break;
        case 0x20:
          this.processRBM();
          break;
        case 0x40:
          this.processWCR();
          break;
        case 0x60:
          this.processWBM();
          break;
        case 0x80:
          this.processBFS();
          break;
        case 0xa0:
          this.processBFC();
          break;
        case 0xe0:
          this.processSRC();
          break;
        default:
          this.commandWarning('Unknown opcode.');
      }
    }
    this.active = false;
    this.mosi = [];
    this.miso = [];
    this.commandStart = null;
    this.commandEnd = null;
  }

  private appendWord(word: SPIWord): void {
    if (!this.active) {
      this.active = true;
      this.commandStart = word.ss;
      this.mosi = [];
      this.miso = [];
    }
    const [mosi, miso] = splitWord(word);
    this.mosi.push(...mosi);
    this.miso.push(...miso);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING' && typeof data[1] === 'string') {
      if (data[1].startsWith('Chip select deasserted') && this.active) this.processCommand(this.lastWordEnd ?? es);
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word || word.mosi === null || word.miso === null) return;
    if (this.active && this.lastWordEnd !== null && ss - this.lastWordEnd > this.lastWordSpan)
      this.processCommand(this.lastWordEnd);
    if (word.cs === false) {
      if (this.active) this.processCommand(es);
      this.lastWordEnd = es;
      this.lastWordSpan = es > ss ? es - ss : 0n;
      return;
    }
    this.appendWord(word);
    this.lastWordEnd = es;
    this.lastWordSpan = es > ss ? es - ss : 0n;
  }
}

export default Enc28j60Decoder;
