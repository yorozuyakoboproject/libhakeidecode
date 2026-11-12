import { Decoder, OUTPUT_ANN, OUTPUT_BINARY, OUTPUT_META, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const UI_US = 1_000_000 / 600_000;
const THRESHOLD_US = (UI_US + 2 * UI_US) / 2;

const CTRL_TYPES: Readonly<Record<number, string>> = {
  0: 'reserved',
  1: 'GOOD CRC',
  2: 'GOTO MIN',
  3: 'ACCEPT',
  4: 'REJECT',
  5: 'PING',
  6: 'PS RDY',
  7: 'GET SOURCE CAP',
  8: 'GET SINK CAP',
  9: 'DR SWAP',
  10: 'PR SWAP',
  11: 'VCONN SWAP',
  12: 'WAIT',
  13: 'SOFT RESET',
  14: 'reserved',
  15: 'reserved',
  16: 'Not Supported',
  17: 'Get_Source_Cap_Extended',
  18: 'Get_Status',
  19: 'FR_Swap',
  20: 'Get_PPS_Status',
  21: 'Get_Country_Codes',
};

const DATA_TYPES: Readonly<Record<number, string>> = {
  1: 'SOURCE CAP',
  2: 'REQUEST',
  3: 'BIST',
  4: 'SINK CAP',
  5: 'Battery_Status',
  6: 'Alert',
  7: 'Get_Country_Info',
  15: 'VDM',
};

export const DEC4B5B = [
  0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x13, 0x14, 0x10, 0x01, 0x04, 0x05, 0x10, 0x16, 0x06, 0x07, 0x10, 0x12, 0x08,
  0x09, 0x02, 0x03, 0x0a, 0x0b, 0x11, 0x15, 0x0c, 0x0d, 0x0e, 0x0f, 0x00, 0x10,
];

const SYNC1 = 0x11;
const SYNC2 = 0x12;
const SYNC3 = 0x13;
const RST1 = 0x14;
const RST2 = 0x15;
export const PD_EOP = 0x16;
const HRST_CODES = [RST1, RST1, RST1, RST2];

export const SOP_SEQUENCES: readonly (readonly number[])[] = [
  [SYNC1, SYNC1, SYNC1, SYNC2],
  [SYNC1, SYNC1, SYNC3, SYNC3],
  [SYNC1, SYNC3, SYNC1, SYNC3],
  [SYNC1, RST2, RST2, SYNC3],
  [SYNC1, RST2, SYNC3, SYNC2],
  [RST1, SYNC1, RST1, SYNC3],
  HRST_CODES,
];

export const START_OF_PACKETS = new Map(
  ['SOP', "SOP'", 'SOP"', "SOP' Debug", 'SOP" Debug', 'Cable Reset', 'Hard Reset'].map((name, index) => [
    SOP_SEQUENCES[index]!.join(','),
    name,
  ]),
);

export const SYM_NAME: readonly (readonly [string, string])[] = [
  ['0x0', '0'],
  ['0x1', '1'],
  ['0x2', '2'],
  ['0x3', '3'],
  ['0x4', '4'],
  ['0x5', '5'],
  ['0x6', '6'],
  ['0x7', '7'],
  ['0x8', '8'],
  ['0x9', '9'],
  ['0xA', 'A'],
  ['0xB', 'B'],
  ['0xC', 'C'],
  ['0xD', 'D'],
  ['0xE', 'E'],
  ['0xF', 'F'],
  ['ERROR', 'X'],
  ['SYNC-1', 'S1'],
  ['SYNC-2', 'S2'],
  ['SYNC-3', 'S3'],
  ['RST-1', 'R1'],
  ['RST-2', 'R2'],
  ['EOP', '#'],
];

const RDO_FLAGS: readonly (readonly [number, string])[] = [
  [1 << 27, 'give_back'],
  [1 << 26, 'cap_mismatch'],
  [1 << 25, 'comm_cap'],
  [1 << 24, 'no_suspend'],
  [1 << 23, 'unchunked'],
];

const BIST_MODES: Readonly<Record<number, string>> = {
  0: 'Receiver',
  1: 'Transmit',
  2: 'Counters',
  3: 'Carrier 0',
  4: 'Carrier 1',
  5: 'Carrier 2',
  6: 'Carrier 3',
  7: 'Eye',
};

const VDM_CMDS: Readonly<Record<number, string>> = {
  1: 'Disc Ident',
  2: 'Disc SVID',
  3: 'Disc Mode',
  4: 'Enter Mode',
  5: 'Exit Mode',
  6: 'Attention',
  16: 'DP Status',
  17: 'DP Configure',
};

const VDM_ACK = ['REQ', 'ACK', 'NAK', 'BSY'];

export interface UsbPowerDeliveryOptions {
  fulltext: 'yes' | 'no';
}

type BadInterval = readonly [bigint, bigint];

function hex(value: number, digits: number): string {
  return (value >>> 0).toString(16).padStart(digits, '0');
}

function g(value: number): string {
  return Number(value.toPrecision(6)).toString();
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class UsbPowerDeliveryDecoder extends Decoder<UsbPowerDeliveryOptions> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private maxbit = 0;
  private threshold = 0;
  private idx = 0;
  private packetSeq = 0;
  private previous = 0n;
  private startsample: bigint | null = null;
  private bits: number[] = [];
  private edges: bigint[] = [];
  private bad: BadInterval[] = [];
  private halfOne = false;
  private startOne = 0n;
  private storedPdos = new Map<number, string>();
  private capMark = [0, 0, 0, 0, 0, 0, 0, 0];
  private head = 0;
  private data: number[] = [];
  private text = '';
  private crc = 0;
  private outAnn = -1;
  private outBinary = -1;
  private outMeta = -1;

  constructor(options: Partial<UsbPowerDeliveryOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.maxbit = 0;
    this.threshold = 0;
    this.idx = 0;
    this.packetSeq = 0;
    this.previous = 0n;
    this.startsample = null;
    this.bits = [];
    this.edges = [];
    this.bad = [];
    this.halfOne = false;
    this.startOne = 0n;
    this.storedPdos = new Map();
    this.capMark = [0, 0, 0, 0, 0, 0, 0, 0];
    this.head = 0;
    this.data = [];
    this.text = '';
    this.crc = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
    this.outMeta = this.register(OUTPUT_META, undefined, ['int', 'Bitrate', 'Bitrate during the packet']);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.maxbit = this.us2samples(3 * UI_US);
    this.threshold = this.us2samples(THRESHOLD_US);
  }

  private us2samples(microseconds: number): number {
    return Math.trunc((microseconds * this.samplerate!) / 1_000_000);
  }

  private edgeAt(index: number): bigint {
    let resolved = index;
    if (resolved < 0) resolved = this.edges.length + resolved;
    if (resolved < 0) resolved = 0;
    if (resolved >= this.edges.length) resolved = this.edges.length - 1;
    return this.edges[resolved] ?? this.startsample ?? 0n;
  }

  private putx(first: number, last: number, data: readonly [number, readonly string[]]): void {
    this.put(this.edgeAt(first), this.edgeAt(last), this.outAnn, data);
  }

  private putwarn(long: string, short: string): void {
    this.putx(0, -1, [8, [long, short]]);
  }

  private recSym(index: number, symbol: number): void {
    this.putx(index, index + 5, [7, SYM_NAME[symbol] ?? ['ERROR', 'X']]);
  }

  private getSym(index: number, record = true): number {
    const value =
      this.bits[index]! |
      (this.bits[index + 1]! << 1) |
      (this.bits[index + 2]! << 2) |
      (this.bits[index + 3]! << 3) |
      (this.bits[index + 4]! << 4);
    const symbol = DEC4B5B[value]!;
    if (record) this.recSym(index, symbol);
    return symbol;
  }

  private getShort(): number {
    const index = this.idx;
    if (this.bits.length - index <= 20) {
      this.putwarn('Truncated', '!');
      return 0x0bad;
    }
    const symbols = [this.getSym(index), this.getSym(index + 5), this.getSym(index + 10), this.getSym(index + 15)];
    this.idx += 20;
    return (symbols[0]! | (symbols[1]! << 4) | (symbols[2]! << 8) | (symbols[3]! << 12)) >>> 0;
  }

  private getWord(): number {
    const low = this.getShort();
    const high = this.getShort();
    return (low | (high << 16)) >>> 0;
  }

  private findCorruptedSop(symbols: readonly number[]): string | null {
    for (const sequence of SOP_SEQUENCES) {
      let matches = 0;
      for (let index = 0; index < sequence.length; index++) if (symbols[index] === sequence[index]) matches++;
      if (matches >= 3) return START_OF_PACKETS.get(sequence.join(',')) ?? null;
    }
    return null;
  }

  private scanEop(): number {
    for (let index = 0; index < this.bits.length - 19; index++) {
      const symbols = [
        this.getSym(index, false),
        this.getSym(index + 5, false),
        this.getSym(index + 10, false),
        this.getSym(index + 15, false),
      ];
      let name = START_OF_PACKETS.get(symbols.join(',')) ?? this.findCorruptedSop(symbols);
      if (!name) continue;
      this.putx(0, index, [1, ['Preamble', '...']]);
      this.recSym(index, symbols[0]!);
      this.recSym(index + 5, symbols[1]!);
      this.recSym(index + 10, symbols[2]!);
      this.recSym(index + 15, symbols[3]!);
      if (name === 'Hard Reset' || name === 'Cable Reset') {
        this.text += name === 'Hard Reset' ? 'HRST' : 'CRST';
        return -1;
      }
      this.putx(index, index + 20, [2, [name, 'S']]);
      return index + 20;
    }
    this.putx(0, this.bits.length, [1, ['Junk???', 'XXX']]);
    this.text += 'Junk???';
    this.putwarn('No start of packet found', 'XXX');
    return -1;
  }

  private headId(): number {
    return (this.head >>> 9) & 7;
  }

  private headPowerRole(): number {
    return (this.head >>> 8) & 1;
  }

  private headDataRole(): number {
    return (this.head >>> 5) & 1;
  }

  private headRev(): number {
    return ((this.head >>> 6) & 3) + 1;
  }

  private headType(): number {
    return this.headRev() === 3 ? this.head & 0x1f : this.head & 0x0f;
  }

  private headCount(): number {
    return (this.head >>> 12) & 7;
  }

  private putHead(): void {
    const source = this.headPowerRole() === 1;
    const annotation = source ? 9 : 10;
    let role = source ? 'SRC' : 'SNK';
    if (this.headDataRole() !== this.headPowerRole()) role += this.headDataRole() ? '/DFP' : '/UFP';
    const type = this.headType();
    const short = this.headCount() === 0 ? (CTRL_TYPES[type] ?? 'reserved') : (DATA_TYPES[type] ?? 'DAT???');
    const long = `(r${this.headRev()}) ${role}[${this.headId()}]: ${short}`;
    this.putx(0, -1, [annotation, [long, short]]);
    this.text += long;
  }

  private getRequest(rdo: number): string {
    const position = (rdo >>> 28) & 7;
    const mark = this.capMark[position] ?? 0;
    let settings: string;
    if (mark === 3) {
      const voltage = ((rdo >>> 9) & 0x7ff) * 0.02;
      const current = (rdo & 0x3f) * 0.05;
      settings = `${g(voltage)}V ${g(current)}A`;
    } else if (mark === 2) {
      const power = ((rdo >>> 10) & 0x3ff) * 0.25;
      settings = `${g(power)}W (operating)`;
    } else {
      const operating = ((rdo >>> 10) & 0x3ff) * 0.01;
      const maximum = (rdo & 0x3ff) * 0.01;
      settings = `${g(operating)}A (operating) / ${g(maximum)}A (max)`;
    }
    let flags = '';
    for (const [mask, name] of RDO_FLAGS) if (rdo & mask) flags += ` [${name}]`;
    const pdo = this.storedPdos.get(position);
    return `(PDO #${position}${pdo ? `: ${pdo}` : ''}) ${settings}${flags}`;
  }

  private getSourceSinkCap(pdo: number, index: number, source: boolean): string {
    const kind = (pdo >>> 30) & 3;
    this.capMark[index] = kind;
    let name = '';
    let reading = '';
    let flags: readonly (readonly [number, string])[] = [];
    if (kind === 0) {
      name = 'Fixed';
      flags = source
        ? [
            [1 << 29, 'dual_role_power'],
            [1 << 28, 'suspend'],
            [1 << 27, 'unconstrained'],
            [1 << 26, 'comm_cap'],
            [1 << 25, 'dual_role_data'],
            [1 << 24, 'unchunked'],
          ]
        : [
            [1 << 29, 'dual_role_power'],
            [1 << 28, 'high_capability'],
            [1 << 27, 'unconstrained'],
            [1 << 26, 'comm_cap'],
            [1 << 25, 'dual_role_data'],
            [1 << 23, 'fr_swap default power'],
            [2 << 23, 'fr_swap 1.5 A'],
            [3 << 23, 'fr_swap 3.0 A'],
          ];
      const voltage = ((pdo >>> 10) & 0x3ff) * 0.05;
      const current = (pdo & 0x3ff) * 0.01;
      reading = `${g(voltage)}V ${g(current)}A (${g(voltage * current)}W)`;
      this.storedPdos.set(index, `${name} ${g(voltage)}V`);
    } else if (kind === 1) {
      name = 'Battery';
      const minimum = ((pdo >>> 10) & 0x3ff) * 0.05;
      const maximum = ((pdo >>> 20) & 0x3ff) * 0.05;
      const power = (pdo & 0x3ff) * 0.25;
      reading = `${g(minimum)}/${g(maximum)}V ${g(power)}W`;
      this.storedPdos.set(index, `${name} ${g(minimum)}/${g(maximum)}V`);
    } else if (kind === 2) {
      name = 'Variable';
      const minimum = ((pdo >>> 10) & 0x3ff) * 0.05;
      const maximum = ((pdo >>> 20) & 0x3ff) * 0.05;
      const current = (pdo & 0x3ff) * 0.01;
      reading = `${g(minimum)}/${g(maximum)}V ${g(current)}A`;
      this.storedPdos.set(index, `${name} ${g(minimum)}/${g(maximum)}V`);
    } else {
      const subtype = (pdo >>> 28) & 3;
      if (subtype === 0) {
        name = 'Programmable|PPS';
        flags = [[1 << 29, 'power_limited']];
        const minimum = ((pdo >>> 8) & 0xff) * 0.1;
        const maximum = ((pdo >>> 17) & 0xff) * 0.1;
        const current = (pdo & 0xff) * 0.05;
        reading = `${g(minimum)}/${g(maximum)}V ${g(current)}A`;
        if ((pdo >>> 27) & 1) reading += ' [limited]';
        this.storedPdos.set(index, `${name} ${g(minimum)}/${g(maximum)}V`);
      } else {
        name = `Reserved APDO: 0b${subtype.toString(2)}`;
        reading = `[raw: 0b${pdo.toString(2)}]`;
        this.storedPdos.set(index, `${name} ${reading}`);
      }
    }
    let suffix = '';
    for (const [mask, flag] of flags) if ((pdo & mask) === mask) suffix += ` [${flag}]`;
    return `[${name}] ${reading}${suffix}`;
  }

  private getVdm(index: number, word: number): string {
    if (index > 0) return `VDO:${hex(word, 8)}`;
    const vendor = word >>> 16;
    const structured = (word >>> 15) & 1;
    let text: string;
    if (structured) {
      const command = word & 0x1f;
      const acknowledgement = (word >>> 6) & 3;
      const position = (word >>> 8) & 7;
      text = `${VDM_ACK[acknowledgement] ?? 'REQ'} ${VDM_CMDS[command] ?? 'cmd?'}`;
      if (position) text += ` pos ${position}`;
    } else {
      text = `unstruct [${hex(word & 0x7fff, 4)}]`;
    }
    return `${text} SVID:${hex(vendor, 4)}`;
  }

  private getBist(index: number, word: number): string {
    const mode = word >>> 28;
    const counter = word & 0xffff;
    const modeName = mode === 2 ? `Counter[= ${counter}]` : (BIST_MODES[mode] ?? 'INVALID');
    return index === 0 ? `mode ${modeName}` : 'invalid BRO';
  }

  private putPayload(first: number, last: number, index: number): void {
    const type = this.headType();
    let text = `[${index + 1}] `;
    if (type === 2) text += this.getRequest(this.data[index]!);
    else if (type === 1 || type === 4) text += this.getSourceSinkCap(this.data[index]!, index + 1, type === 1);
    else if (type === 15) text += this.getVdm(index, this.data[index]!);
    else if (type === 3) text += this.getBist(index, this.data[index]!);
    this.putx(first, last, [11, [text, text]]);
    this.text += ` - ${text}`;
  }

  private computeCrc32(): number {
    const bytes = new Uint8Array(2 + this.data.length * 4);
    bytes[0] = this.head & 0xff;
    bytes[1] = (this.head >>> 8) & 0xff;
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < this.data.length; index++) view.setUint32(2 + index * 4, this.data[index]! >>> 0, true);
    return crc32(bytes);
  }

  private decodePacket(): void {
    this.data = [];
    this.idx = 0;
    this.text = '';
    if (this.edges.length < 50) return;
    this.packetSeq++;
    const timestamp = Number(this.startsample ?? 0n) / this.samplerate!;
    this.text += `#${String(this.packetSeq).padStart(4)} (${(timestamp * 1000).toFixed(6)}ms): `;
    this.idx = this.scanEop();
    if (this.idx < 0) {
      this.putx(0, this.idx, [12, [this.text, '...']]);
      return;
    }

    this.head = this.getShort();
    this.putx(this.idx - 20, this.idx, [3, [`H:${hex(this.head, 4)}`, 'HD']]);
    this.putHead();
    for (let index = 0; index < this.headCount(); index++) {
      this.data.push(this.getWord());
      this.putx(this.idx - 40, this.idx, [4, [`[${index}]${hex(this.data[index]!, 8)}`, `D${index}`]]);
      this.putPayload(this.idx - 40, this.idx, index);
    }

    this.crc = this.getWord();
    const calculated = this.computeCrc32();
    if (this.crc !== calculated) this.putwarn(`Bad CRC ${hex(this.crc, 8)} != ${hex(calculated, 8)}`, 'CRC!');
    this.putx(this.idx - 40, this.idx, [5, [`CRC:${hex(this.crc, 8)}`, 'CRC']]);

    if (this.bits.length >= this.idx + 5 && this.getSym(this.idx) === PD_EOP) {
      this.putx(this.idx, this.idx + 5, [6, ['EOP', 'E']]);
      this.idx += 5;
    } else {
      this.putwarn('No EOP', 'EOP!');
    }
    if (this.options.fulltext === 'yes') this.putx(0, this.idx, [12, [this.text, '...']]);

    const first = this.edges[0]!;
    const last = this.edges[this.edges.length - 1]!;
    if (last > first) {
      const bitrate = Math.trunc((this.samplerate! * this.bits.length) / Number(last - first));
      this.put(first, last, this.outMeta, bitrate);
    }
    if (this.bits.length) this.put(first, last, this.outBinary, [0, Uint8Array.from(this.bits)]);
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    const timeout = Math.max(1, Math.trunc(this.samplerate / 1000));
    for (;;) {
      yield this.wait([{ 0: 'e' }, { 1: 'e' }, { skip: timeout }]);
      if (this.startsample === null) {
        this.startsample = this.samplenum;
        this.previous = this.samplenum;
        continue;
      }
      const difference = this.samplenum - this.previous;
      if (difference > BigInt(this.maxbit)) {
        this.edges.push(this.previous);
        this.decodePacket();
        this.startsample = this.samplenum;
        this.bits = [];
        this.edges = [];
        this.bad = [];
        this.halfOne = false;
        this.startOne = 0n;
        this.previous = this.samplenum;
        continue;
      }
      const zero = difference > BigInt(this.threshold);
      if (zero && !this.halfOne) {
        this.bits.push(0);
        this.edges.push(this.previous);
      } else if (!zero && this.halfOne) {
        this.bits.push(1);
        this.edges.push(this.startOne);
        this.halfOne = false;
      } else if (!zero && !this.halfOne) {
        this.halfOne = true;
        this.startOne = this.previous;
      } else {
        this.bad.push([this.startOne, this.previous]);
        this.bits.push(0);
        this.edges.push(this.previous);
        this.halfOne = false;
      }
      this.previous = this.samplenum;
    }
  }
}

export default UsbPowerDeliveryDecoder;
