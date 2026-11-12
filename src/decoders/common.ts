export function bitpack(bits: Iterable<number>): number {
  let value = 0;
  let index = 0;
  for (const bit of bits) value += (bit & 1) << index++;
  return value;
}

export function bitpack_lsb(bits: readonly (number | readonly number[])[], index?: number): number {
  return bitpack(bits.map((item) => (index === undefined ? Number(item) : Number((item as readonly number[])[index]))));
}

export function bitpack_msb(bits: readonly (number | readonly number[])[], index?: number): number {
  return bitpack(
    bits.map((item) => (index === undefined ? Number(item) : Number((item as readonly number[])[index]))).reverse(),
  );
}

export function bitunpack(value: number, minimumBits = 0): number[] {
  const bits: number[] = [];
  while (value || minimumBits > 0) {
    bits.push(value & 1);
    value >>>= 1;
    minimumBits--;
  }
  return bits;
}

export function bcd2int(value: number): number {
  return (value & 0x0f) + (value >>> 4) * 10;
}

export function int2bcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

export function bin2int(value: string): number {
  return Number.parseInt(value, 2);
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function withinPercent(value: number, expected: number, percent: number): boolean {
  const tolerance = expected * (percent / 100);
  return value >= expected - tolerance && value <= expected + tolerance;
}

export function bytesToNumber(bytes: readonly number[]): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + (byte & 0xff);
  return value;
}

export function numberToBytes(value: number, length: number): number[] {
  return Array.from({ length }, (_, index) => (value >>> (8 * (length - index - 1))) & 0xff);
}

export function formatHex(value: number, digits = 2): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

export function textBytes(bytes: Uint8Array | readonly number[], format: 'ascii' | 'hex' = 'hex'): string {
  const data = Uint8Array.from(bytes);
  return format === 'ascii'
    ? [...data].map((value) => (value >= 32 && value < 127 ? String.fromCharCode(value) : '.')).join('')
    : [...data].map((value) => formatHex(value)).join(' ');
}
