import { Decoder, OUTPUT_ANN, OUTPUT_BINARY } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

interface UartBit {
  readonly value: number;
  readonly ss: bigint;
  readonly es: bigint;
}

const ANN = Object.freeze({
  BIT: 0,
  START: 1,
  DATA: 2,
  PARITY_OK: 3,
  PARITY_ERR: 4,
  STOP_OK: 5,
  STOP_ERR: 6,
  BREAK: 7,
  OPCODE: 8,
  DATA_PROG: 9,
  DATA_DEV: 10,
  COMMAND: 14,
});

const OP = Object.freeze({
  LDS: 0,
  LD: 1,
  STS: 2,
  ST: 3,
  LDCS: 4,
  REPEAT: 5,
  STCS: 6,
  KEY: 7,
});

const POINTER_NICE = ['*(ptr)', '*(ptr++)', 'ptr', 'ptr++ (rsv)'] as const;
const POINTER_TERSE = ['*p', '*p++', 'p', '(rsv)'] as const;
const CONTROL_REGISTERS: Readonly<Record<number, string>> = { 0: 'status', 1: 'reset', 2: 'ctrl' };
const UART_TEXT = Object.freeze({
  START: ['Start bit', 'Start', 'S'],
  PARITY_OK: ['Parity OK', 'Par OK', 'P'],
  PARITY_ERR: ['Parity error', 'Par ERR', 'PE'],
  STOP_OK: ['Stop bit', 'Stop', 'T'],
  STOP_ERR: ['Stop bit error', 'Stop ERR', 'TE'],
  BREAK: ['Break condition', 'BREAK', 'BRK'],
});

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export class AvrPdiDecoder extends Decoder {
  static descriptor = descriptor;

  private outAnn = -1;
  private outBinary = -1;
  private ssCurrFall: bigint | null = null;
  private dataSample: number | null = null;
  private bits: UartBit[] = [];
  private zeroCount = 0;
  private zeroSs: bigint | null = null;
  private breakSs: bigint | null = null;
  private breakEs: bigint | null = null;
  private insnRepCount = 0;
  private insnOpcode: number | null = null;
  private insnWrCounts: number[] = [];
  private insnRdCounts: number[] = [];
  private insnDatBytes: number[] = [];
  private insnDatCount = 0;
  private insnSsData: bigint | null = null;
  private cmdSs: bigint | null = null;
  private cmdPartsNice: string[] = [];
  private cmdPartsTerse: string[] = [];

  constructor() {
    super();
    this.reset();
  }

  override reset(): void {
    this.ssCurrFall = null;
    this.dataSample = null;
    this.bits = [];
    this.zeroCount = 0;
    this.zeroSs = null;
    this.breakSs = null;
    this.breakEs = null;
    this.clearInstruction();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  private clearInstruction(): void {
    this.insnRepCount = 0;
    this.insnOpcode = null;
    this.insnWrCounts = [];
    this.insnRdCounts = [];
    this.insnDatBytes = [];
    this.insnDatCount = 0;
    this.insnSsData = null;
    this.cmdSs = null;
    this.cmdPartsNice = [];
    this.cmdPartsTerse = [];
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private handleByte(ss: bigint, es: bigint, byteValue: number | null): void {
    const isBreak = byteValue === null;
    if (isBreak) {
      this.cmdPartsNice.push('BREAK');
      this.cmdPartsTerse.push('BRK');
      this.cmdSs ??= ss;
      this.insnRepCount = 0;
    }

    if (this.insnOpcode === null && !isBreak) {
      const value = byteValue!,
        opcode = (value & 0xe0) >> 5,
        arg30 = value & 0x0f,
        arg32 = (value & 0x0c) >> 2,
        arg10 = value & 0x03;
      this.insnOpcode = opcode;
      this.cmdSs = ss;
      this.insnWrCounts = [];
      this.insnRdCounts = [];
      let mnemonics: string[];

      if (opcode === OP.LDS) {
        const widthAddress = arg32 + 1,
          widthData = arg10 + 1;
        this.insnWrCounts = [widthAddress];
        this.insnRdCounts = [widthData];
        mnemonics = [`Insn: LDS a${widthAddress}, m${widthData}`, `LDS a${widthAddress}, m${widthData}`, 'LDS'];
        this.cmdPartsNice = ['LDS'];
        this.cmdPartsTerse = ['LDS'];
      } else if (opcode === OP.LD) {
        const pointer = POINTER_NICE[arg32]!,
          pointerTerse = POINTER_TERSE[arg32]!,
          widthData = arg10 + 1;
        this.insnRdCounts = [widthData];
        if (this.insnRepCount) {
          for (let index = 0; index < this.insnRepCount; index++) this.insnRdCounts.push(widthData);
          this.insnRepCount = 0;
        }
        mnemonics = [`Insn: LD ${pointer} m${widthData}`, `LD ${pointer} m${widthData}`, 'LD'];
        this.cmdPartsNice = ['LD', pointer];
        this.cmdPartsTerse = ['LD', pointerTerse];
      } else if (opcode === OP.STS) {
        const widthAddress = arg32 + 1,
          widthData = arg10 + 1;
        this.insnWrCounts = [widthAddress, widthData];
        mnemonics = [`Insn: STS a${widthAddress}, i${widthData}`, `STS a${widthAddress}, i${widthData}`, 'STS'];
        this.cmdPartsNice = ['STS'];
        this.cmdPartsTerse = ['STS'];
      } else if (opcode === OP.ST) {
        const pointer = POINTER_NICE[arg32]!,
          pointerTerse = POINTER_TERSE[arg32]!,
          widthData = arg10 + 1;
        this.insnWrCounts = [widthData];
        if (this.insnRepCount) {
          for (let index = 0; index < this.insnRepCount; index++) this.insnWrCounts.push(widthData);
          this.insnRepCount = 0;
        }
        mnemonics = [`Insn: ST ${pointer} i${widthData}`, `ST ${pointer} i${widthData}`, 'ST'];
        this.cmdPartsNice = ['ST', pointer];
        this.cmdPartsTerse = ['ST', pointerTerse];
      } else if (opcode === OP.LDCS) {
        const register = CONTROL_REGISTERS[arg30] ?? `r${arg30}`;
        this.insnRdCounts = [1];
        mnemonics = [`Insn: LDCS ${register}, m1`, `LDCS ${register}, m1`, 'LDCS'];
        this.cmdPartsNice = ['LDCS', register];
        this.cmdPartsTerse = ['LDCS', String(arg30)];
      } else if (opcode === OP.STCS) {
        const register = CONTROL_REGISTERS[arg30] ?? `r${arg30}`;
        this.insnWrCounts = [1];
        mnemonics = [`Insn: STCS ${register}, i1`, `STCS ${register}, i1`, 'STCS'];
        this.cmdPartsNice = ['STCS', register];
        this.cmdPartsTerse = ['STCS', String(arg30)];
      } else if (opcode === OP.REPEAT) {
        const widthData = arg10 + 1;
        this.insnWrCounts = [widthData];
        mnemonics = [`Insn: REPEAT i${widthData}`, `REPEAT i${widthData}`, 'REP'];
        this.cmdPartsNice = ['REPEAT'];
        this.cmdPartsTerse = ['REP'];
      } else {
        this.insnWrCounts = [8];
        mnemonics = ['Insn: KEY i8', 'KEY i8', 'KEY'];
        this.cmdPartsNice = ['KEY'];
        this.cmdPartsTerse = ['KEY'];
      }

      this.annotate(ss, es, ANN.OPCODE, mnemonics);
      this.insnDatBytes = [];
      this.insnDatCount = this.insnWrCounts[0] ?? this.insnRdCounts[0] ?? 0;
      if (this.insnDatCount) return;
    }

    if (this.insnDatCount && !isBreak) {
      const value = byteValue!;
      if (!this.insnDatBytes.length) this.insnSsData = ss;
      this.insnDatBytes.push(value);
      this.insnDatCount--;
      if (this.insnDatCount) return;

      const dataSs = this.insnSsData ?? ss;
      let classIndex: number;
      if (this.insnWrCounts.length) {
        classIndex = ANN.DATA_PROG;
        this.insnWrCounts.shift();
      } else {
        classIndex = ANN.DATA_DEV;
        this.insnRdCounts.shift();
      }
      const digits = [...this.insnDatBytes]
          .reverse()
          .map((item) => hex(item))
          .join(''),
        dataHex = `0x${digits}`;
      this.annotate(dataSs, es, classIndex, [`Data: ${dataHex}`, dataHex, digits]);
      this.insnDatBytes = [];
      this.cmdPartsNice.push(dataHex);
      this.cmdPartsTerse.push(digits);
      this.insnDatCount = this.insnWrCounts[0] ?? this.insnRdCounts[0] ?? 0;
      if (this.insnDatCount) return;
    }

    const command = this.cmdPartsNice.join(' '),
      terse = this.cmdPartsTerse.join(' ');
    this.annotate(this.cmdSs ?? ss, es, ANN.COMMAND, [command, terse]);
    if (this.insnOpcode === OP.REPEAT && !isBreak) {
      const value = Number.parseInt(this.cmdPartsNice.at(-1)!, 16);
      if (Number.isFinite(value)) this.insnRepCount = value;
    }
    const repeat = this.insnRepCount;
    this.clearInstruction();
    this.insnRepCount = repeat;
  }

  private handleBits(ss: bigint, es: bigint, value: number): void {
    if (value === 1) this.zeroCount = 0;
    else {
      if (!this.zeroCount) this.zeroSs = ss;
      this.zeroCount++;
      if (this.zeroCount === 11) this.breakSs = this.zeroSs;
    }

    if (this.breakSs !== null) {
      if (value === 0) {
        this.breakEs = es;
        return;
      }
      this.annotate(this.breakSs, this.breakEs ?? es, ANN.BREAK, UART_TEXT.BREAK);
      this.handleByte(this.breakSs, this.breakEs ?? es, null);
      this.breakSs = null;
      this.breakEs = null;
      this.bits = [];
      return;
    }

    if (!this.bits.length && value === 1) return;
    this.bits.push({ value, ss, es });
    if (this.bits.length < 11) return;

    let encoded = 0;
    for (let index = 0; index < this.bits.length; index++) encoded |= this.bits[index]!.value << index;
    const data = (encoded >>> 1) & 0xff,
      parity = (encoded >>> 9) & 1,
      stop = (encoded >>> 10) & 1,
      parityOk = ((data.toString(2).replaceAll('0', '').length + parity) & 1) === 0,
      stopOk = stop === 1;

    for (const bit of this.bits) this.annotate(bit.ss, bit.es, ANN.BIT, [String(bit.value)]);
    this.annotate(this.bits[0]!.ss, this.bits[0]!.es, ANN.START, UART_TEXT.START);
    this.annotate(this.bits[1]!.ss, this.bits[8]!.es, ANN.DATA, [`Data: ${hex(data)}`, `D: ${hex(data)}`, hex(data)]);
    this.annotate(
      this.bits[9]!.ss,
      this.bits[9]!.es,
      parityOk ? ANN.PARITY_OK : ANN.PARITY_ERR,
      parityOk ? UART_TEXT.PARITY_OK : UART_TEXT.PARITY_ERR,
    );
    this.annotate(
      this.bits[10]!.ss,
      this.bits[10]!.es,
      stopOk ? ANN.STOP_OK : ANN.STOP_ERR,
      stopOk ? UART_TEXT.STOP_OK : UART_TEXT.STOP_ERR,
    );

    if (parityOk && stopOk) {
      const ssByte = this.bits[0]!.ss,
        esByte = this.bits[10]!.es;
      this.put(ssByte, esByte, this.outBinary, [0, Uint8Array.of(data)]);
      this.handleByte(ssByte, esByte, data);
    }
    this.bits = [];
  }

  *decode(): LogicGenerator {
    if (!this.hasChannel('reset') || !this.hasChannel('data')) throw new Error('RESET and DATA channels are required.');
    while (true) {
      const pins = yield this.wait({ reset: 'e' }),
        clock = Number(pins[0]),
        data = Number(pins[1]);
      if (clock === 1) {
        this.dataSample = data;
        continue;
      }
      const bitStart = this.ssCurrFall;
      this.ssCurrFall = this.samplenum;
      if (bitStart === null || this.dataSample === null) continue;
      this.handleBits(bitStart, this.samplenum, this.dataSample);
    }
  }
}

export default AvrPdiDecoder;
