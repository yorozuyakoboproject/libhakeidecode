export type SampleInput = bigint | number | string;
export function samplePosition(value: SampleInput, name = 'sample'): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new RangeError(`${name} must be an exact integer (use bigint or a decimal string for large values)`);
}
export function sampleIndex(value: SampleInput, name = 'sample'): bigint {
  const result = samplePosition(value, name);
  if (result < 0n) throw new RangeError(`${name} must be non-negative`);
  return result;
}
export function sampleFloor(value: SampleInput): bigint {
  return samplePosition(typeof value === 'number' ? Math.floor(value) : value);
}
export function sampleCeil(value: SampleInput): bigint {
  return samplePosition(typeof value === 'number' ? Math.ceil(value) : value);
}

export function localNumber(value: bigint, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value < 0n || value > BigInt(maximum))
    throw new RangeError(`sample range exceeds local block capacity ${maximum}`);
  return Number(value);
}
export const minSample = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxSample = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const absSample = (a: bigint): bigint => (a < 0n ? -a : a);
export const compareSamples = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

export function numberFraction(value: number): [bigint, bigint] {
  if (!Number.isFinite(value)) throw new RangeError('scale must be finite');
  if (value === 0) return [0n, 1n];
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0),
    exponent = Number((bits >> 52n) & 2047n);
  let numerator = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  let denominator = 1n;
  const shift = (exponent || 1) - 1075;
  if (shift >= 0) numerator <<= BigInt(shift);
  else denominator <<= BigInt(-shift);
  if (value < 0) numerator = -numerator;
  return [numerator, denominator];
}

export function scaleSamples(span: bigint, factor: number): bigint {
  const [n, d] = numberFraction(factor);
  return (span * n) / d;
}
export function sampleRatio(numerator: bigint, denominator: bigint): number {
  if (!denominator) return Number(numerator) / 0;
  const sign = numerator < 0n !== denominator < 0n ? -1 : 1;
  const n = absSample(numerator),
    d = absSample(denominator);
  if (n <= BigInt(Number.MAX_SAFE_INTEGER) && d <= BigInt(Number.MAX_SAFE_INTEGER))
    return (sign * Number(n)) / Number(d);
  if (!n) return 0;
  let exponent = n.toString(2).length - d.toString(2).length;
  if (exponent >= 0 ? n < d << BigInt(exponent) : n << BigInt(-exponent) < d) exponent--;
  if (exponent > 1023) return sign * Infinity;
  if (exponent < -1075) return sign < 0 ? -0 : 0;
  const shift = Math.max(-1074, exponent - 52);
  const scaledN = shift < 0 ? n << BigInt(-shift) : n,
    scaledD = shift > 0 ? d << BigInt(shift) : d;
  let quotient = scaledN / scaledD;
  const remainder = scaledN % scaledD;
  if (remainder * 2n > scaledD || (remainder * 2n === scaledD && quotient & 1n)) quotient++;
  return sign * Number(quotient) * 2 ** shift;
}

export function samplePhase(sample: bigint, frequency: number, sampleRate: number): number {
  const [n, d] = numberFraction(frequency),
    denominator = d * BigInt(sampleRate);
  const remainder = (((sample * n) % denominator) + denominator) % denominator;
  return sampleRatio(remainder, denominator);
}

export function stringifySamples(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), space);
}
