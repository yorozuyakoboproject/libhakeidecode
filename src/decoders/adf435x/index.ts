import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

interface SPIWord {
  readonly ss: bigint;
  readonly es: bigint;
  readonly mosi: number | null;
  readonly cs: boolean | null;
}

interface Field {
  readonly offset: number;
  readonly width: number;
  readonly name: string;
  readonly format?: (value: number) => string;
  readonly check?: (value: number) => string | null;
}

const enabled = (value: number): string => (value ? 'Enabled' : 'Disabled'),
  outputPower = (value: number): string => {
    const power = [-4, -1, 2, 5][value] ?? value;
    return `${power >= 0 ? '+' : ''}${power}dBm`;
  },
  CHARGE_PUMP = [0.31, 0.63, 0.94, 1.25, 1.56, 1.88, 2.19, 2.5, 2.81, 3.13, 3.44, 3.75, 4.06, 4.38, 4.69, 5],
  MUXOUT = [
    'Three-State Output',
    'DVdd',
    'DGND',
    'R Counter Output',
    'N Divider Output',
    'Analog Lock Detect',
    'Digital Lock Detect',
    'Reserved',
  ],
  FIELDS: Readonly<Record<number, readonly Field[]>> = {
    0: [
      { offset: 3, width: 12, name: 'FRAC' },
      {
        offset: 15,
        width: 16,
        name: 'INT',
        check: (value) => (value < 23 ? 'Not Allowed' : null),
      },
    ],
    1: [
      { offset: 3, width: 12, name: 'MOD' },
      { offset: 15, width: 12, name: 'Phase' },
      { offset: 27, width: 1, name: 'Prescalar', format: (value) => (value ? '8/9' : '4/5') },
      { offset: 28, width: 1, name: 'Phase Adjust', format: (value) => (value ? 'On' : 'Off') },
    ],
    2: [
      { offset: 3, width: 1, name: 'Counter Reset', format: enabled },
      { offset: 4, width: 1, name: 'Charge Pump Three-State', format: enabled },
      { offset: 5, width: 1, name: 'Power-Down', format: enabled },
      { offset: 6, width: 1, name: 'PD Polarity', format: (value) => (value ? 'Positive' : 'Negative') },
      { offset: 7, width: 1, name: 'LDP', format: (value) => (value ? '6ns' : '10ns') },
      { offset: 8, width: 1, name: 'LDF', format: (value) => (value ? 'INT-N' : 'FRAC-N') },
      {
        offset: 9,
        width: 4,
        name: 'Charge Pump Current Setting',
        format: (value) => `${(CHARGE_PUMP[value] ?? value).toFixed(2)}mA @ 5.1kΩ`,
      },
      { offset: 13, width: 1, name: 'Double Buffer', format: enabled },
      { offset: 14, width: 10, name: 'R Counter' },
      { offset: 24, width: 1, name: 'RDIV2', format: enabled },
      { offset: 25, width: 1, name: 'Reference Doubler', format: enabled },
      { offset: 26, width: 3, name: 'MUXOUT', format: (value) => MUXOUT[value] ?? 'Reserved' },
      {
        offset: 29,
        width: 2,
        name: 'Low Noise and Low Spur Modes',
        format: (value) => ['Low Noise Mode', 'Reserved', 'Reserved', 'Low Spur Mode'][value] ?? 'Reserved',
      },
    ],
    3: [
      { offset: 3, width: 12, name: 'Clock Divider' },
      {
        offset: 15,
        width: 2,
        name: 'Clock Divider Mode',
        format: (value) => ['Clock Divider Off', 'Fast Lock Enable', 'Resync Enable', 'Reserved'][value] ?? 'Reserved',
      },
      { offset: 18, width: 1, name: 'CSR Enable', format: enabled },
      { offset: 21, width: 1, name: 'Charge Cancellation', format: enabled },
      { offset: 22, width: 1, name: 'ABP', format: (value) => (value ? '3ns (INT-N)' : '6ns (FRAC-N)') },
      { offset: 23, width: 1, name: 'Band Select Clock Mode', format: (value) => (value ? 'High' : 'Low') },
    ],
    4: [
      { offset: 3, width: 2, name: 'Output Power', format: outputPower },
      { offset: 5, width: 1, name: 'Output Enable', format: enabled },
      { offset: 6, width: 2, name: 'AUX Output Power', format: outputPower },
      {
        offset: 8,
        width: 1,
        name: 'AUX Output Select',
        format: (value) => (value ? 'Fundamental' : 'Divided Output'),
      },
      { offset: 9, width: 1, name: 'AUX Output Enable', format: enabled },
      { offset: 10, width: 1, name: 'MTLD', format: enabled },
      { offset: 11, width: 1, name: 'VCO Power-Down', format: (value) => `VCO Powered ${value ? 'Down' : 'Up'}` },
      { offset: 12, width: 8, name: 'Band Select Clock Divider' },
      { offset: 20, width: 3, name: 'RF Divider Select', format: (value) => `÷${2 ** value}` },
      {
        offset: 23,
        width: 1,
        name: 'Feedback Select',
        format: (value) => (value ? 'Fundamental' : 'Divided'),
      },
    ],
    5: [
      {
        offset: 22,
        width: 2,
        name: 'LD Pin Mode',
        format: (value) => ['Low', 'Digital Lock Detect', 'Low', 'High'][value] ?? 'Low',
      },
    ],
  };

function wordBytes(value: number): number[] {
  if (value === 0) return [0];
  const bytes: number[] = [];
  for (let remainder = value; remainder > 0; remainder = Math.floor(remainder / 256)) bytes.unshift(remainder & 0xff);
  return bytes;
}

function spiWord(ss: bigint, es: bigint, data: unknown): SPIWord | null {
  if (!Array.isArray(data) || data.length !== 5 || data[0] !== 'WORD') return null;
  const mosi = data[1],
    cs = data[3];
  if (mosi !== null && (typeof mosi !== 'number' || !Number.isInteger(mosi) || mosi < 0)) return null;
  if (cs !== null && typeof cs !== 'boolean') return null;
  return { ss, es, mosi, cs };
}

function bytesToNumber(bytes: readonly number[]): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

export class Adf435xDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private bytes: number[] = [];
  private ss: bigint | null = null;
  private lastEs: bigint | null = null;
  private minimumGap: bigint | null = null;

  override reset(): void {
    this.bytes = [];
    this.ss = null;
    this.lastEs = null;
    this.minimumGap = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private interval(start: bigint, es: bigint, offset: number, width: number): [bigint, bigint] {
    const span = Number(es - start),
      unit = span / 31,
      high = offset + width - 1,
      ss = start + BigInt(Math.round(unit * (31 - high))),
      low = start + BigInt(Math.round(unit * (31 - offset)));
    return [ss, offset === 0 ? es : low];
  }

  private decodeFrame(value: number, bits: number, start: bigint, es: bigint): void {
    if (bits !== 32) {
      this.put(start, es, this.outAnn, [
        1,
        [`Frame error: Bit count: want 32, got ${bits}`, 'Frame error: Bit count', 'Frame error'],
      ]);
      return;
    }
    const register = value & 7,
      [registerSs, registerEs] = this.interval(start, es, 0, 3);
    this.put(registerSs, registerEs, this.outAnn, [0, [`Register: ${register}`, `Reg: ${register}`, `[${register}]`]]);
    const fields = FIELDS[register];
    if (!fields) return;
    for (const field of fields) {
      const fieldValue = Math.floor(value / 2 ** field.offset) % 2 ** field.width,
        text = `${field.name}: ${field.format ? field.format(fieldValue) : fieldValue}`,
        [ss, fieldEs] = this.interval(start, es, field.offset, field.width);
      this.put(ss, fieldEs, this.outAnn, [0, [text]]);
      const warning = field.check?.(fieldValue);
      if (warning) this.put(ss, fieldEs, this.outAnn, [1, [warning]]);
    }
  }

  private finishPending(es: bigint, discarded = 0): void {
    if (!this.bytes.length) return;
    const bits = this.bytes.length * 8 + discarded;
    this.decodeFrame(bytesToNumber(this.bytes), bits, this.ss ?? es, es);
    this.bytes = [];
    this.ss = null;
  }

  private addByte(byte: number, ss: bigint, es: bigint): void {
    if (!this.bytes.length) this.ss = ss;
    this.bytes.push(byte);
    if (this.bytes.length !== 4) return;
    this.decodeFrame(bytesToNumber(this.bytes), 32, this.ss ?? ss, es);
    this.bytes = [];
    this.ss = null;
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING' && typeof data[1] === 'string') {
      const match = /Chip select deasserted: (\d+) bit\(s\) discarded/.exec(data[1]);
      if (match) this.finishPending(this.samplenum, Number(match[1]));
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word) return;
    if (this.lastEs !== null) {
      const gap = ss - this.lastEs;
      if (gap > 0n) {
        if (this.minimumGap === null || gap < this.minimumGap) this.minimumGap = gap;
        else if (gap > this.minimumGap * 2n) this.finishPending(this.lastEs);
      }
    }
    if (word.cs === false) this.finishPending(es);
    if (word.mosi !== null) for (const byte of wordBytes(word.mosi)) this.addByte(byte, ss, es);
    this.lastEs = es;
  }

  onEof(): void {
    this.finishPending(this.lastEs ?? this.samplenum);
  }
}

export default Adf435xDecoder;
