import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pin } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

const JTAG_STATES = [
  'TEST-LOGIC-RESET',
  'RUN-TEST/IDLE',
  'SELECT-DR-SCAN',
  'CAPTURE-DR',
  'UPDATE-DR',
  'PAUSE-DR',
  'SHIFT-DR',
  'EXIT1-DR',
  'EXIT2-DR',
  'SELECT-IR-SCAN',
  'CAPTURE-IR',
  'UPDATE-IR',
  'PAUSE-IR',
  'SHIFT-IR',
  'EXIT1-IR',
  'EXIT2-IR',
] as const;

export const CJTAG_STATES = [
  'CJTAG_EC',
  'CJTAG_SPARE',
  'CJTAG_TPDEL',
  'CJTAG_TPREV',
  'CJTAG_TPST',
  'CJTAG_RDYC',
  'CJTAG_DLYC',
  'CJTAG_SCNFMT',
  'CJTAG_CP',
  'CJTAG_OAC',
  'OSCAN1',
  'FOUR_WIRE',
] as const;

type JtagState = (typeof JTAG_STATES)[number];
export type CjtagState = (typeof CJTAG_STATES)[number];
export type CjtagSampleInterval = readonly [ss: bigint, es: bigint];

const JTAG_INDEX = new Map<JtagState, number>(JTAG_STATES.map((state, index) => [state, index]));
const CJTAG_INDEX = new Map<CjtagState, number>(CJTAG_STATES.map((state, index) => [state, index]));
const NEXT_STATE: Readonly<Record<JtagState, readonly [tms0: JtagState, tms1: JtagState]>> = {
  'TEST-LOGIC-RESET': ['RUN-TEST/IDLE', 'TEST-LOGIC-RESET'],
  'RUN-TEST/IDLE': ['RUN-TEST/IDLE', 'SELECT-DR-SCAN'],
  'SELECT-DR-SCAN': ['CAPTURE-DR', 'SELECT-IR-SCAN'],
  'CAPTURE-DR': ['SHIFT-DR', 'EXIT1-DR'],
  'UPDATE-DR': ['RUN-TEST/IDLE', 'SELECT-DR-SCAN'],
  'PAUSE-DR': ['PAUSE-DR', 'EXIT2-DR'],
  'SHIFT-DR': ['SHIFT-DR', 'EXIT1-DR'],
  'EXIT1-DR': ['PAUSE-DR', 'UPDATE-DR'],
  'EXIT2-DR': ['SHIFT-DR', 'UPDATE-DR'],
  'SELECT-IR-SCAN': ['CAPTURE-IR', 'TEST-LOGIC-RESET'],
  'CAPTURE-IR': ['SHIFT-IR', 'EXIT1-IR'],
  'UPDATE-IR': ['RUN-TEST/IDLE', 'SELECT-DR-SCAN'],
  'PAUSE-IR': ['PAUSE-IR', 'EXIT2-IR'],
  'SHIFT-IR': ['SHIFT-IR', 'EXIT1-IR'],
  'EXIT1-IR': ['PAUSE-IR', 'UPDATE-IR'],
  'EXIT2-IR': ['SHIFT-IR', 'UPDATE-IR'],
};

export class CjtagDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outProtocol = -1;
  private state: JtagState = 'RUN-TEST/IDLE';
  private cjtagState: CjtagState = 'FOUR_WIRE';
  private oldCjtagState: CjtagState | null = null;
  private escapeEdges = 0;
  private oacLength = 0;
  private oldTms: 0 | 1 = 0;
  private oacPosition = 0;
  private oscanCycle = 0;
  private oldState: JtagState | null = null;
  private bitsTdi: number[] = [];
  private bitsTdo: number[] = [];
  private intervalsTdi: [bigint, bigint][] = [];
  private intervalsTdo: [bigint, bigint][] = [];
  private ssItem: bigint | null = null;
  private ssBitstring: bigint | null = null;
  private first = true;
  private firstBit = true;

  override reset(): void {
    this.state = 'RUN-TEST/IDLE';
    this.cjtagState = 'FOUR_WIRE';
    this.oldCjtagState = null;
    this.escapeEdges = 0;
    this.oacLength = 0;
    this.oldTms = 0;
    this.oacPosition = 0;
    this.oscanCycle = 0;
    this.oldState = null;
    this.bitsTdi = [];
    this.bitsTdo = [];
    this.intervalsTdi = [];
    this.intervalsTdo = [];
    this.ssItem = null;
    this.ssBitstring = null;
    this.first = true;
    this.firstBit = true;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'jtag');
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private level(pin: Pin | undefined, name: string): 0 | 1 {
    if (pin !== 0 && pin !== 1) throw new Error(`cJTAG ${name} is not a digital level.`);
    return pin;
  }

  private advance(tms: 0 | 1): void {
    this.oldState = this.state;
    if (this.cjtagState.startsWith('CJTAG_')) {
      this.oacPosition++;
      if (this.oacPosition > 4 && this.oacLength === 12) this.cjtagState = 'CJTAG_EC';
      if (this.oacPosition === 8 && tms === 0) this.oacLength = 36;
      if (this.oacPosition > 8 && this.oacLength === 36) this.cjtagState = 'CJTAG_SPARE';
      if (this.oacPosition > 13 && this.oacLength === 36) this.cjtagState = 'CJTAG_TPDEL';
      if (this.oacPosition > 16 && this.oacLength === 36) this.cjtagState = 'CJTAG_TPREV';
      if (this.oacPosition > 18 && this.oacLength === 36) this.cjtagState = 'CJTAG_TPST';
      if (this.oacPosition > 23 && this.oacLength === 36) this.cjtagState = 'CJTAG_RDYC';
      if (this.oacPosition > 25 && this.oacLength === 36) this.cjtagState = 'CJTAG_DLYC';
      if (this.oacPosition > 27 && this.oacLength === 36) this.cjtagState = 'CJTAG_SCNFMT';
      if (this.oacPosition > 8 && this.oacLength === 12) this.cjtagState = 'CJTAG_CP';
      if (this.oacPosition > 32 && this.oacLength === 36) this.cjtagState = 'CJTAG_CP';
      if (this.oacPosition > this.oacLength) {
        this.cjtagState = 'OSCAN1';
        this.oscanCycle = 1;
        this.state = 'TEST-LOGIC-RESET';
      }
      return;
    }
    this.state = NEXT_STATE[this.state][tms];
  }

  private annotate(classIndex: number, texts: readonly string[], ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private collectBit(tdi: 0 | 1, tdo: 0 | 1, sample: bigint): void {
    if (this.firstBit) {
      this.ssBitstring = sample;
      this.firstBit = false;
    } else {
      if (this.intervalsTdi[0]) this.intervalsTdi[0][1] = sample;
      if (this.intervalsTdo[0]) this.intervalsTdo[0][1] = sample;
      this.annotate(28, [String(this.bitsTdi[0] ?? 0)], this.ssItem ?? sample, sample);
      this.annotate(29, [String(this.bitsTdo[0] ?? 0)], this.ssItem ?? sample, sample);
    }
    this.bitsTdi.unshift(tdi);
    this.bitsTdo.unshift(tdo);
    this.intervalsTdi.unshift([sample, sample]);
    this.intervalsTdo.unshift([sample, sample]);
  }

  private emitBitstring(
    kind: 'DR' | 'IR',
    direction: 'TDI' | 'TDO',
    classIndex: number,
    sample: bigint,
    bits: number[],
    intervals: [bigint, bigint][],
  ): void {
    const data = bits.slice(1).join(''),
      positions = intervals.slice(1).map(([ss, es]) => [ss, es] as const),
      hex = data ? BigInt(`0b${data}`).toString(16) : '0',
      label = `${kind} ${direction}`,
      text = `${label}: ${data} (0x${hex}), ${data.length} bits`;
    this.annotate(classIndex, [text], this.ssBitstring ?? sample, sample);
    this.put(this.ssBitstring ?? sample, sample, this.outProtocol, [label, [data, positions]]);
  }

  private emitBitstrings(sample: bigint): void {
    const kind = this.state === 'UPDATE-DR' ? 'DR' : 'IR';
    this.emitBitstring(kind, 'TDI', 30, sample, this.bitsTdi, this.intervalsTdi);
    this.emitBitstring(kind, 'TDO', 31, sample, this.bitsTdo, this.intervalsTdo);
    this.bitsTdi = [];
    this.bitsTdo = [];
    this.intervalsTdi = [];
    this.intervalsTdo = [];
    this.firstBit = true;
    this.ssBitstring = sample;
  }

  private risingEdge(tdi: 0 | 1 | undefined, tdo: 0 | 1 | undefined, sample: bigint, tms: 0 | 1): void {
    this.advance(tms);
    if (this.first) {
      this.ssItem = sample;
      this.first = false;
    } else if (this.oldState) {
      const ss = this.ssItem ?? sample;
      this.annotate(JTAG_INDEX.get(this.oldState)!, [this.oldState], ss, sample);
      this.put(ss, sample, this.outProtocol, ['NEW STATE', this.state]);
      if (this.oldCjtagState) {
        this.annotate(16 + CJTAG_INDEX.get(this.oldCjtagState)!, [this.oldCjtagState], ss, sample);
        if (this.oldCjtagState.startsWith('CJTAG_')) this.annotate(32, [String(this.oldTms)], ss, sample);
      }
    }
    this.oldTms = tms;
    if (
      this.oldState === 'SHIFT-DR' ||
      this.oldState === 'EXIT1-DR' ||
      this.oldState === 'SHIFT-IR' ||
      this.oldState === 'EXIT1-IR'
    )
      this.collectBit(tdi ?? 0, tdo ?? 0, sample);
    if (this.state === 'UPDATE-DR' || this.state === 'UPDATE-IR') this.emitBitstrings(sample);
    this.ssItem = sample;
  }

  private handleTapcState(): void {
    this.oldCjtagState = this.cjtagState;
    if (this.escapeEdges >= 8) this.cjtagState = 'FOUR_WIRE';
    if (this.escapeEdges === 6) {
      this.cjtagState = 'CJTAG_OAC';
      this.oacPosition = 0;
      this.oacLength = 12;
    }
    this.escapeEdges = 0;
  }

  *decode(): LogicGenerator {
    let tdi: 0 | 1 = 0,
      tdo: 0 | 1 = 0,
      tms: 0 | 1 = 0;
    let pins = yield this.wait({ tckc: 'r' });
    let tckc = this.level(pins[0], 'TCKC'),
      tmsc = this.level(pins[1], 'TMSC');
    while (true) {
      this.handleTapcState();
      if (this.cjtagState === 'OSCAN1') {
        if (this.oscanCycle === 0) {
          tdi = tmsc === 0 ? 1 : 0;
          this.oscanCycle = 1;
        } else if (this.oscanCycle === 1) {
          tms = tmsc;
          this.oscanCycle = 2;
        } else {
          tdo = tmsc;
          this.risingEdge(tdi, tdo, this.samplenum, tms);
          this.oscanCycle = 0;
        }
      } else {
        this.risingEdge(undefined, undefined, this.samplenum, tmsc);
      }

      while (tckc === 1) {
        pins = yield this.wait([{ tckc: 'f' }, { tmsc: 'e' }]);
        tckc = this.level(pins[0], 'TCKC');
        const nextTmsc = this.level(pins[1], 'TMSC');
        if (nextTmsc !== tmsc) {
          tmsc = nextTmsc;
          this.escapeEdges++;
        }
      }
      pins = yield this.wait({ tckc: 'r' });
      tckc = this.level(pins[0], 'TCKC');
      tmsc = this.level(pins[1], 'TMSC');
    }
  }
}

export default CjtagDecoder;
