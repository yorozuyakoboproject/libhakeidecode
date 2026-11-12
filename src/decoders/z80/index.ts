import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pin } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';
import { INSTRUCTION_TABLES } from './tables.js';

export const Z80_ANN = Object.freeze({
  ADDRESS: 0,
  MEMRD: 1,
  MEMWR: 2,
  IORD: 3,
  IOWR: 4,
  INSTR: 5,
  READ_OPERAND: 6,
  WRITE_OPERAND: 7,
  WARNING: 8,
});

const enum Cycle {
  None,
  MemRead,
  MemWrite,
  IoRead,
  IoWrite,
  Fetch,
  InterruptAck,
}

const DATA_CYCLE_ANNOTATION: Readonly<Record<Cycle, number | null>> = {
  [Cycle.None]: null,
  [Cycle.MemRead]: Z80_ANN.MEMRD,
  [Cycle.MemWrite]: Z80_ANN.MEMWR,
  [Cycle.IoRead]: Z80_ANN.IORD,
  [Cycle.IoWrite]: Z80_ANN.IOWR,
  [Cycle.Fetch]: Z80_ANN.MEMRD,
  [Cycle.InterruptAck]: Z80_ANN.IORD,
};

type OpState =
  | 'IDLE'
  | 'RESTART'
  | 'PRE1'
  | 'PRE2'
  | 'PREDIS'
  | 'OPCODE'
  | 'POSTDIS'
  | 'IMM1'
  | 'IMM2'
  | 'ROP1'
  | 'ROP2'
  | 'WOP1'
  | 'WOP2';

function reduceBus(bus: readonly Pin[]): number | null {
  if (bus.some((pin) => pin === 0xff)) return null;
  let value = 0;
  for (let bit = 0; bit < bus.length; bit++) value |= (Number(bus[bit]) & 1) << bit;
  return value;
}

function signedByte(value: number): number {
  return value < 128 ? value : value - 256;
}

function formatField(value: string | number, spec: string | undefined): string {
  if (spec === undefined) return String(value);
  if (spec.endsWith('H')) {
    const width = Number.parseInt(spec.slice(0, -1), 10) || 1;
    const result = (Number(value) >>> 0).toString(16).toUpperCase().padStart(width, '0');
    return /^\d/.test(result) ? result : `0${result}`;
  }
  if (spec === '+d') return Number(value) >= 0 ? `+${Number(value)}` : String(Number(value));
  if (/^\d+X$/.test(spec)) {
    const width = Number.parseInt(spec.slice(0, -1), 10);
    return (Number(value) >>> 0).toString(16).toUpperCase().padStart(width, '0');
  }
  return String(value);
}

function formatMnemonic(
  template: string,
  values: Readonly<Record<'r' | 'd' | 'j' | 'i' | 'ro' | 'wo', string | number>>,
): string {
  return template.replace(/\{(\w+)(?::([^}]+))?\}/g, (_, key: string, spec?: string) =>
    formatField(values[key as keyof typeof values] ?? '', spec),
  );
}

export class Z80Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;
  private outAnn = -1;
  private previousCycle = Cycle.None;
  private opState: OpState = 'IDLE';
  private busData: number | null = null;
  private addressStart = 0n;
  private dataStart = 0n;
  private disassemblyStart = 0n;
  private pendingAddress: number | null = null;
  private pendingData: number | null = null;
  private annotationData: number | null = null;
  private annotationDisassembly: number | null = null;
  private instructionLength = 0;
  private operandPrefix = 0;
  private indexRegister = '';
  private wantDisplacement = 0;
  private wantImmediate = 0;
  private wantRead = 0;
  private wantWrite = 0;
  private wantWriteBigEndian = false;
  private repeat = false;
  private argumentDisplacement = 0;
  private argumentImmediate = 0;
  private argumentRead = 0;
  private argumentWrite = 0;
  private mnemonic = '';

  override reset(): void {
    this.previousCycle = Cycle.None;
    this.opState = 'IDLE';
    this.busData = null;
    this.addressStart = 0n;
    this.dataStart = 0n;
    this.disassemblyStart = 0n;
    this.pendingAddress = null;
    this.pendingData = null;
    this.annotationData = null;
    this.annotationDisassembly = null;
    this.instructionLength = 0;
    this.operandPrefix = 0;
    this.indexRegister = '';
    this.wantDisplacement = 0;
    this.wantImmediate = 0;
    this.wantRead = 0;
    this.wantWrite = 0;
    this.wantWriteBigEndian = false;
    this.repeat = false;
    this.argumentDisplacement = 0;
    this.argumentImmediate = 0;
    this.argumentRead = 0;
    this.argumentWrite = 0;
    this.mnemonic = '';
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putText(ss: bigint, classIndex: number, text: string): void {
    this.put(ss, this.samplenum, this.outAnn, [classIndex, [text]]);
  }

  private putDisassembly(): void {
    const text = formatMnemonic(this.mnemonic, {
      r: this.indexRegister,
      d: this.argumentDisplacement,
      j: this.argumentDisplacement + this.instructionLength,
      i: this.argumentImmediate,
      ro: this.argumentRead,
      wo: this.argumentWrite,
    });
    this.putText(this.disassemblyStart, this.annotationDisassembly!, text);
    this.annotationDisassembly = null;
    this.disassemblyStart = this.samplenum;
  }

  private onCycleBegin(address: number | null): void {
    if (this.pendingAddress !== null)
      this.putText(this.addressStart, Z80_ANN.ADDRESS, this.pendingAddress.toString(16).toUpperCase().padStart(4, '0'));
    this.addressStart = this.samplenum;
    this.pendingAddress = address;
  }

  private onCycleEnd(): void {
    this.instructionLength++;
    let next = this.executeState();
    if (this.annotationDisassembly !== null) this.putDisassembly();
    if (next === 'RESTART') next = this.stateIdle();
    if (this.annotationData !== null && this.pendingData !== null)
      this.putText(this.dataStart, this.annotationData, this.pendingData.toString(16).toUpperCase().padStart(2, '0'));
    this.dataStart = this.samplenum;
    this.pendingData = this.busData;
    this.annotationData = DATA_CYCLE_ANNOTATION[this.previousCycle];
    this.opState = next;
  }

  private onCycleTransition(): void {
    const ss = this.samplenum > 0n ? this.samplenum - 1n : this.samplenum;
    this.putText(ss, Z80_ANN.WARNING, 'Illegal transition between control states');
    this.pendingAddress = null;
    this.annotationData = null;
    this.annotationDisassembly = null;
  }

  private executeState(): OpState {
    switch (this.opState) {
      case 'IDLE':
        return this.stateIdle();
      case 'PRE1':
        return this.statePrefix1();
      case 'PRE2':
        return this.statePrefix2();
      case 'PREDIS':
        return this.statePrefixDisplacement();
      case 'OPCODE':
        return this.stateOpcode();
      case 'POSTDIS':
        return this.statePostDisplacement();
      case 'IMM1':
        return this.stateImmediate1();
      case 'IMM2':
        return this.stateImmediate2();
      case 'ROP1':
        return this.stateReadOperand1();
      case 'ROP2':
        return this.stateReadOperand2();
      case 'WOP1':
        return this.stateWriteOperand1();
      case 'WOP2':
        return this.stateWriteOperand2();
      default:
        return 'RESTART';
    }
  }

  private stateIdle(): OpState {
    if (this.previousCycle !== Cycle.Fetch) return 'IDLE';
    this.wantDisplacement = 0;
    this.wantImmediate = 0;
    this.wantRead = 0;
    this.wantWrite = 0;
    this.wantWriteBigEndian = false;
    this.repeat = false;
    this.argumentDisplacement = 0;
    this.argumentImmediate = 0;
    this.argumentRead = 0;
    this.argumentWrite = 0;
    this.indexRegister = '';
    this.mnemonic = '';
    this.disassemblyStart = this.samplenum;
    this.operandPrefix = 0;
    this.instructionLength = 0;
    if (this.busData !== null && [0xcb, 0xed, 0xdd, 0xfd].includes(this.busData)) return 'PRE1';
    return 'OPCODE';
  }

  private statePrefix1(): OpState {
    if (this.previousCycle !== Cycle.Fetch) {
      this.mnemonic = 'Prefix not followed by fetch';
      this.annotationDisassembly = Z80_ANN.WARNING;
      return 'RESTART';
    }
    this.operandPrefix = this.pendingData ?? 0;
    if (this.operandPrefix === 0xdd || this.operandPrefix === 0xfd) {
      if (this.busData === 0xcb) return 'PRE2';
      if (this.busData === 0xdd || this.busData === 0xed || this.busData === 0xfd) return 'PRE1';
    }
    return 'OPCODE';
  }

  private statePrefix2(): OpState {
    if (this.previousCycle !== Cycle.MemRead) {
      this.mnemonic = 'Missing displacement';
      this.annotationDisassembly = Z80_ANN.WARNING;
      return 'RESTART';
    }
    this.operandPrefix = (this.operandPrefix << 8) | (this.pendingData ?? 0);
    return 'PREDIS';
  }

  private statePrefixDisplacement(): OpState {
    if (this.previousCycle !== Cycle.MemRead) {
      this.mnemonic = 'Missing opcode';
      this.annotationDisassembly = Z80_ANN.WARNING;
      return 'RESTART';
    }
    this.argumentDisplacement = signedByte(this.pendingData ?? 0);
    return 'OPCODE';
  }

  private stateOpcode(): OpState {
    const selected = INSTRUCTION_TABLES.get(this.operandPrefix);
    this.operandPrefix = 0;
    if (!selected) {
      this.mnemonic = 'Invalid instruction';
      this.annotationDisassembly = Z80_ANN.WARNING;
      return 'RESTART';
    }
    this.indexRegister = selected.indexRegister;
    const instruction = this.pendingData === null ? undefined : selected.table.get(this.pendingData);
    if (!instruction) {
      this.mnemonic = 'Invalid instruction';
      this.annotationDisassembly = Z80_ANN.WARNING;
      return 'RESTART';
    }
    this.wantDisplacement = instruction.displacement;
    this.wantImmediate = instruction.immediate;
    this.wantRead = instruction.read;
    this.wantWrite = Math.abs(instruction.write);
    this.wantWriteBigEndian = instruction.write < 0;
    this.repeat = instruction.repeat;
    this.mnemonic = instruction.mnemonic;
    if (this.wantDisplacement > 0) return 'POSTDIS';
    if (this.wantImmediate > 0) return 'IMM1';
    this.annotationDisassembly = Z80_ANN.INSTR;
    if (this.wantRead > 0 && (this.previousCycle === Cycle.MemRead || this.previousCycle === Cycle.IoRead))
      return 'ROP1';
    if (this.wantWrite > 0 && (this.previousCycle === Cycle.MemWrite || this.previousCycle === Cycle.IoWrite))
      return 'WOP1';
    return 'RESTART';
  }

  private statePostDisplacement(): OpState {
    this.argumentDisplacement = signedByte(this.pendingData ?? 0);
    if (this.wantImmediate > 0) return 'IMM1';
    this.annotationDisassembly = Z80_ANN.INSTR;
    if (this.wantRead > 0 && (this.previousCycle === Cycle.MemRead || this.previousCycle === Cycle.IoRead))
      return 'ROP1';
    if (this.wantWrite > 0 && (this.previousCycle === Cycle.MemWrite || this.previousCycle === Cycle.IoWrite))
      return 'WOP1';
    return 'RESTART';
  }

  private stateImmediate1(): OpState {
    this.argumentImmediate = this.pendingData ?? 0;
    if (this.wantImmediate > 1) return 'IMM2';
    this.annotationDisassembly = Z80_ANN.INSTR;
    if (this.wantRead > 0 && (this.previousCycle === Cycle.MemRead || this.previousCycle === Cycle.IoRead))
      return 'ROP1';
    if (this.wantWrite > 0 && (this.previousCycle === Cycle.MemWrite || this.previousCycle === Cycle.IoWrite))
      return 'WOP1';
    return 'RESTART';
  }

  private stateImmediate2(): OpState {
    this.argumentImmediate |= (this.pendingData ?? 0) << 8;
    this.annotationDisassembly = Z80_ANN.INSTR;
    if (this.wantRead > 0 && (this.previousCycle === Cycle.MemRead || this.previousCycle === Cycle.IoRead))
      return 'ROP1';
    if (this.wantWrite > 0 && (this.previousCycle === Cycle.MemWrite || this.previousCycle === Cycle.IoWrite))
      return 'WOP1';
    return 'RESTART';
  }

  private stateReadOperand1(): OpState {
    this.argumentRead = this.pendingData ?? 0;
    if (this.wantRead < 2) {
      this.mnemonic = '{ro:02X}';
      this.annotationDisassembly = Z80_ANN.READ_OPERAND;
    }
    if (this.wantWrite > 0) return 'WOP1';
    if (this.wantRead > 1) return 'ROP2';
    if (this.repeat && (this.previousCycle === Cycle.MemRead || this.previousCycle === Cycle.IoRead)) return 'ROP1';
    return 'RESTART';
  }

  private stateReadOperand2(): OpState {
    this.argumentRead |= (this.pendingData ?? 0) << 8;
    this.mnemonic = '{ro:04X}';
    this.annotationDisassembly = Z80_ANN.READ_OPERAND;
    if (this.wantWrite > 0 && (this.previousCycle === Cycle.MemWrite || this.previousCycle === Cycle.IoWrite))
      return 'WOP1';
    return 'RESTART';
  }

  private stateWriteOperand1(): OpState {
    this.argumentWrite = this.pendingData ?? 0;
    if (this.wantRead > 1) return 'ROP2';
    if (this.wantWrite > 1) return 'WOP2';
    this.mnemonic = '{wo:02X}';
    this.annotationDisassembly = Z80_ANN.WRITE_OPERAND;
    if (
      this.wantRead > 0 &&
      this.repeat &&
      (this.previousCycle === Cycle.MemRead || this.previousCycle === Cycle.IoRead)
    )
      return 'ROP1';
    return 'RESTART';
  }

  private stateWriteOperand2(): OpState {
    this.argumentWrite = this.wantWriteBigEndian
      ? (this.argumentWrite << 8) | (this.pendingData ?? 0)
      : this.argumentWrite | ((this.pendingData ?? 0) << 8);
    this.mnemonic = '{wo:04X}';
    this.annotationDisassembly = Z80_ANN.WRITE_OPERAND;
    return 'RESTART';
  }

  *decode(): LogicGenerator {
    let pins = yield this.wait();
    while (true) {
      let cycle = Cycle.None;
      const mreq = Number(pins[11]);
      if (mreq !== 1) {
        if (Number(pins[9]) === 0) cycle = Number(pins[8]) === 0 ? Cycle.Fetch : Cycle.MemRead;
        else if (Number(pins[10]) === 0) cycle = Cycle.MemWrite;
      } else if (Number(pins[12]) === 0) {
        if (Number(pins[8]) === 0) cycle = Cycle.InterruptAck;
        else if (Number(pins[9]) === 0) cycle = Cycle.IoRead;
        else if (Number(pins[10]) === 0) cycle = Cycle.IoWrite;
      }
      if (cycle !== Cycle.None) this.busData = reduceBus(pins.slice(0, 8));
      if (cycle !== this.previousCycle) {
        if (this.previousCycle === Cycle.None) this.onCycleBegin(reduceBus(pins.slice(13, 29)));
        else if (cycle === Cycle.None) this.onCycleEnd();
        else this.onCycleTransition();
      }
      this.previousCycle = cycle;
      pins = yield this.wait();
    }
  }
}

export default Z80Decoder;
