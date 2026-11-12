import { Decoder, OUTPUT_ANN, OUTPUT_BINARY, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

interface BitValue {
  value: number;
  ss: bigint;
  es: bigint;
}

interface AccumulatedByte {
  readonly value: number;
  readonly ss: bigint;
  readonly es: bigint;
}

interface ProcessState {
  ss: bigint;
  es: bigint;
  clk: number;
  io1: boolean;
}

type SleState = 'ATR' | 'CMD' | 'OUT' | 'PROC' | 'DATA' | null;

const RESET = 0;
const INTERRUPT = 1;
const START = 2;
const STOP = 3;
const BIT = 4;
const ATR_BYTE = 5;
const CMD_BYTE = 6;
const OUT_BYTE = 7;
const PROC_BYTE = 8;
const ATR_DATA = 9;
const CMD_DATA = 10;
const OUT_DATA = 11;
const PROC_DATA = 12;

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export class Sle44xxDecoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outBinary = -1;
  private samplerate: number | null = null;
  private readonly maxAddr = 256;
  private bits: BitValue[] = [];
  private atrBytes: AccumulatedByte[] | null = null;
  private cmdBytes: AccumulatedByte[] | null = null;
  private cmdProc = false;
  private outLen: number | null = null;
  private outBytes: AccumulatedByte[] | null = null;
  private procState: ProcessState | null = null;
  private state: SleState = null;

  override reset(): void {
    this.bits = [];
    this.atrBytes = null;
    this.cmdBytes = null;
    this.cmdProc = false;
    this.outLen = null;
    this.outBytes = null;
    this.procState = null;
    this.state = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
    this.reset();
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  *decode(): LogicGenerator {
    const conditions = [
      { rst: 'r' },
      { rst: 'f' },
      { rst: 'h', clk: 'r' },
      { rst: 'h', clk: 'f' },
      { rst: 'l', clk: 'r' },
      { rst: 'l', clk: 'f' },
      { clk: 'h', io: 'f' },
      { clk: 'h', io: 'r' },
      { rst: 'l', io: 'r' },
    ] as const;
    let ssReset: bigint | null = null;
    let esReset: bigint | null = null;
    let ssClk: bigint | null = null;
    let esClk: bigint | null = null;

    while (true) {
      const isOutgoing = this.state === 'OUT';
      const isProcessing = this.state === 'PROC';
      const pins = yield this.wait(conditions);
      const io = Number(pins[2]);
      const matched = this.matched ?? [];

      if (matched[0]) {
        this.flushQueued();
        ssReset = this.samplenum;
        esReset = ssClk = esClk = null;
        continue;
      }
      if (matched[1]) {
        esReset = this.samplenum;
        this.handleReset(ssReset ?? 0n, esReset, ssClk !== null && esClk !== null && ssClk !== 0n && esClk !== 0n);
        ssReset = esReset = ssClk = esClk = null;
        continue;
      }
      if (matched[2]) {
        ssClk = this.samplenum;
        esClk = null;
        continue;
      }
      if (matched[3]) {
        esClk = this.samplenum;
        continue;
      }
      if (matched[4]) {
        this.handleDataBit(this.samplenum, null, io);
        continue;
      }
      if (matched[5]) {
        this.handleDataBit(null, this.samplenum, null);
        continue;
      }
      if (isProcessing && matched[8]) {
        this.handleDataBit(this.samplenum, this.samplenum, io);
        continue;
      }
      if (!isOutgoing && !isProcessing) {
        if (matched[6]) {
          this.handleCommand(this.samplenum, true);
          continue;
        }
        if (matched[7]) {
          this.handleCommand(this.samplenum, false);
        }
      }
    }
  }

  private textForKind(kind: string, data = ''): readonly [number, readonly string[]] | null {
    switch (kind) {
      case 'RESET_SYM':
        return [RESET, ['Reset', 'R']];
      case 'INTR_SYM':
        return [INTERRUPT, ['Interrupt', 'Intr', 'I']];
      case 'START_SYM':
        return [START, ['Start', 'ST', 'S']];
      case 'STOP_SYM':
        return [STOP, ['Stop', 'SP', 'P']];
      case 'BIT_SYM':
        return [BIT, [data]];
      case 'ATR_BYTE':
        return [ATR_BYTE, [`Answer To Reset: ${data}`, `ATR: ${data}`, data]];
      case 'CMD_BYTE':
        return [CMD_BYTE, [`Command: ${data}`, `Cmd: ${data}`, data]];
      case 'OUT_BYTE':
        return [OUT_BYTE, [`Outgoing data: ${data}`, `Data: ${data}`, data]];
      case 'PROC_BYTE':
        return [PROC_BYTE, [`Internal processing: ${data}`, `Proc: ${data}`, data]];
      case 'ATR_DATA':
        return [ATR_DATA, [`Answer To Reset: ${data}`, `ATR: ${data}`, data]];
      case 'CMD_DATA':
        return [CMD_DATA, [`Command: ${data}`, `Cmd: ${data}`, data]];
      case 'OUT_DATA':
        return [OUT_DATA, [`Outgoing: ${data}`, `Out: ${data}`, data]];
      case 'PROC_DATA':
        return [PROC_DATA, [`Processing: ${data}`, `Proc: ${data}`, data]];
      default:
        return null;
    }
  }

  private putKind(ss: bigint, es: bigint, kind: string, data = ''): void {
    const text = this.textForKind(kind, data);
    if (text) this.put(ss, es, this.outAnn, text);
  }

  private accumulated(bytes: readonly AccumulatedByte[] | null): {
    ss: bigint;
    es: bigint;
    data: string;
  } | null {
    if (!bytes?.length) return null;
    return {
      ss: bytes[0]!.ss,
      es: bytes.at(-1)!.es,
      data: bytes.map((item) => hex2(item.value)).join(' '),
    };
  }

  private flushQueued(): void {
    const atr = this.accumulated(this.atrBytes);
    if (atr) this.putKind(atr.ss, atr.es, 'ATR_DATA', atr.data);
    const cmd = this.accumulated(this.cmdBytes);
    if (cmd) this.putKind(cmd.ss, cmd.es, 'CMD_DATA', cmd.data);
    const out = this.accumulated(this.outBytes);
    if (out) this.putKind(out.ss, out.es, 'OUT_DATA', out.data);
    if (this.procState) {
      const proc = this.procState;
      const usecs = this.samplerate ? Number(proc.es - proc.ss) / (this.samplerate / 1e6) : 0;
      const clocks = `${proc.clk} clocks, I/O ${proc.io1 ? 1 : 0}`;
      this.putKind(proc.ss, proc.es, 'PROC_DATA', usecs ? `${(usecs / 1000).toFixed(2)} ms, ${clocks}` : clocks);
    }
    this.atrBytes = null;
    this.cmdBytes = null;
    this.cmdProc = false;
    this.outLen = null;
    this.outBytes = null;
    this.procState = null;
    this.state = null;
  }

  private handleReset(ss: bigint, es: bigint, hasClock: boolean): void {
    this.flushQueued();
    this.putKind(ss, es, hasClock ? 'RESET_SYM' : 'INTR_SYM');
    this.bits = [];
    this.state = hasClock ? 'ATR' : null;
  }

  private handleCommand(ss: bigint, start: boolean): void {
    if (start) this.flushQueued();
    this.putKind(ss, ss, start ? 'START_SYM' : 'STOP_SYM');
    this.bits = [];
    this.state = start ? 'CMD' : 'DATA';
  }

  private command(
    ctrl: number,
    addr: number,
    data: number,
  ): {
    texts: readonly string[];
    length: number | null;
    processing: boolean;
  } {
    const a = hex2(addr);
    const d = hex2(data);
    switch (ctrl) {
      case 0x30:
        return { texts: [`read main memory, addr ${a}`, `RD-M @${a}`], length: this.maxAddr - addr, processing: false };
      case 0x31:
        return { texts: ['read security memory', 'RD-S'], length: 4, processing: false };
      case 0x33:
        return {
          texts: [`compare verification data, addr ${a}, data ${d}`, `CMP-V @${a} =${d}`],
          length: null,
          processing: true,
        };
      case 0x34:
        return { texts: [`read protection memory, addr ${a}`, `RD-P @${a}`], length: 4, processing: false };
      case 0x38:
        return {
          texts: [`update main memory, addr ${a}, data ${d}`, `WR-M @${a} =${d}`],
          length: null,
          processing: true,
        };
      case 0x39:
        return {
          texts: [`update security memory, addr ${a}, data ${d}`, `WR-S @${a} =${d}`],
          length: null,
          processing: true,
        };
      case 0x3c:
        return {
          texts: [`write protection memory, addr ${a}, data ${d}`, `WR-P @${a} =${d}`],
          length: null,
          processing: true,
        };
      default: {
        const c = hex2(ctrl);
        return {
          texts: [`unknown, ctrl ${c}, addr ${a}, data ${d}`, `UNK-${c} @${a}, =${d}`],
          length: null,
          processing: false,
        };
      }
    }
  }

  private handleDataByte(ss: bigint, es: bigint, data: number): void {
    if (this.state === 'ATR') {
      this.atrBytes ??= [];
      this.atrBytes.push({ value: data, ss, es });
      if (this.atrBytes.length === 4) this.flushQueued();
      return;
    }
    if (this.state === 'CMD') {
      this.cmdBytes ??= [];
      this.cmdBytes.push({ value: data, ss, es });
      if (this.cmdBytes.length === 3) {
        const command = this.command(this.cmdBytes[0]!.value, this.cmdBytes[1]!.value, this.cmdBytes[2]!.value);
        this.put(this.cmdBytes[0]!.ss, this.cmdBytes.at(-1)!.es, this.outAnn, [CMD_DATA, command.texts]);
        this.cmdBytes = [];
        this.outLen = command.length;
        this.cmdProc = command.processing;
        this.state = null;
      }
      return;
    }
    if (this.state === 'OUT') {
      this.outBytes ??= [];
      this.outBytes.push({ value: data, ss, es });
      if (this.outLen !== null && this.outBytes.length === this.outLen) this.flushQueued();
    }
  }

  private handleDataBit(ss: bigint | null, es: bigint | null, bit: number | null): void {
    if (this.state === 'DATA') {
      if (this.outLen) {
        this.state = 'OUT';
      } else if (this.cmdProc) {
        this.state = 'PROC';
        this.procState = {
          ss: ss || es || 0n,
          es: es || ss || 0n,
          clk: 0,
          io1: bit === 1,
        };
      } else {
        this.state = 'OUT';
      }
    }
    if (this.state === 'PROC') {
      const high = bit === 1;
      if (ss !== null && this.procState) {
        this.procState.es = ss > this.procState.es ? ss : this.procState.es;
        if (high) this.procState.io1 = true;
      }
      if (es !== null && this.procState) {
        this.procState.es = es > this.procState.es ? es : this.procState.es;
        this.procState.clk++;
        if (high) this.procState.io1 = true;
      }
      if (high) this.flushQueued();
      return;
    }

    if (ss !== null) {
      this.bits.push({ value: bit ?? 0, ss, es: es ?? ss });
      return;
    }
    if (es === null) {
      this.bits = [];
      return;
    }
    if (!this.bits.length) return;
    if (bit !== null) this.bits.at(-1)!.value = bit;
    this.bits.at(-1)!.es = es;
    const current = this.bits.at(-1)!;
    this.putKind(current.ss, current.es, 'BIT_SYM', `${current.value}`);
    if (this.bits.length < 8) return;

    const bits = this.bits.slice(0, 8);
    this.bits = [];
    let data = 0;
    for (let index = 0; index < 8; index++) data |= (bits[index]!.value & 1) << index;
    const ssByte = bits[0]!.ss;
    const esByte = bits[7]!.es;
    const kind = this.state ? `${this.state}_BYTE` : '';
    if (kind) this.putKind(ssByte, esByte, kind, hex2(data));
    this.put(ssByte, esByte, this.outBinary, [0, Uint8Array.of(data)]);
    this.handleDataByte(ssByte, esByte, data);
  }
}

export default Sle44xxDecoder;
