import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface MdioOptions {
  show_debug_bits: 'yes' | 'no';
}

export type MdioProtocolPacket = readonly [
  clause45: boolean,
  clause45Address: number,
  read: boolean,
  portAddress: number,
  deviceAddress: number,
  data: number,
];

export type MdioProtocolData = readonly [MdioProtocolPacket];

type MdioState = 'PRE' | 'ST' | 'OP' | 'PRTAD' | 'DEVAD' | 'TA' | 'DATA';

interface BitRecord {
  value: number;
  ss: bigint;
  es: bigint | null;
}

const MDIO_ANN = Object.freeze({
  BIT: 0,
  BIT_NUMBER: 1,
  FRAME: 2,
  IDLE: 3,
  ERROR: 4,
  DECODE: 5,
});

function hex16(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

function decimal2(value: number): string {
  return value.toString().padStart(2, '0');
}

export class MdioDecoder extends Decoder<MdioOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outProtocol = -1;
  private illegalBus = false;
  private illegalStart = 0n;
  private clause45Address = -1;
  private bits: BitRecord[] = [];
  private bitCount = -1;
  private opcode = -1;
  private clause45 = false;
  private frameStart: bigint | null = null;
  private fieldStart: bigint | null = null;
  private preambleLength = 0;
  private taInvalid: string | null = null;
  private opInvalid = '';
  private portAddress = -1;
  private portAddressBits = 5;
  private deviceAddress = -1;
  private deviceAddressBits = 5;
  private data = -1;
  private dataBits = 16;
  private state: MdioState = 'PRE';

  constructor(options: Partial<MdioOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.illegalBus = false;
    this.illegalStart = 0n;
    this.clause45Address = -1;
    this.resetFrame();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]);
  }

  private resetFrame(): void {
    this.bits = [];
    this.bitCount = -1;
    this.opcode = -1;
    this.clause45 = false;
    this.frameStart = null;
    this.fieldStart = null;
    this.preambleLength = 0;
    this.taInvalid = null;
    this.opInvalid = '';
    this.portAddress = -1;
    this.portAddressBits = 5;
    this.deviceAddress = -1;
    this.deviceAddressBits = 5;
    this.data = -1;
    this.dataBits = 16;
    this.state = 'PRE';
  }

  private putField(classIndex: number, texts: readonly string[]): void {
    if (this.fieldStart !== null) this.put(this.fieldStart, this.samplenum, this.outAnn, [classIndex, texts]);
  }

  private putBit(value: number, ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [MDIO_ANN.BIT, [String(value)]]);
    if (this.options.show_debug_bits === 'yes')
      this.put(ss, es, this.outAnn, [
        MDIO_ANN.BIT_NUMBER,
        [String(this.bitCount - 1), String((this.bitCount - 1) % 10)],
      ]);
  }

  private cycleLength(): bigint {
    const lengths: number[] = [];
    for (let index = 1; index <= 48; index++) {
      const bit = this.bits[index];
      if (bit && bit.es !== null) lengths.push(Number(bit.es - bit.ss));
    }
    lengths.sort((left, right) => left - right);
    const value = lengths[12] ?? lengths[lengths.length - 1] ?? 1;
    return BigInt(Math.max(1, value));
  }

  private putData(end: bigint): void {
    const frameStart = this.frameStart ?? end;
    this.put(this.fieldStart ?? frameStart, end, this.outAnn, [
      MDIO_ANN.FRAME,
      [`DATA: ${hex16(this.data)}`, 'DATA', 'D'],
    ]);

    if (this.clause45 && this.opcode === 0) this.clause45Address = this.data;

    if (this.opcode > 0 || !this.clause45) {
      let short = '';
      if (this.clause45 && this.clause45Address !== -1) short += `ADDR: ${hex16(this.clause45Address)} `;
      else if (this.clause45) short += 'ADDR: UKWN ';

      const read = (this.clause45 && this.opcode > 1) || (!this.clause45 && this.opcode !== 0);
      short += `${read ? 'READ:  ' : 'WRITE: '}${hex16(this.data)}`;
      let extended = ` ${this.clause45 ? 'PRTAD' : 'PHYAD'}: ${decimal2(this.portAddress)}`;
      extended += ` ${this.clause45 ? 'DEVAD' : 'REGAD'}: ${decimal2(this.deviceAddress)}`;
      if (this.taInvalid || this.opInvalid) extended += ' ERROR';

      this.put(frameStart, end, this.outAnn, [MDIO_ANN.DECODE, [short + extended, short]]);
      const packet: MdioProtocolPacket = [
        this.clause45,
        this.clause45Address,
        read,
        this.portAddress,
        this.deviceAddress,
        this.data,
      ];
      this.put(frameStart, end, this.outProtocol, [packet]);
    }

    if (this.clause45 && this.opcode === 2 && this.clause45Address !== -1) this.clause45Address++;
  }

  private statePre(mdio: number): void {
    const now = this.samplenum;
    if (this.illegalBus) {
      if (mdio === 0) return;
      this.illegalBus = false;
      this.put(this.illegalStart, now, this.outAnn, [MDIO_ANN.ERROR, ['ILLEGAL BUS STATE', 'ILL']]);
      this.frameStart = now;
    }

    this.frameStart ??= now;
    if (mdio === 1) this.preambleLength++;

    if (this.preambleLength > 16) {
      if (this.preambleLength >= 10_032) {
        const retained = this.bits[32];
        if (retained) {
          this.put(this.frameStart, retained.ss, this.outAnn, [
            MDIO_ANN.IDLE,
            [`IDLE #${this.preambleLength - 32}`, 'IDLE', 'I'],
          ]);
          this.frameStart = retained.ss;
          this.preambleLength = 32;
          this.bits.length = Math.min(this.bits.length, 33);
        }
      }

      if (mdio === 0) {
        if (this.preambleLength < 32) {
          const first = this.bits[this.preambleLength];
          if (first) this.frameStart = first.ss;
          this.put(this.frameStart, now, this.outAnn, [MDIO_ANN.ERROR, ['SHORT PREAMBLE', 'SHRT PRE']]);
        } else if (this.preambleLength > 32) {
          const retained = this.bits[32];
          const first = this.bits[this.preambleLength];
          if (retained) {
            this.frameStart = retained.ss;
            this.put(first?.ss ?? retained.ss, retained.ss, this.outAnn, [
              MDIO_ANN.IDLE,
              [`IDLE #${this.preambleLength - 32}`, 'IDLE', 'I'],
            ]);
          }
          this.preambleLength = 32;
        } else {
          this.frameStart = this.bits[32]?.ss ?? this.frameStart;
        }
        this.put(this.frameStart, now, this.outAnn, [MDIO_ANN.FRAME, [`PRE #${this.preambleLength}`, 'PRE', 'P']]);
        this.fieldStart = now;
        this.state = 'ST';
      }
    } else if (mdio === 0) {
      this.illegalStart = this.frameStart;
      this.illegalBus = true;
    }
  }

  private stateStart(mdio: number): void {
    if (mdio === 0) this.clause45 = true;
    this.state = 'OP';
  }

  private stateOp(mdio: number): void {
    if (this.opcode === -1) {
      this.putField(
        MDIO_ANN.FRAME,
        this.clause45 ? ['ST (Clause 45)', 'ST 45', 'ST', 'S'] : ['ST (Clause 22)', 'ST 22', 'ST', 'S'],
      );
      this.fieldStart = this.samplenum;
      this.opcode = mdio === 1 ? 2 : 0;
      return;
    }

    if (this.clause45) {
      this.state = 'PRTAD';
      this.opcode += mdio;
    } else {
      if (mdio === this.opcode) this.opInvalid = 'invalid for Clause 22';
      this.state = 'PRTAD';
    }
  }

  private statePortAddress(mdio: number): void {
    if (this.portAddress === -1) {
      this.portAddress = 0;
      let op: readonly string[];
      if (this.clause45) {
        op =
          this.opcode === 0
            ? ['OP: ADDR', 'OP: A']
            : this.opcode === 1
              ? ['OP: WRITE', 'OP: W']
              : this.opcode === 2
                ? ['OP: READINC', 'OP: RI']
                : ['OP: READ', 'OP: R'];
      } else op = this.opcode ? ['OP: READ', 'OP: R'] : ['OP: WRITE', 'OP: W'];
      this.putField(MDIO_ANN.FRAME, [...op, 'OP', 'O']);
      if (this.opInvalid) this.putField(MDIO_ANN.ERROR, [`OP ${this.opInvalid}`, 'OP', 'O']);
      this.fieldStart = this.samplenum;
    }

    this.portAddressBits--;
    this.portAddress |= mdio << this.portAddressBits;
    if (this.portAddressBits === 0) this.state = 'DEVAD';
  }

  private stateDeviceAddress(mdio: number): void {
    if (this.deviceAddress === -1) {
      this.deviceAddress = 0;
      const text = this.clause45
        ? [`PRTAD: ${decimal2(this.portAddress)}`, 'PRT', 'P']
        : [`PHYAD: ${decimal2(this.portAddress)}`, 'PHY', 'P'];
      this.putField(MDIO_ANN.FRAME, text);
      this.fieldStart = this.samplenum;
    }

    this.deviceAddressBits--;
    this.deviceAddress |= mdio << this.deviceAddressBits;
    if (this.deviceAddressBits === 0) this.state = 'TA';
  }

  private stateTurnaround(mdio: number): void {
    if (this.taInvalid === null) {
      this.taInvalid = '';
      const text = this.clause45
        ? [`DEVAD: ${decimal2(this.deviceAddress)}`, 'DEV', 'D']
        : [`REGAD: ${decimal2(this.deviceAddress)}`, 'REG', 'R'];
      this.putField(MDIO_ANN.FRAME, text);
      this.fieldStart = this.samplenum;
      if (mdio !== 1 && ((this.clause45 && this.opcode < 2) || (!this.clause45 && this.opcode === 0)))
        this.taInvalid = ' invalid (bit1)';
      return;
    }

    if (mdio !== 0) this.taInvalid = this.taInvalid ? ' invalid (bit1 and bit2)' : ' invalid (bit2)';
    this.state = 'DATA';
  }

  private stateData(mdio: number): void {
    if (this.data === -1) {
      this.data = 0;
      this.putField(MDIO_ANN.FRAME, ['TA', 'T']);
      if (this.taInvalid) this.putField(MDIO_ANN.ERROR, [`TA${this.taInvalid}`, 'TA', 'T']);
      this.fieldStart = this.samplenum;
    }

    this.dataBits--;
    this.data |= mdio << this.dataBits;
    if (this.dataBits !== 0) return;

    const last = this.bits[0]!;
    last.es = last.ss + this.cycleLength();
    this.bitCount++;
    this.putBit(last.value, last.ss, last.es);
    this.putData(last.es);
    this.resetFrame();
  }

  private processState(mdio: number): void {
    switch (this.state) {
      case 'PRE':
        this.statePre(mdio);
        break;
      case 'ST':
        this.stateStart(mdio);
        break;
      case 'OP':
        this.stateOp(mdio);
        break;
      case 'PRTAD':
        this.statePortAddress(mdio);
        break;
      case 'DEVAD':
        this.stateDeviceAddress(mdio);
        break;
      case 'TA':
        this.stateTurnaround(mdio);
        break;
      case 'DATA':
        this.stateData(mdio);
        break;
    }
  }

  private handleBit(mdio: number): void {
    this.bitCount++;
    this.bits.unshift({ value: mdio, ss: this.samplenum, es: null });

    if (this.bitCount > 0) {
      const previous = this.bits[1]!;
      previous.es = this.samplenum;
      this.putBit(previous.value, previous.ss, this.samplenum);
    }

    this.processState(mdio);
  }

  *decode(): LogicGenerator {
    while (true) {
      const pins = yield this.wait({ mdc: 'r' });
      this.handleBit(Number(pins[1]) & 1);
    }
  }
}

export default MdioDecoder;
