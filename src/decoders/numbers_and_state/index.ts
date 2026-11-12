import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, WaitCondition, WaitPredicate } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface NumbersAndStateOptions {
  clkedge: string;
  count: number;
  interp: string;
  fracbits: number;
  mapping: string;
  format: string;
}

export type NumberKind = 'int' | 'float' | 'string';
export type InterpretedValue = number | bigint | string;

export interface InterpretedPattern {
  readonly value: InterpretedValue;
  readonly kind: NumberKind;
}

const MAX_CHANNELS = 16;
const MAX_ENUM_SLOTS = 32;

export function wireInteger(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function formatPythonFloat(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (Object.is(value, -0)) return '-0.0';
  if (value === 0) return '0.0';
  const sign = value < 0 ? '-' : '';
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
  const exponent = Number(exponentText);
  const digits = mantissa!.replace('.', '');
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
    const whole = digits.padEnd(exponent + 1, '0');
    return `${sign}${whole.slice(0, exponent + 1)}.${whole.slice(exponent + 1) || '0'}`;
  }
  const normalized = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0];
  return `${sign}${normalized}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

export function formatNumber(
  value: InterpretedValue,
  kind: NumberKind,
  bitcount: number,
  format: string,
): string[] | null {
  if (format === '-') {
    if (kind === 'string') return [String(value)];
    if (kind === 'float') return [formatPythonFloat(Number(value))];
    return [String(value)];
  }
  if (kind !== 'int') return null;
  const integer = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
  if (format === 'dec') return [integer.toString()];
  const base = format === 'bin' ? 2 : format === 'oct' ? 8 : format === 'hex' ? 16 : 10;
  const width = format === 'bin' ? bitcount : format === 'oct' ? Math.ceil(bitcount / 3) : Math.ceil(bitcount / 4);
  const negative = integer < 0n;
  const digits = (negative ? -integer : integer).toString(base);
  const padding = Math.max(0, width - digits.length - (negative ? 1 : 0));
  return [`${negative ? '-' : ''}${'0'.repeat(padding)}${digits}`];
}

export function interpretPattern(
  pattern: bigint,
  options: NumbersAndStateOptions,
  bitcount: number,
  enumMap: ReadonlyMap<bigint, string> = new Map(),
): InterpretedPattern | null {
  if (options.interp === 'unsigned') return { value: wireInteger(pattern), kind: 'int' };
  if (options.interp === 'signed') {
    const full = 1n << BigInt(bitcount);
    const value = pattern & (1n << BigInt(bitcount - 1)) ? pattern - full : pattern;
    return { value: wireInteger(value), kind: 'int' };
  }
  if (options.interp === 'fixpoint' || options.interp === 'fixsigned') {
    const full = 1n << BigInt(bitcount);
    const signed = options.interp === 'fixsigned' && (pattern & (1n << BigInt(bitcount - 1))) !== 0n;
    const integer = signed ? pattern - full : pattern;
    return { value: Number(integer) / 2 ** Math.trunc(options.fracbits), kind: 'float' };
  }
  if (options.interp === 'ieee754') {
    const value = ieeeValue(pattern, bitcount);
    return value === null ? null : { value, kind: 'float' };
  }
  if (options.interp === 'enum') {
    const mapped = enumMap.get(pattern);
    return mapped === undefined ? { value: wireInteger(pattern), kind: 'int' } : { value: mapped, kind: 'string' };
  }
  return null;
}

function ieeeValue(pattern: bigint, bitcount: number): number | null {
  const view = new DataView(new ArrayBuffer(8));
  if (bitcount === 16) return halfValue(Number(pattern & 0xffffn));
  if (bitcount === 32) {
    view.setUint32(0, Number(pattern & 0xffffffffn), true);
    return view.getFloat32(0, true);
  }
  if (bitcount === 64) {
    view.setBigUint64(0, pattern & 0xffffffffffffffffn, true);
    return view.getFloat64(0, true);
  }
  return null;
}

function halfValue(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function parseEnumMap(text: string): Map<bigint, string> {
  const result = new Map<bigint, string>();
  const source = text.trim();
  if (!source.startsWith('{')) return result;
  try {
    const table = JSON.parse(source) as Record<string, unknown>;
    for (const [name, value] of Object.entries(table)) {
      if (typeof value === 'number' && Number.isSafeInteger(value)) result.set(BigInt(value), name);
      else if (typeof value === 'string' && /^-?\d+$/.test(value)) result.set(BigInt(value), name);
    }
  } catch {
    return result;
  }
  return result;
}

export class NumbersAndStateDecoder extends Decoder<NumbersAndStateOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private outProtocol = -1;
  private bitcount = 0;
  private enumMap: ReadonlyMap<bigint, string> = new Map();

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]);
    this.enumMap = parseEnumMap(String(this.options.mapping));
  }

  private grabPattern(pins: readonly number[]): bigint {
    let pattern = 0n;
    for (let index = 0; index < this.bitcount; index++) {
      if (pins[index + 1] === 1) pattern |= 1n << BigInt(index);
    }
    return pattern;
  }

  private handlePattern(ss: bigint, es: bigint, pattern: bigint): void {
    this.put(ss, es, this.outAnn, [0, [pattern.toString(2).padStart(this.bitcount, '0')]]);
    this.put(ss, es, this.outProtocol, ['RAW', [this.bitcount, wireInteger(pattern)]]);

    let interpreted: InterpretedPattern | null;
    try {
      interpreted = interpretPattern(pattern, this.options, this.bitcount, this.enumMap);
    } catch {
      interpreted = null;
    }
    if (!interpreted) return;
    this.put(ss, es, this.outProtocol, ['NUMBER', interpreted.value]);

    let formatted: string[] | null;
    try {
      formatted = formatNumber(interpreted.value, interpreted.kind, this.bitcount, String(this.options.format));
    } catch {
      formatted = null;
    }
    if (!formatted) return;
    this.put(ss, es, this.outAnn, [1, formatted]);
    if (this.options.interp === 'enum') {
      const code = pattern < BigInt(MAX_ENUM_SLOTS) ? Number(pattern) : MAX_ENUM_SLOTS;
      this.put(ss, es, this.outAnn, [2 + code, formatted]);
      this.put(ss, es, this.outProtocol, ['ENUM', [interpreted.value, formatted]]);
    }
  }

  *decode(): LogicGenerator {
    const connected = Array.from({ length: MAX_CHANNELS }, (_, index) =>
      this.hasChannel(`bit${index}`) ? index : -1,
    ).filter((index) => index >= 0);
    if (!connected.length) throw new Error('Need at least one bit channel.');
    const haveClock = this.hasChannel('clk');
    this.bitcount = Math.trunc(this.options.count) || connected[connected.length - 1]! + 1;
    if (this.bitcount < 1) throw new Error('Total bits count must be positive.');

    const conditions: WaitCondition | WaitCondition[] = haveClock
      ? {
          clk:
            this.options.clkedge === 'rising'
              ? ('r' as WaitPredicate)
              : this.options.clkedge === 'falling'
                ? ('f' as WaitPredicate)
                : ('e' as WaitPredicate),
        }
      : connected.map((index) => ({ [`bit${index}`]: 'e' as WaitPredicate }));

    let pins = yield this.wait({ skip: 0 });
    let start = this.samplenum;
    let previous = this.grabPattern(pins);
    while (true) {
      pins = yield this.wait(conditions);
      const end = this.samplenum;
      const pattern = this.grabPattern(pins);
      if (pattern === previous) continue;
      this.handlePattern(start, end, previous);
      start = end;
      previous = pattern;
    }
  }
}

export default NumbersAndStateDecoder;
