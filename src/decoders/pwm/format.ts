function fixed(value: number, digits: number): string {
  if ((value * 10 ** digits) % 1 !== 0.5) return value.toFixed(digits);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0),
    exponent = Number((bits >> 52n) & 2047n);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1023 - 52;
  let numerator = mantissa * 10n ** BigInt(digits),
    denominator = 1n;
  if (shift >= 0) numerator <<= BigInt(shift);
  else denominator <<= BigInt(-shift);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n)) rounded++;
  const text = rounded.toString().padStart(digits + 1, '0');
  return digits ? text.slice(0, -digits) + '.' + text.slice(-digits) : text;
}
export function formatPWMDuty(percent: number): string {
  return fixed(percent, 6) + '%';
}
export function formatPWMPeriod(seconds: number): string {
  const [scale, unit] =
    seconds === 0 || seconds >= 1
      ? [1, 's']
      : seconds <= 1e-12
        ? [1e15, 'fs']
        : seconds <= 1e-9
          ? [1e12, 'ps']
          : seconds <= 1e-6
            ? [1e9, 'ns']
            : seconds <= 1e-3
              ? [1e6, 'μs']
              : [1e3, 'ms'];
  return fixed(seconds * scale, 1) + ' ' + unit;
}
export function formatPWMFrequency(seconds: number): string {
  const frequency = 1 / seconds;
  const [scale, unit] =
    frequency >= 1e15
      ? [1e15, 'PHz']
      : frequency >= 1e12
        ? [1e12, 'THz']
        : frequency >= 1e9
          ? [1e9, 'GHz']
          : frequency >= 1e6
            ? [1e6, 'MHz']
            : frequency >= 1e3
              ? [1e3, 'kHz']
              : [1, 'Hz'];
  return seconds ? fixed(frequency / scale, 3) + ' ' + unit : 'invalid';
}
