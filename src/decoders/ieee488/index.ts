import { Decoder, OUTPUT_ANN, OUTPUT_BINARY, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pin, Pins, WaitCondition } from '../../libhakeidecode/index.js';
import type { WaitToken } from '../../libhakeidecode/wait.js';
import { descriptor } from './descriptor.js';

export interface Ieee488Options {
  iec_periph: string;
  delim: string;
  atn_parity: string;
}

const PIN_DIO1 = 0;
const PIN_DIO8 = 7;
const PIN_EOI = 8;
const PIN_DAV = 9;
const PIN_IFC = 12;
const PIN_ATN = 14;
const PIN_CLK = 16;

const ANN_RAW_BIT = 0;
const ANN_RAW_BYTE = 1;
const ANN_CMD = 2;
const ANN_LADDR = 3;
const ANN_TADDR = 4;
const ANN_SADDR = 5;
const ANN_DATA = 6;
const ANN_EOI = 7;
const ANN_PP = 8;
const ANN_TEXT = 9;
const ANN_IEC_PERIPH = 10;
const ANN_WARN = 11;
const BIN_RAW = 0;
const BIN_DATA = 1;

const COMMANDS = new Map<number, readonly string[]>([
  [0x01, ['Go To Local', 'GTL']],
  [0x04, ['Selected Device Clear', 'SDC']],
  [0x05, ['Parallel Poll Configure', 'PPC']],
  [0x08, ['Global Execute Trigger', 'GET']],
  [0x09, ['Take Control', 'TCT']],
  [0x11, ['Local Lock Out', 'LLO']],
  [0x14, ['Device Clear', 'DCL']],
  [0x15, ['Parallel Poll Unconfigure', 'PPU']],
  [0x18, ['Serial Poll Enable', 'SPE']],
  [0x19, ['Serial Poll Disable', 'SPD']],
  [0x3f, ['Unlisten', 'UNL']],
  [0x5f, ['Untalk', 'UNT']],
]);

const CONTROL_CODES: Readonly<Record<number, string>> = {
  0x00: 'NUL',
  0x01: 'SOH',
  0x02: 'STX',
  0x03: 'ETX',
  0x04: 'EOT',
  0x05: 'ENQ',
  0x06: 'ACK',
  0x07: 'BEL',
  0x08: 'BS',
  0x09: 'TAB',
  0x0a: 'LF',
  0x0b: 'VT',
  0x0c: 'FF',
  0x0d: 'CR',
  0x0e: 'SO',
  0x0f: 'SI',
  0x10: 'DLE',
  0x11: 'DC1',
  0x12: 'DC2',
  0x13: 'DC3',
  0x14: 'DC4',
  0x15: 'NAK',
  0x16: 'SYN',
  0x17: 'ETB',
  0x18: 'CAN',
  0x19: 'EM',
  0x1a: 'SUB',
  0x1b: 'ESC',
  0x1c: 'FS',
  0x1d: 'GS',
  0x1e: 'RS',
  0x1f: 'US',
};

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function commandTexts(value: number): { known: boolean; texts: string[] } {
  const known = COMMANDS.get(value);
  if (known) return { known: true, texts: [...known] };
  const text = hex2(value);
  return {
    known: false,
    texts: [`Unknown command 0x${text}`, `command 0x${text}`, `cmd ${text}`, `C${String.fromCharCode(48 + value)}`],
  };
}

function addressTexts(value: number): string[] {
  const listen = value >= 0x20 && value < 0x40 ? value & 0x1f : null;
  const talk = value >= 0x40 && value < 0x60 ? value & 0x1f : null;
  const secondary = value >= 0x60 && value < 0x80 ? value & 0x1f : null;
  const msb = value & 0x80 ? value : null;
  if (listen !== null) return [`Listen ${listen}`, `L ${listen}`, `L${String.fromCharCode(48 + listen)}`];
  if (talk !== null) return [`Talk ${talk}`, `T ${talk}`, `T${String.fromCharCode(48 + talk)}`];
  if (secondary !== null)
    return [`Secondary ${secondary}`, `S ${secondary}`, `S${String.fromCharCode(48 + secondary)}`];
  if (msb !== null) return [`Secondary ${msb}`, `S ${msb}`, `S${String.fromCharCode(48 + msb)}`];
  return [];
}

function dataText(value: number): string {
  if (value >= 0x20 && value < 0x7f) return String.fromCharCode(value);
  const control = CONTROL_CODES[value];
  return control ? `[${control}]` : `[${hex2(value)}]`;
}

function invertPin(pin: Pin): number {
  return pin === 0 || pin === 1 ? 1 - pin : 255;
}

function invertPins(pins: readonly Pin[]): number[] {
  return pins.map(invertPin);
}

function bitpack(bits: readonly number[]): number {
  let value = 0;
  for (let index = 0; index < bits.length; index++) value |= (bits[index]! & 1) << index;
  return value;
}

export class Ieee488Decoder extends Decoder<Ieee488Options> {
  static descriptor = descriptor;
  private outAnn = -1;
  private outBin = -1;
  private outProtocol = -1;
  private currRaw: number | null = null;
  private currAtn: number | null = null;
  private currEoi: number | null = null;
  private latchEoi: number | null = null;
  private accuBytes: number[] = [];
  private accuText: string[] = [];
  private ssRaw: bigint | null = null;
  private esRaw: bigint | null = null;
  private ssEoi: bigint | null = null;
  private esEoi: bigint | null = null;
  private ssText: bigint | null = null;
  private esText: bigint | null = null;
  private ssPp: bigint | null = null;
  private dioPp: number[] = [];
  private lastTalker: number | null = null;
  private lastListener: number[] = [];
  private lastIecAddr: number | null = null;
  private lastIecSec: number | null = null;

  override reset(): void {
    this.currRaw = null;
    this.currAtn = null;
    this.currEoi = null;
    this.latchEoi = null;
    this.accuBytes = [];
    this.accuText = [];
    this.ssRaw = null;
    this.esRaw = null;
    this.ssEoi = null;
    this.esEoi = null;
    this.ssText = null;
    this.esText = null;
    this.ssPp = null;
    this.dioPp = [];
    this.lastTalker = null;
    this.lastListener = [];
    this.lastIecAddr = null;
    this.lastIecSec = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBin = this.register(OUTPUT_BINARY);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]);
  }

  private putg(ss: bigint, es: bigint, data: unknown): void {
    this.put(ss, es, this.outAnn, data);
  }

  private putpy(ss: bigint, es: bigint, ptype: string, addr: number | null, pdata: unknown): void {
    this.put(ss, es, this.outProtocol, [ptype, addr, pdata]);
  }

  private putbin(ss: bigint, es: bigint, classIndex: number, bytes: Uint8Array): void {
    this.put(ss, es, this.outBin, [classIndex, bytes]);
  }

  private emitEoi(ss: bigint, es: bigint): void {
    this.putg(ss, es, [ANN_EOI, ['EOI']]);
  }

  private emitWarning(ss: bigint, es: bigint, texts: readonly string[]): void {
    this.putg(ss, es, [ANN_WARN, texts]);
  }

  private flushBytesTextAccu(): void {
    if (this.accuBytes.length && this.ssText !== null && this.esText !== null) {
      const bytes = Uint8Array.from(this.accuBytes);
      this.putbin(this.ssText, this.esText, BIN_DATA, bytes);
      this.putpy(this.ssText, this.esText, 'TALKER_BYTES', this.lastTalker, bytes);
      this.accuBytes = [];
    }
    if (this.accuText.length && this.ssText !== null && this.esText !== null) {
      const text = this.accuText.join('');
      this.putg(this.ssText, this.esText, [ANN_TEXT, [text]]);
      this.putpy(this.ssText, this.esText, 'TALKER_TEXT', this.lastTalker, text);
      this.accuText = [];
    }
    this.ssText = null;
    this.esText = null;
  }

  private checkExtraFlush(value: number): void {
    if (this.options.delim === 'none' || !this.accuBytes.length) return;
    const terminator = value === 10 || value === 13;
    const previousTerminator = this.accuBytes.at(-1) === 10 || this.accuBytes.at(-1) === 13;
    if (previousTerminator && !terminator) this.flushBytesTextAccu();
  }

  private checkPp(dio?: readonly number[]): 'enter' | 'leave' | 'keep' | 'idle' {
    const capture = Boolean(this.currAtn && this.currEoi);
    const collecting = this.ssPp !== null;
    if (capture && !collecting) {
      this.ssPp = this.samplenum;
      this.dioPp = [];
      return 'enter';
    }
    if (!capture && collecting) {
      const ss = this.ssPp!;
      const es = this.samplenum;
      const bits = this.dioPp;
      this.ssPp = null;
      this.dioPp = [];
      if (ss === es) return 'leave';
      const positions = bits.flatMap((value, index) => (value ? [index] : []));
      const dios = positions.map((index) => `DIO${index + 1}`);
      this.putg(ss, es, [
        ANN_PP,
        [`PPOLL ${dios.length ? dios.join(' ') : '-'}`, `PP ${positions.map((index) => index + 1).join(' ')}`, 'PP'],
      ]);
      this.putpy(ss, es, 'PPOLL', null, positions);
      return 'leave';
    }
    if (collecting) {
      for (let index = 0; index < (dio?.length ?? 0); index++)
        this.dioPp[index] = (this.dioPp[index] ?? 0) | dio![index]!;
      return 'keep';
    }
    return 'idle';
  }

  private handleIfcChange(ifc: number): void {
    if (!ifc) return;
    this.lastTalker = null;
    this.lastListener = [];
    this.flushBytesTextAccu();
  }

  private handleEoiChange(eoi: number): void {
    if (eoi) {
      this.ssEoi = this.samplenum;
      this.currEoi = eoi;
      return;
    }
    this.esEoi = this.samplenum;
    if (this.ssEoi !== null && this.latchEoi) this.emitEoi(this.ssEoi, this.esEoi);
    if (this.esEoi !== null) this.esText = this.esEoi;
    this.flushBytesTextAccu();
    this.ssEoi = null;
    this.esEoi = null;
    this.currEoi = null;
  }

  private handleAtnChange(atn: number): void {
    this.currAtn = atn;
    if (atn) this.flushBytesTextAccu();
  }

  private handleIecPeriph(
    ss: bigint,
    es: bigint,
    addr: number | null,
    secondary: number | null,
    _data: number | null,
  ): void {
    if (this.options.iec_periph !== 'yes') return;
    if (addr === null && secondary === null && _data === null) {
      this.lastIecAddr = null;
      this.lastIecSec = null;
      return;
    }
    if (addr !== null) {
      this.lastIecAddr = addr;
      const name = addr === 8 ? 'Disk 0' : addr === 9 ? 'Disk 1' : null;
      if (name) this.putg(ss, es, [ANN_IEC_PERIPH, [name]]);
    }
    const currentAddr = this.lastIecAddr;
    if (secondary !== null) {
      this.lastIecSec = secondary;
      const subcommand = secondary & 0xf0;
      const channel = secondary & 0x0f;
      if (currentAddr !== null && currentAddr >= 8 && currentAddr < 16) {
        const suffix = String.fromCharCode(48 + channel);
        const texts =
          subcommand === 0x60
            ? [`Reopen ${channel}`, `Re ${channel}`, `R${suffix}`]
            : subcommand === 0xe0
              ? [`Close ${channel}`, `Cl ${channel}`, `C${suffix}`]
              : subcommand === 0xf0
                ? [`Open ${channel}`, `Op ${channel}`, `O${suffix}`]
                : null;
        if (texts) this.putg(ss, es, [ANN_IEC_PERIPH, texts]);
      }
    }
  }

  private handleDataByte(): void {
    if (this.currRaw === null || this.ssRaw === null || this.esRaw === null) return;
    const listening = Boolean(this.currAtn);
    if (!listening) this.checkExtraFlush(this.currRaw);
    let value = this.currRaw;
    const rawText = `${listening ? '/' : ''}${hex2(value)}`;
    this.putg(this.ssRaw, this.esRaw, [ANN_RAW_BYTE, [rawText]]);
    this.putbin(this.ssRaw, this.esRaw, BIN_RAW, Uint8Array.of(value));
    this.putpy(this.ssRaw, this.esRaw, 'GPIB_RAW', null, value | (listening ? 0x100 : 0));

    if (!listening) {
      this.accuBytes.push(value);
      if (!this.accuText.length) this.ssText = this.ssRaw;
      this.accuText.push(dataText(value));
      this.esText = this.esRaw;
      this.putg(this.ssRaw, this.esRaw, [ANN_DATA, [dataText(value)]]);
      this.handleIecPeriph(this.ssRaw, this.esRaw, null, null, value);
      this.putpy(this.ssRaw, this.esRaw, 'DATA_BYTE', this.lastTalker, value);
      return;
    }

    if (this.options.atn_parity === 'yes') {
      const parity = value & 0x80 ? 1 : 0;
      value &= ~0x80;
      let ones = parity;
      for (let bits = value; bits; bits >>>= 1) ones += bits & 1;
      if (ones & 1) this.emitWarning(this.ssRaw, this.esRaw, ['Command parity error', 'parity', 'PAR']);
    }

    const isCommand =
      (value >= 0x00 && value < 0x20) ||
      (value >= 0x20 && value < 0x40 && (value & 0x1f) === 31) ||
      (value >= 0x40 && value < 0x60 && (value & 0x1f) === 31);
    const unlisten = isCommand && value >= 0x20 && value < 0x40;
    const untalk = isCommand && value >= 0x40 && value < 0x60;
    const listen = value >= 0x20 && value < 0x40 ? value & 0x1f : null;
    const talk = value >= 0x40 && value < 0x60 ? value & 0x1f : null;
    const secondary = value >= 0x60 && value < 0x80 ? value & 0x1f : null;
    const msb = value & 0x80 ? value : null;
    let annotationClass: number | null = null;
    let texts: string[] | null = null;
    let packetType: string | null = null;
    let packetAddress: number | null = null;
    let updatePeers = false;
    let iecUpdate: [addr: number | null, secondary: number | null, data: number | null] | null = null;

    if (isCommand) {
      const command = commandTexts(value);
      texts = command.texts;
      if (!command.known) this.emitWarning(this.ssRaw, this.esRaw, ['Unknown GPIB command', 'unknown', 'UNK']);
      annotationClass = ANN_CMD;
      packetType = 'COMMAND';
      if (unlisten) {
        this.lastListener = [];
        updatePeers = true;
      }
      if (untalk) {
        this.lastTalker = null;
        updatePeers = true;
      }
      if (unlisten || untalk) iecUpdate = [null, null, null];
    } else if (listen !== null) {
      texts = addressTexts(value);
      annotationClass = ANN_LADDR;
      packetType = 'LISTEN';
      packetAddress = listen;
      this.lastListener.push(listen);
      iecUpdate = [listen, null, null];
      updatePeers = true;
    } else if (talk !== null) {
      texts = addressTexts(value);
      annotationClass = ANN_TADDR;
      packetType = 'TALK';
      packetAddress = talk;
      const index = this.lastListener.indexOf(talk);
      if (index >= 0) this.lastListener.splice(index, 1);
      this.lastTalker = talk;
      iecUpdate = [talk, null, null];
      updatePeers = true;
    } else if (secondary !== null) {
      texts = addressTexts(value);
      annotationClass = ANN_SADDR;
      packetType = 'SECONDARY';
      packetAddress = secondary;
      iecUpdate = [null, value, null];
    } else if (msb !== null) {
      texts = addressTexts(value);
      annotationClass = ANN_SADDR;
      packetType = 'MSB_SET';
      packetAddress = msb;
      iecUpdate = [null, value, null];
    }

    if (annotationClass !== null && texts !== null) this.putg(this.ssRaw, this.esRaw, [annotationClass, texts]);
    if (iecUpdate) this.handleIecPeriph(this.ssRaw, this.esRaw, ...iecUpdate);
    if (packetType) this.putpy(this.ssRaw, this.esRaw, packetType, packetAddress, value);
    if (updatePeers) {
      this.lastListener.sort((left, right) => left - right);
      this.putpy(this.ssRaw, this.esRaw, 'TALK_LISTEN', this.lastTalker, [...this.lastListener]);
    }
  }

  private handleDavChange(dav: number, data: readonly number[]): void {
    if (dav) {
      this.ssRaw = this.samplenum;
      this.currRaw = bitpack(data);
      this.latchEoi = this.currEoi;
      return;
    }
    if (this.currRaw === null || this.ssRaw === null) return;
    this.esRaw = this.samplenum;
    this.handleDataByte();
    this.ssRaw = null;
    this.esRaw = null;
    this.currRaw = null;
  }

  private injectDavPhase(ss: bigint, es: bigint, data: readonly number[]): void {
    this.ssRaw = ss;
    this.currRaw = bitpack(data);
    this.latchEoi = this.currEoi;
    this.esRaw = es;
    this.handleDataByte();
    this.ssRaw = null;
    this.esRaw = null;
    this.currRaw = null;
  }

  private *decodeSerial(): Generator<WaitToken, void, Pins> {
    if (!this.hasChannel('dio1') || !this.hasChannel('clk') || !this.hasChannel('atn'))
      throw new Error('IEC bus needs at least ATN and serial CLK and DATA.');

    const WAIT_READY_TO_SEND = 0;
    const WAIT_READY_FOR_DATA = 1;
    const PREPARE_DATA = 2;
    const CLOCK_DATA_BITS = 3;
    const conditions: readonly (readonly WaitCondition[])[] = [
      [{ atn: 'f' }, { dio1: 'l', clk: 'h' }],
      [{ atn: 'f' }, { dio1: 'h', clk: 'h' }, { clk: 'l' }],
      [{ atn: 'f' }, { dio1: 'f' }, { clk: 'l' }],
      [{ atn: 'f' }, { clk: 'e' }],
    ];
    let step = WAIT_READY_TO_SEND;
    let bits: number[] = [];
    let ssByte = 0n;
    let ssBit = 0n;

    while (true) {
      const pins = yield this.wait(conditions[step]!);
      const data = Number(pins[PIN_DIO1]);
      const clk = Number(pins[PIN_CLK]);
      const atn = invertPin(pins[PIN_ATN]);
      if (this.matched?.[0]) step = WAIT_READY_TO_SEND;

      if (step === WAIT_READY_TO_SEND) {
        if (data === 0 && clk === 1) step = WAIT_READY_FOR_DATA;
      } else if (step === WAIT_READY_FOR_DATA) {
        if (data === 1 && clk === 1) {
          ssByte = this.samplenum;
          this.handleAtnChange(atn);
          if (this.currEoi) this.handleEoiChange(0);
          bits = [];
          step = PREPARE_DATA;
        } else if (clk === 0) {
          step = WAIT_READY_TO_SEND;
        }
      } else if (step === PREPARE_DATA) {
        if (data === 0 && clk === 1) {
          this.handleEoiChange(1);
        } else if (clk === 0) {
          step = CLOCK_DATA_BITS;
          ssBit = this.samplenum;
        }
      } else if (this.matched?.[1]) {
        if (clk === 1) {
          bits.push(data);
        } else if (clk === 0) {
          const esBit = this.samplenum;
          const value = bits.at(-1) ?? 0;
          this.putg(ssBit, esBit, [ANN_RAW_BIT, [String(value)]]);
          this.putpy(ssBit, esBit, 'IEC_BIT', null, value);
          ssBit = this.samplenum;
          if (bits.length === 8) {
            this.injectDavPhase(ssByte, this.samplenum, bits);
            if (this.currEoi) this.handleEoiChange(0);
            step = WAIT_READY_TO_SEND;
          }
        }
      }
    }
  }

  private *decodeParallel(): Generator<WaitToken, void, Pins> {
    const dataChannels = Array.from({ length: 8 }, (_, index) => this.hasChannel(`dio${index + 1}`));
    if (dataChannels.some((present) => !present) || !this.hasChannel('dav') || !this.hasChannel('atn'))
      throw new Error('IEEE-488 needs at least ATN and DAV and eight DIO lines.');
    const hasEoi = this.hasChannel('eoi');
    const hasIfc = this.hasChannel('ifc');
    const conditions: Record<string, 'l' | 'h' | 'r' | 'f' | 'e' | 'n' | number | bigint>[] = [
      { dav: 'l' },
      { atn: 'l' },
    ];
    const idxDav = 0;
    const idxAtn = 1;
    let idxEoi: number | null = null;
    let idxIfc: number | null = null;
    if (hasEoi) {
      idxEoi = conditions.length;
      conditions.push({ eoi: 'l' });
    }
    if (hasIfc) {
      idxIfc = conditions.length;
      conditions.push({ ifc: 'l' });
    }
    let idxPpCheck: number | null = null;

    while (true) {
      const raw = yield this.wait(conditions);
      const pins = invertPins(raw);
      const matched = this.matched ?? [];
      let wantPpCheck = false;
      if (idxIfc !== null && matched[idxIfc] && pins[PIN_IFC] === 1) this.handleIfcChange(1);
      if (idxEoi !== null && matched[idxEoi] && pins[PIN_EOI] === 1) {
        this.handleEoiChange(1);
        wantPpCheck = true;
      }
      if (matched[idxAtn] && pins[PIN_ATN] === 1) {
        this.handleAtnChange(1);
        wantPpCheck = true;
      }
      if (wantPpCheck && idxPpCheck === null && this.checkPp() === 'enter') {
        idxPpCheck = conditions.length;
        conditions.push({ skip: 1 });
      }
      if (matched[idxDav]) this.handleDavChange(pins[PIN_DAV]!, pins.slice(PIN_DIO1, PIN_DIO8 + 1));
      if (idxPpCheck !== null) this.checkPp(pins.slice(PIN_DIO1, PIN_DIO8 + 1));

      wantPpCheck = false;
      if (matched[idxAtn] && pins[PIN_ATN] === 0) {
        this.handleAtnChange(0);
        wantPpCheck = true;
      }
      if (idxEoi !== null && matched[idxEoi] && pins[PIN_EOI] === 0) {
        this.handleEoiChange(0);
        wantPpCheck = true;
      }
      if (idxPpCheck !== null && wantPpCheck && this.checkPp(pins.slice(PIN_DIO1, PIN_DIO8 + 1)) === 'leave') {
        conditions.splice(idxPpCheck, 1);
        idxPpCheck = null;
      }
      if (idxIfc !== null && matched[idxIfc] && pins[PIN_IFC] === 0) this.handleIfcChange(0);

      conditions[idxDav]!.dav = 'e';
      conditions[idxAtn]!.atn = 'e';
      if (idxEoi !== null) conditions[idxEoi]!.eoi = 'e';
      if (idxIfc !== null) conditions[idxIfc]!.ifc = 'e';
    }
  }

  *decode(): LogicGenerator {
    if (this.hasChannel('clk')) yield* this.decodeSerial();
    else yield* this.decodeParallel();
  }
}

export default Ieee488Decoder;
