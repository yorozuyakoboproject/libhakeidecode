import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pins } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';
import { SYSTEMS, TV_COMMANDS, UNKNOWN_LABEL, VCR_COMMANDS, type Rc5Label } from './tables.js';

export interface Rc5Options {
  polarity: 'active-low' | 'active-high';
  protocol: 'standard' | 'extended';
}

export interface Rc5Frame {
  readonly address: number;
  readonly command: number;
  readonly toggle: 0 | 1;
}

export const RC5_BITS = 14;

export function rc5HalfBit(sampleRate: number): number {
  return Math.trunc((sampleRate * 0.00178) / 2);
}

export function rc5FrameBits(frame: Rc5Frame, extended: boolean): number[] {
  if (!Number.isInteger(frame.address) || frame.address < 0 || frame.address > 0x1f)
    throw new RangeError('RC-5 address must be five bits.');
  const maximumCommand = extended ? 0x7f : 0x3f;
  if (!Number.isInteger(frame.command) || frame.command < 0 || frame.command > maximumCommand)
    throw new RangeError('RC-5 command is out of range.');
  const bits = [1, extended ? ((frame.command >> 6) & 1) ^ 1 : 1, frame.toggle & 1];
  for (let index = 4; index >= 0; index--) bits.push((frame.address >> index) & 1);
  for (let index = 5; index >= 0; index--) bits.push((frame.command >> index) & 1);
  return bits;
}

export function rc5Fields(
  bits: readonly number[],
  extended: boolean,
): {
  address: number;
  command: number;
  system: Rc5Label;
  commandLabel: Rc5Label;
} {
  let address = 0;
  for (let index = 0; index < 5; index++) address = (address << 1) | bits[3 + index]!;
  let command = 0;
  for (let index = 0; index < 6; index++) command = (command << 1) | bits[8 + index]!;
  if (extended) command |= (bits[1] === 0 ? 1 : 0) << 6;
  const system = SYSTEMS.get(address) ?? UNKNOWN_LABEL;
  const commands = system[1] === 'VCR1' || system[1] === 'VCR2' ? VCR_COMMANDS : TV_COMMANDS;
  return { address, command, system, commandLabel: commands.get(command) ?? UNKNOWN_LABEL };
}

type Rc5Bit = readonly [sample: bigint, value: 0 | 1];
type Rc5Range = readonly [ss: bigint, es: bigint];

export class IrRc5Decoder extends Decoder<Rc5Options> {
  static descriptor = descriptor;

  private outAnn = -1;
  private halfbit = 0;
  private nextEdge: 'l' | 'h' = 'l';
  private edges: bigint[] = [];
  private bits: Rc5Bit[] = [];
  private bitRanges: Rc5Range[] = [];
  private state = 'IDLE';

  constructor(options: Partial<Rc5Options> = {}) {
    super(options);
    this.nextEdge = this.options.polarity === 'active-low' ? 'l' : 'h';
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.nextEdge = this.options.polarity === 'active-low' ? 'l' : 'h';
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.halfbit = rc5HalfBit(value);
  }

  override reset(): void {
    this.halfbit = 0;
    this.edges = [];
    this.bits = [];
    this.bitRanges = [];
    this.state = 'IDLE';
    this.nextEdge = this.options.polarity === 'active-low' ? 'l' : 'h';
  }

  *decode(): LogicGenerator {
    if (!this.halfbit) throw new Error('Cannot decode without samplerate.');
    while (true) {
      const pins: Pins = yield this.wait({ ir: this.nextEdge });
      const ir = Number(pins[0]);

      if (this.state === 'IDLE') {
        this.edges.push(this.samplenum);
        this.bits.push([this.samplenum, 1]);
        this.state = 'MID1';
        this.nextEdge = ir ? 'l' : 'h';
        continue;
      }

      const edge = this.edgeType();
      if (edge === 'e') {
        this.resetFrame();
        continue;
      }

      let bit: 0 | 1 | null = null;
      if (this.state === 'MID1') {
        this.state = edge === 's' ? 'START1' : 'MID0';
        if (edge === 'l') bit = 0;
      } else if (this.state === 'MID0') {
        this.state = edge === 's' ? 'START0' : 'MID1';
        if (edge === 'l') bit = 1;
      } else if (this.state === 'START1') {
        if (edge === 's') this.state = 'MID1';
        if (edge === 's') bit = 1;
      } else if (this.state === 'START0') {
        if (edge === 's') this.state = 'MID0';
        if (edge === 's') bit = 0;
      }

      this.edges.push(this.samplenum);
      if (bit !== null) this.bits.push([this.samplenum, bit]);
      if (this.bits.length === RC5_BITS) {
        this.handleBits();
        this.resetFrame();
      }
      this.nextEdge = ir ? 'l' : 'h';
    }
  }

  private edgeType(): 's' | 'l' | 'e' {
    const last = this.edges.at(-1);
    if (last === undefined) return 'e';
    const distance = this.samplenum - last;
    const short = BigInt(this.halfbit);
    const long = BigInt(this.halfbit * 2);
    const margin = BigInt(Math.trunc(this.halfbit / 2));
    if (distance >= long - margin && distance <= long + margin) return 'l';
    if (distance >= short - margin && distance <= short + margin) return 's';
    return 'e';
  }

  private putBits(first: number, second: number, data: readonly [number, readonly string[]]): void {
    const ss = this.bitRanges[first]![0];
    const es = this.bitRanges[second]![1];
    this.put(ss, es, this.outAnn, data);
  }

  private handleBits(): void {
    const bits = this.bits;
    this.bitRanges = [];
    for (let index = 0; index < RC5_BITS; index++) {
      const ss = index === 0 ? this.bits[0]![0] - BigInt(this.halfbit) : this.bitRanges[index - 1]![1];
      const es = bits[index]![0] + BigInt(this.halfbit);
      this.bitRanges.push([ss < 0n ? 0n : ss, es]);
      this.putBits(index, index, [0, [String(bits[index]![1])]]);
    }

    const start1 = bits[0]![1];
    this.putBits(0, 0, [1, [`Startbit1: ${start1}`, `SB1: ${start1}`, 'SB1', 'S1', 'S']]);

    const second = bits[1]![1];
    if (this.options.protocol === 'extended') {
      this.putBits(1, 1, [6, [`CMD[6]#: ${second}`, `C6#: ${second}`, 'C6#', 'C#', 'C']]);
    } else {
      this.putBits(1, 1, [2, [`Startbit2: ${second}`, `SB2: ${second}`, 'SB2', 'S2', 'S']]);
    }

    const toggle = bits[2]![1];
    this.putBits(2, 2, [
      toggle === 0 ? 3 : 4,
      [`Togglebit: ${toggle}`, `Toggle: ${toggle}`, `TB: ${toggle}`, 'TB', 'T'],
    ]);

    const fields = rc5Fields(
      bits.map((bit) => bit[1]),
      this.options.protocol === 'extended',
    );
    this.putBits(3, 7, [
      5,
      [
        `Address: ${fields.address} (${fields.system[0]})`,
        `Addr: ${fields.address} (${fields.system[1]})`,
        `Addr: ${fields.address}`,
        `A: ${fields.address}`,
        'A',
      ],
    ]);
    this.putBits(8, 13, [
      6,
      [
        `Command: ${fields.command} (${fields.commandLabel[0]})`,
        `Cmd: ${fields.command} (${fields.commandLabel[1]})`,
        `Cmd: ${fields.command}`,
        `C: ${fields.command}`,
        'C',
      ],
    ]);
  }

  private resetFrame(): void {
    this.edges = [];
    this.bits = [];
    this.bitRanges = [];
    this.state = 'IDLE';
  }
}

export default IrRc5Decoder;
