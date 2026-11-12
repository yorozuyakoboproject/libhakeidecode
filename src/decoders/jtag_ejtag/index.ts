import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import type { JtagBitstring, JtagProtocolPacket } from '../jtag/index.js';
import { descriptor } from './descriptor.js';

const STATE = Object.freeze({
  RESET: 0,
  DEVICE_ID: 1,
  IMPLEMENTATION: 2,
  DATA: 3,
  ADDRESS: 4,
  CONTROL: 5,
  FASTDATA: 6,
  PC_SAMPLE: 7,
  BYPASS: 8,
} as const);
type EjtagState = (typeof STATE)[keyof typeof STATE];

const ANN = Object.freeze({
  INSTRUCTION: 0,
  REGISTER: 1,
  CONTROL_FIELD_IN: 10,
  CONTROL_FIELD_OUT: 11,
  PRACC: 12,
} as const);

export const EJTAG_INSTRUCTIONS: Readonly<Record<number, readonly [name: string, description: string]>> = {
  0x00: ['Free', 'Boundary scan'],
  0x01: ['IDCODE', 'Select Device Identification (ID) register'],
  0x02: ['Free', 'Boundary scan'],
  0x03: ['IMPCODE', 'Select Implementation register'],
  0x08: ['ADDRESS', 'Select Address register'],
  0x09: ['DATA', 'Select Data register'],
  0x0a: ['CONTROL', 'Select EJTAG Control register'],
  0x0b: ['ALL', 'Select the Address, Data and EJTAG Control registers'],
  0x0c: ['EJTAGBOOT', 'Fetch code from the debug exception vector after reset'],
  0x0d: ['NORMALBOOT', 'Execute the reset handler after reset'],
  0x0e: ['FASTDATA', 'Select the Data and Fastdata registers'],
  0x0f: ['Reserved', 'Reserved'],
  0x10: ['TCBCONTROLA', 'Select the control register TCBTraceControl'],
  0x11: ['TCBCONTROLB', 'Selects trace control block register B'],
  0x12: ['TCBDATA', 'Access the registers specified by TCBCONTROLB'],
  0x13: ['TCBCONTROLC', 'Select trace control block register C'],
  0x14: ['PCSAMPLE', 'Select the PCsample register'],
  0x15: ['TCBCONTROLD', 'Select trace control block register D'],
  0x16: ['TCBCONTROLE', 'Select trace control block register E'],
  0x17: ['FDC', 'Select Fast Debug Channel'],
  0x1c: ['Free', 'Boundary scan'],
};

export const EJTAG_REGISTERS = [
  'RESET',
  'DEVICE_ID',
  'IMPLEMENTATION',
  'DATA',
  'ADDRESS',
  'CONTROL',
  'FASTDATA',
  'PC_SAMPLE',
  'BYPASS',
] as const;

const STATE_FROM_INSTRUCTION: Readonly<Record<number, EjtagState>> = {
  0x01: STATE.DEVICE_ID,
  0x03: STATE.IMPLEMENTATION,
  0x08: STATE.ADDRESS,
  0x09: STATE.DATA,
  0x0a: STATE.CONTROL,
  0x0e: STATE.FASTDATA,
};

interface ControlField {
  readonly msb: number;
  readonly lsb: number;
  readonly name: string;
  readonly read: readonly string[];
  readonly write?: readonly string[];
}

export const EJTAG_CONTROL_FIELDS: readonly ControlField[] = [
  {
    msb: 31,
    lsb: 31,
    name: 'Rocc',
    read: ['No reset ocurred', 'Reset ocurred'],
    write: ['Acknowledge reset', 'No effect'],
  },
  { msb: 30, lsb: 29, name: 'Psz', read: ['Access: byte', 'Access: halfword', 'Access: word', 'Access: triple'] },
  { msb: 23, lsb: 23, name: 'VPED', read: ['VPE disabled', 'VPE enabled'] },
  { msb: 22, lsb: 22, name: 'Doze', read: ['Processor is not in low-power mode', 'Processor is in low-power mode'] },
  {
    msb: 21,
    lsb: 21,
    name: 'Halt',
    read: ['Internal system bus clock is running', 'Internal system bus clock is stopped'],
  },
  {
    msb: 20,
    lsb: 20,
    name: 'Per Rst',
    read: ['No peripheral reset applied', 'Peripheral reset applied'],
    write: ['Deassert peripheral reset', 'Assert peripheral reset'],
  },
  { msb: 19, lsb: 19, name: 'PRn W', read: ['Read processor access', 'Write processor access'] },
  {
    msb: 18,
    lsb: 18,
    name: 'Pr Acc',
    read: ['No pending processor access', 'Pending processor access'],
    write: ['Finish processor access', "Don't finish processor access"],
  },
  {
    msb: 16,
    lsb: 16,
    name: 'Pr Rst',
    read: ['No processor reset applied', 'Processor reset applied'],
    write: ['Deassert processor reset', 'Assert system reset'],
  },
  {
    msb: 15,
    lsb: 15,
    name: 'Prob En',
    read: ['Probe will not serve processor accesses', 'Probe will service processor accesses'],
  },
  {
    msb: 14,
    lsb: 14,
    name: 'Prob Trap',
    read: ['Default location', 'DMSEG fetch'],
    write: ['Set to default location', 'Set to DMSEG fetch'],
  },
  {
    msb: 13,
    lsb: 13,
    name: 'ISA On Debug',
    read: ['MIPS32/MIPS64 ISA', 'microMIPS ISA'],
    write: ['Set to MIPS32/MIPS64 ISA', 'Set to microMIPS ISA'],
  },
  {
    msb: 12,
    lsb: 12,
    name: 'EJTAG Brk',
    read: ['No pending debug interrupt', 'Pending debug interrupt'],
    write: ['No effect', 'Request debug interrupt'],
  },
  { msb: 3, lsb: 3, name: 'DM', read: ['Not in debug mode', 'In debug mode'] },
];

const FASTDATA_WRITE: Readonly<Record<number, readonly [string, string, string]>> = {
  0: ['0', 'SPrAcc: 0', 'Request completion of Fastdata access'],
  1: ['1', 'SPrAcc: 1', 'No effect'],
};
const FASTDATA_READ: Readonly<Record<number, readonly [string, string, string]>> = {
  0: ['0', 'SPrAcc: 0', 'Fastdata access failure'],
  1: ['1', 'SPrAcc: 1', 'Successful completion of Fastdata access'],
};

interface RegisterData {
  ss: bigint;
  es: bigint;
  data: JtagBitstring;
}

interface LastData {
  in?: RegisterData;
  out?: RegisterData;
}

interface PraccState {
  addressOut: number | null;
  dataIn: number | null;
  dataOut: number | null;
  ss: bigint;
  es: bigint;
}

function bitsToInt(bits: string): number {
  return bits ? Number.parseInt(bits, 2) : 0;
}

function hexByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

function hexWord(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

export class JtagEjtagDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private state: EjtagState = STATE.RESET;
  private lastData: LastData | null = null;
  private pracc: PraccState = this.newPracc();
  private packetSs = 0n;
  private packetEs = 0n;

  private newPracc(): PraccState {
    return { addressOut: null, dataIn: null, dataOut: null, ss: 0n, es: 0n };
  }

  override reset(): void {
    this.state = STATE.RESET;
    this.pracc = this.newPracc();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putAt(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private selectRegister(instruction: number): void {
    this.state = STATE_FROM_INSTRUCTION[instruction] ?? STATE.RESET;
  }

  private handleIrTdi(bits: JtagBitstring): void {
    const code = bitsToInt(bits[0]);
    const instruction = EJTAG_INSTRUCTIONS[code];
    if (instruction) {
      const hex = hexByte(code);
      this.putAt(this.packetSs, this.packetEs, ANN.INSTRUCTION, [
        `${instruction[0]}: ${instruction[1]} (${hex})`,
        instruction[0],
      ]);
    } else {
      const hex = hexByte(code);
      this.putAt(this.packetSs, this.packetEs, ANN.INSTRUCTION, [hex, `IR TDI (${hex})`]);
    }
    this.selectRegister(code);
  }

  private handleDrTdi(bits: JtagBitstring): void {
    const value = bitsToInt(bits[0]);
    this.lastData ??= {};
    this.lastData.in = { ss: this.packetSs, es: this.packetEs, data: bits };
    this.pracc.ss = this.packetSs;
    this.pracc.es = this.packetEs;
    if (this.state === STATE.DATA) this.pracc.dataIn = value;
    else if (this.state === STATE.FASTDATA) this.handleFastdata(bits, ANN.CONTROL_FIELD_IN);
  }

  private handleDrTdo(bits: JtagBitstring): void {
    const value = bitsToInt(bits[0]);
    this.lastData ??= {};
    this.lastData.out = { ss: this.packetSs, es: this.packetEs, data: bits };
    if (this.state === STATE.ADDRESS) this.pracc.addressOut = value;
    else if (this.state === STATE.DATA) this.pracc.dataOut = value;
    else if (this.state === STATE.FASTDATA) this.handleFastdata(bits, ANN.CONTROL_FIELD_OUT);
  }

  private handleFastdata(bits: JtagBitstring, ann: number): void {
    const [dataString, positions] = bits;
    if (dataString.length < 33 || positions.length < 33) return;
    const state = Number.parseInt(dataString[32]!, 2);
    const data = bitsToInt(dataString.slice(0, 32));
    const statePosition = positions[32]!;
    const firstData = positions[31]!;
    const lastData = positions[0]!;
    const descriptions = ann === ANN.CONTROL_FIELD_IN ? FASTDATA_WRITE : FASTDATA_READ;
    this.putAt(statePosition[0], statePosition[1], ann, [...descriptions[state]!]);
    this.putAt(firstData[0], lastData[1], ann, [hexWord(data)]);
  }

  private parseControlRegister(ann: number): void {
    const write = ann === ANN.CONTROL_FIELD_IN;
    const register = this.lastData?.[write ? 'in' : 'out'];
    if (!register) return;
    const [, positions] = register.data;
    const data = register.data[0];
    for (const field of EJTAG_CONTROL_FIELDS) {
      const descriptions = write ? field.write : field.read;
      if (!descriptions?.length) continue;
      const startBit = 31 - field.lsb;
      const endBit = 31 - field.msb;
      const start = positions[startBit];
      const end = positions[endBit];
      if (!start || !end) continue;
      const valueString = data.slice(endBit, startBit + 1);
      const valueIndex = bitsToInt(valueString);
      this.putAt(start[0], end[1], ann, [descriptions[valueIndex] ?? '?', `${field.name}: ${valueString}`]);
    }
  }

  private parsePracc(): void {
    const input = this.lastData?.in;
    const output = this.lastData?.out;
    if (!input || !output) return;
    const controlIn = bitsToInt(input.data[0]);
    const controlOut = bitsToInt(output.data[0]);
    if ((controlIn & (1 << 18)) !== 0 || (controlOut & (1 << 18)) === 0) return;

    const write = (controlOut & (1 << 19)) !== 0;
    let text = `PrAcc: ${write ? 'Store' : 'Load/Fetch'}`;
    if (write) {
      if (this.pracc.addressOut !== null) text += `, A: ${hexWord(this.pracc.addressOut)}`;
      if (this.pracc.dataOut !== null) text += `, D: ${hexWord(this.pracc.dataOut)}`;
    } else {
      if (this.pracc.addressOut !== null) text += `, A: ${hexWord(this.pracc.addressOut)}`;
      if (this.pracc.dataIn !== null) text += `, D: ${hexWord(this.pracc.dataIn)}`;
    }
    const { ss, es } = this.pracc;
    this.pracc = this.newPracc();
    this.putAt(ss, es, ANN.PRACC, [text]);
  }

  private handleNewState(newState: unknown): void {
    if (newState !== 'UPDATE-DR' || !this.lastData?.in || this.state === STATE.RESET) return;
    const input = this.lastData.in;
    this.putAt(input.ss, input.es, ANN.REGISTER + this.state, [EJTAG_REGISTERS[this.state]!]);
    if (this.state !== STATE.CONTROL) return;
    if (input.data[1].length !== 32) {
      this.putAt(input.ss, input.es, ANN.REGISTER, ['Error: length != 32']);
      return;
    }
    this.parseControlRegister(ANN.CONTROL_FIELD_IN);
    this.parseControlRegister(ANN.CONTROL_FIELD_OUT);
    this.parsePracc();
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || typeof data[0] !== 'string') return;
    const packet = data as unknown as JtagProtocolPacket;
    this.packetSs = ss;
    this.packetEs = es;
    switch (packet[0]) {
      case 'IR TDI':
        this.handleIrTdi(packet[1] as JtagBitstring);
        return;
      case 'DR TDI':
        this.handleDrTdi(packet[1] as JtagBitstring);
        return;
      case 'DR TDO':
        this.handleDrTdo(packet[1] as JtagBitstring);
        return;
      case 'NEW STATE':
        this.handleNewState(packet[1]);
        return;
      default:
        return;
    }
  }
}

export default JtagEjtagDecoder;
