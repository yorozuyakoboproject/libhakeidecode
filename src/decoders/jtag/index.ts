import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pin } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const JTAG_STATES = [
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

export type JtagState = (typeof JTAG_STATES)[number];
export type JtagSampleInterval = readonly [ss: bigint, es: bigint];
export type JtagBitstring = readonly [bits: string, intervals: readonly JtagSampleInterval[]];
export type JtagProtocolPacket =
  | readonly ['NEW STATE', state: JtagState]
  | readonly ['IR TDI' | 'IR TDO' | 'DR TDI' | 'DR TDO', value: JtagBitstring];

const STATE_INDEX = new Map<JtagState, number>(JTAG_STATES.map((state, index) => [state, index]));
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

export class JtagDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outProtocol = -1;
  private state: JtagState = 'RUN-TEST/IDLE';
  private oldState: JtagState | null = null;
  private priorState: JtagState | null = null;
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
    this.oldState = null;
    this.priorState = null;
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
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'jtag');
  }

  private level(pin: Pin | undefined, name: string): 0 | 1 {
    if (pin !== 0 && pin !== 1) throw new Error(`JTAG ${name} is not a digital level.`);
    return pin;
  }

  private annotate(classIndex: number, texts: readonly string[], ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private advance(tms: 0 | 1): void {
    this.priorState = this.oldState;
    this.oldState = this.state;
    this.state = NEXT_STATE[this.state][tms];
  }

  private collectBit(tdi: 0 | 1, tdo: 0 | 1, sample: bigint): void {
    if (this.firstBit) {
      this.ssBitstring = sample;
      this.firstBit = false;
    } else {
      const lastTdi = this.intervalsTdi.at(-1);
      const lastTdo = this.intervalsTdo.at(-1);
      if (lastTdi) lastTdi[1] = sample;
      if (lastTdo) lastTdo[1] = sample;
      const ss = this.ssItem ?? sample;
      this.annotate(16, [String(this.bitsTdi.at(-1) ?? 0)], ss, sample);
      this.annotate(17, [String(this.bitsTdo.at(-1) ?? 0)], ss, sample);
    }
    this.bitsTdi.push(tdi);
    this.bitsTdo.push(tdo);
    this.intervalsTdi.push([sample, sample]);
    this.intervalsTdo.push([sample, sample]);
  }

  private emitBitstring(
    kind: 'DR' | 'IR',
    direction: 'TDI' | 'TDO',
    annotationClass: number,
    sample: bigint,
    bits: number[],
    intervals: [bigint, bigint][],
  ): void {
    const data = bits.reverse().slice(1).join(''),
      positions = intervals
        .reverse()
        .slice(1)
        .map(([ss, es]) => [ss, es] as const),
      hex = data ? BigInt(`0b${data}`).toString(16) : '0',
      label = `${kind} ${direction}`,
      text = `${label}: ${data} (0x${hex}), ${data.length} bits`;
    this.annotate(annotationClass, [text], this.ssBitstring ?? sample, sample);
    this.put(this.ssBitstring ?? sample, sample, this.outProtocol, [label, [data, positions]]);
  }

  private emitBitstrings(sample: bigint): void {
    const kind = this.state === 'UPDATE-DR' ? 'DR' : 'IR';
    this.emitBitstring(kind, 'TDI', 18, sample, this.bitsTdi, this.intervalsTdi);
    this.bitsTdi = [];
    this.intervalsTdi = [];
    this.emitBitstring(kind, 'TDO', 19, sample, this.bitsTdo, this.intervalsTdo);
    this.bitsTdo = [];
    this.intervalsTdo = [];
    this.firstBit = true;
    this.ssBitstring = sample;
  }

  private risingEdge(pins: readonly Pin[]): void {
    const tdi = this.level(pins[0], 'TDI');
    const tdo = this.level(pins[1], 'TDO');
    const tms = this.level(pins[3], 'TMS');
    const sample = this.samplenum;
    this.advance(tms);

    if (this.first) {
      this.ssItem = sample;
      this.first = false;
    } else if (this.oldState) {
      const ss = this.ssItem ?? sample;
      this.annotate(STATE_INDEX.get(this.oldState)!, [this.oldState], ss, sample);
      this.put(ss, sample, this.outProtocol, ['NEW STATE', this.state]);
    }

    if (
      this.oldState === 'SHIFT-DR' ||
      this.oldState === 'SHIFT-IR' ||
      (this.oldState === 'EXIT1-DR' && this.priorState === 'SHIFT-DR') ||
      (this.oldState === 'EXIT1-IR' && this.priorState === 'SHIFT-IR')
    ) {
      this.collectBit(tdi, tdo, sample);
    }

    if (this.state === 'UPDATE-DR' || this.state === 'UPDATE-IR') this.emitBitstrings(sample);
    this.ssItem = sample;
  }

  *decode(): LogicGenerator {
    let pins = yield this.wait({ tck: 'r' });
    while (true) {
      this.risingEdge(pins);
      pins = yield this.wait({ tck: 'r' });
    }
  }
}

export default JtagDecoder;
