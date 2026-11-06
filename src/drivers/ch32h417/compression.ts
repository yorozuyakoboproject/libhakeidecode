export interface BlockEncoding {
  rawBytes: number;
  cycles: number;
  holdMs: number;
  encoding: number;
  transform: number;
  channels: number;
  outputSlot: number;
  queuePeak: number;
  wireBytes: number;
  decodeMs: number;
}
export function decodeLz4(input: Uint8Array, rawBytes: number): Uint8Array {
  const output = new Uint8Array(rawBytes);
  let read = 0,
    written = 0,
    lastMatch = -1;
  const length = (base: number): number => {
    if (base !== 15) return base;
    let value = base,
      next: number;
    do {
      if (read >= input.length) throw new Error('Truncated LZ4 length');
      next = input[read++]!;
      value += next;
      if (value > rawBytes) throw new Error('Oversized LZ4 length');
    } while (next === 255);
    return value;
  };
  while (read < input.length) {
    const token = input[read++]!;
    const literals = length(token >>> 4);
    if (literals > input.length - read || literals > rawBytes - written) throw new Error('Invalid LZ4 literals');
    output.set(input.subarray(read, read + literals), written);
    read += literals;
    written += literals;
    if (read === input.length) {
      if (written !== rawBytes || (rawBytes >= 5 && literals < 5) || (lastMatch >= 0 && lastMatch > rawBytes - 12))
        throw new Error('Invalid LZ4 block ending');
      return output;
    }
    if (read + 2 > input.length) throw new Error('Truncated LZ4 offset');
    const offset = input[read]! | (input[read + 1]! << 8);
    read += 2;
    const match = length(token & 15) + 4;
    if (!offset || offset > written || match > rawBytes - written) throw new Error('Invalid LZ4 match');
    lastMatch = written;
    for (let i = 0; i < match; i++) {
      output[written] = output[written - offset]!;
      written++;
    }
  }
  throw new Error('Truncated LZ4 block');
}
export function restoreBlock(input: Uint8Array, meta: BlockEncoding, bits = 16): Uint8Array {
  const started = performance.now();
  let raw =
    meta.encoding === 1
      ? decodeLz4(input, meta.rawBytes)
      : meta.encoding === 3
        ? unpackBits(input, meta.rawBytes / 2, bits)
        : input;
  if (meta.transform) {
    const scans = meta.rawBytes / (2 * meta.channels);
    const restored = new Uint8Array(meta.rawBytes);
    for (let c = 0; c < meta.channels; c++) {
      let previous = 0;
      const low = c * scans * 2,
        high = low + scans;
      for (let i = 0; i < scans; i++) {
        let value = raw[low + i]! | (raw[high + i]! << 8);
        if (meta.transform === 2 && i) value = (value + previous) & 0xffff;
        const at = (i * meta.channels + c) * 2;
        restored[at] = value & 255;
        restored[at + 1] = value >>> 8;
        previous = value;
      }
    }
    raw = restored;
  }
  meta.decodeMs = performance.now() - started;
  return raw;
}

function unpackBits(input: Uint8Array, count: number, bits: number): Uint8Array {
  if (!Number.isInteger(count) || bits < 8 || bits > 12 || input.length !== Math.ceil((count * bits) / 8))
    throw new Error('Invalid bit-packed block');
  const out = new Uint8Array(count * 2);
  let pending = 0,
    have = 0,
    p = 0;
  for (let i = 0; i < count; ++i) {
    while (have < bits) {
      pending |= input[p++]! << have;
      have += 8;
    }
    const value = pending & ((1 << bits) - 1);
    pending >>>= bits;
    have -= bits;
    out[i * 2] = value;
    out[i * 2 + 1] = value >>> 8;
  }
  if (pending) throw new Error('Nonzero bit-packed padding');
  return out;
}
