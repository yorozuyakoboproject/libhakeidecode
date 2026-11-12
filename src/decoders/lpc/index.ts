import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, WaitCondition } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const LPC_ANN = Object.freeze({
  WARNING: 0,
  START: 1,
  CYCLE_TYPE: 2,
  ADDRESS: 3,
  TAR1: 4,
  SYNC: 5,
  DATA: 6,
  TAR2: 7,
});

const START_FIELDS: Readonly<Record<number, string>> = {
  0b0000: 'Start of cycle for a target',
  0b0001: 'Reserved',
  0b0010: 'Grant for bus master 0',
  0b0011: 'Grant for bus master 1',
  0b0100: 'Reserved',
  0b0101: 'Reserved',
  0b0110: 'Reserved',
  0b0111: 'Reserved',
  0b1000: 'Reserved',
  0b1001: 'Reserved',
  0b1010: 'Reserved',
  0b1011: 'Reserved',
  0b1100: 'Reserved',
  0b1101: 'Start of cycle for a Firmware Memory Read cycle',
  0b1110: 'Start of cycle for a Firmware Memory Write cycle',
  0b1111: 'Stop/abort (end of a cycle for a target)',
};

const CYCLE_TYPES: Readonly<Record<number, string>> = {
  0b0000: 'I/O read',
  0b0010: 'I/O write',
  0b0100: 'Memory read',
  0b0110: 'Memory write',
  0b1000: 'DMA read',
  0b1010: 'DMA write',
  0b1100: 'Reserved / not allowed',
  0b1110: 'Reserved / not allowed',
};

const SYNC_FIELDS: Readonly<Record<number, string>> = {
  0b0000: 'Ready',
  0b0001: 'Reserved',
  0b0010: 'Reserved',
  0b0011: 'Reserved',
  0b0100: 'Reserved',
  0b0101: 'Short wait',
  0b0110: 'Long wait',
  0b0111: 'Reserved',
  0b1000: 'Reserved',
  0b1001: 'Ready more (DMA only)',
  0b1010: 'Error',
  0b1011: 'Reserved',
  0b1100: 'Reserved',
  0b1101: 'Reserved',
  0b1110: 'Reserved',
  0b1111: 'Reserved',
};

type LpcState = 'IDLE' | 'GET START' | 'GET CT/DR' | 'GET ADDR' | 'GET TAR' | 'GET SYNC' | 'GET DATA' | 'GET TAR2';

export class LpcDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;
  private outAnn = -1;
  private state: LpcState = 'IDLE';
  private oldClock = 0;
  private previousStart = -1;
  private address = 0;
  private addressNibble = 0;
  private addressNibbles = 0;
  private cycleType = '';
  private dataByte = 0;
  private dataNibble = 0;
  private tarCount = 0;
  private syncCount = 0;
  private blockStart = 0n;
  private blockEnd = 0n;

  override reset(): void {
    this.state = 'IDLE';
    this.oldClock = 0;
    this.previousStart = -1;
    this.address = 0;
    this.addressNibble = 0;
    this.addressNibbles = 0;
    this.cycleType = '';
    this.dataByte = 0;
    this.dataNibble = 0;
    this.tarCount = 0;
    this.syncCount = 0;
    this.blockStart = 0n;
    this.blockEnd = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private annotate(classIndex: number, texts: readonly string[], ss = this.blockStart, es = this.blockEnd): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private handleStart(lad: number, lframe: number): void {
    const text = START_FIELDS[lad] ?? 'Reserved';
    this.syncCount = 0;
    this.blockEnd = this.samplenum;
    this.annotate(LPC_ANN.START, [text, 'START', 'St', 'S']);
    if (this.previousStart !== -1 && this.previousStart !== lad)
      this.annotate(LPC_ANN.WARNING, ['LAD[3:0] changed while LFRAME# was asserted']);
    this.previousStart = lad;
    this.blockStart = this.samplenum;
    if (lframe === 1) {
      this.state = 'GET CT/DR';
      this.previousStart = -1;
    }
  }

  private handleCycleType(lad: number, bits: string): void {
    this.cycleType = CYCLE_TYPES[lad] ?? 'Reserved / unknown';
    this.blockEnd = this.samplenum;
    if (this.cycleType.includes('Reserved')) this.annotate(LPC_ANN.WARNING, [`Invalid cycle type (${bits})`]);
    this.annotate(LPC_ANN.CYCLE_TYPE, [`Cycle type: ${this.cycleType}`]);
    this.blockStart = this.samplenum;
    this.state = 'GET ADDR';
    this.address = 0;
    this.addressNibble = 0;
    this.addressNibbles = this.cycleType.startsWith('I/O') ? 4 : this.cycleType.startsWith('Memory') ? 8 : 0;
    if (this.addressNibbles === 0) {
      this.state = 'GET TAR';
      this.tarCount = 0;
    }
  }

  private handleAddress(lad: number): void {
    const offset = (this.addressNibbles - 1 - this.addressNibble) * 4;
    this.address = (this.address | (lad << offset)) >>> 0;
    if (this.addressNibble < this.addressNibbles - 1) {
      this.addressNibble++;
      return;
    }
    this.blockEnd = this.samplenum;
    this.annotate(LPC_ANN.ADDRESS, [`Address: 0x${this.address.toString(16).padStart(this.addressNibbles, '0')}`]);
    this.blockStart = this.samplenum;
    this.state = 'GET TAR';
    this.tarCount = 0;
  }

  private handleTar(classIndex: number, bits: string, final: boolean): void {
    this.blockEnd = this.samplenum;
    this.annotate(classIndex, [`TAR, cycle ${this.tarCount}: ${bits}`]);
    if (bits !== '1111')
      this.annotate(LPC_ANN.WARNING, [
        final
          ? `Warning: TAR, cycle ${this.tarCount}: ${bits} (expected 1111)`
          : `TAR, cycle ${this.tarCount}: ${bits} (expected 1111)`,
      ]);
    this.blockStart = this.samplenum;
    if (this.tarCount === 0) {
      this.tarCount = 1;
      return;
    }
    this.tarCount = 0;
    this.state = final ? 'IDLE' : 'GET SYNC';
  }

  private handleSync(lad: number, bits: string): void {
    const text = SYNC_FIELDS[lad] ?? 'Reserved / unknown';
    this.blockEnd = this.samplenum;
    if (text.includes('Reserved'))
      this.annotate(LPC_ANN.WARNING, [`SYNC, cycle ${this.syncCount}: ${bits} (reserved value)`]);
    this.annotate(LPC_ANN.SYNC, [`SYNC, cycle ${this.syncCount}: ${bits}`]);
    this.blockStart = this.samplenum;
    this.syncCount++;
    this.dataNibble = 0;
    this.state = 'GET DATA';
  }

  private handleData(lad: number): void {
    this.dataByte = this.dataNibble === 0 ? lad : this.dataByte | (lad << 4);
    if (this.dataNibble === 0) {
      this.dataNibble = 1;
      return;
    }
    this.blockEnd = this.samplenum;
    this.annotate(LPC_ANN.DATA, [`DATA: 0x${this.dataByte.toString(16).padStart(2, '0')}`]);
    this.blockStart = this.samplenum;
    this.dataNibble = 0;
    this.tarCount = 0;
    this.state = 'GET TAR2';
  }

  *decode(): LogicGenerator {
    const conditions: readonly WaitCondition[] = [
      { lframe: 'e' },
      { lclk: 'e' },
      { lad0: 'e' },
      { lad1: 'e' },
      { lad2: 'e' },
      { lad3: 'e' },
    ];
    let pins = yield this.wait(conditions);
    while (true) {
      const lframe = Number(pins[0]) & 1;
      const lclk = Number(pins[1]) & 1;
      if (this.oldClock === 0 && lclk === 1) {
        const lad =
          (Number(pins[2]) & 1) |
          ((Number(pins[3]) & 1) << 1) |
          ((Number(pins[4]) & 1) << 2) |
          ((Number(pins[5]) & 1) << 3);
        const bits = lad.toString(2).padStart(4, '0');
        if (this.state === 'IDLE') {
          if (lframe === 0) {
            this.blockStart = this.samplenum;
            this.previousStart = -1;
            this.state = 'GET START';
          }
        } else if (this.state === 'GET START') {
          this.handleStart(lad, lframe);
        } else if (this.state === 'GET CT/DR') {
          this.handleCycleType(lad, bits);
        } else if (this.state === 'GET ADDR') {
          this.handleAddress(lad);
        } else if (this.state === 'GET TAR') {
          this.handleTar(LPC_ANN.TAR1, bits, false);
        } else if (this.state === 'GET SYNC') {
          this.handleSync(lad, bits);
        } else if (this.state === 'GET DATA') {
          this.handleData(lad);
        } else {
          this.handleTar(LPC_ANN.TAR2, bits, true);
        }
      }
      this.oldClock = lclk;
      pins = yield this.wait(conditions);
    }
  }
}

export default LpcDecoder;
