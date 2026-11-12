import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { UsbSignallingOption, UsbSpeed, UsbSignallingSymbol } from './index.js';

export const USB_LEAD_BITS = 4;
export const USB_PACKET_GAP_BITS = 4;
export const USB_TRAIL_BITS = 4;

export interface UsbSignalPacketItem {
  readonly kind: 'packet';
  readonly bits: readonly number[];
}

export interface UsbSignalIdleItem {
  readonly kind: 'reset' | 'keep-alive';
  readonly bits: number;
}

export type UsbSignallingItem = UsbSignalPacketItem | UsbSignalIdleItem;

export interface UsbSignallingCase extends RoundtripCase<UsbSignallingItem> {
  readonly busSpeed: UsbSpeed;
}

export interface UsbSignallingCell {
  readonly ss: bigint;
  readonly es: bigint;
}

export interface UsbSignallingLayout {
  readonly frames: readonly ExpectedFrame[];
  readonly cells: readonly UsbSignallingCell[];
  readonly wireMap: readonly number[];
  readonly next: bigint;
  readonly packetEnd: bigint;
  readonly wireBits: number;
}

const BITRATES: Record<UsbSpeed, number> = {
  'full-speed': 12_000_000,
  'low-speed': 1_500_000,
};

export function usbBitWidth(sampleRate: number, speed: UsbSpeed): number {
  const width = sampleRate / BITRATES[speed];
  if (!Number.isInteger(width) || width < 2) throw new RangeError('USB sample rate must produce integer bit widths');
  return width;
}

export function stuffingLayout(bits: readonly number[]): { wire: number[]; map: number[] } {
  const wire: number[] = [];
  const map: number[] = [];
  let ones = 0;
  for (const value of bits) {
    const bit = value & 1;
    map.push(wire.length);
    wire.push(bit);
    if (bit === 1) ones++;
    else ones = 0;
    if (ones === 6) {
      wire.push(0);
      ones = 0;
    }
  }
  return { wire, map };
}

export function stuffingBits(bits: readonly number[]): number[] {
  return stuffingLayout(bits).wire;
}

function packet(ss: bigint, es: bigint, data: readonly unknown[]): ExpectedFrame {
  return { ss, es, protoId: 'usb_signalling', kind: 'protocol', data };
}

export function signallingPacketLayout(bits: readonly number[], start: bigint, width: number): UsbSignallingLayout {
  const { wire, map } = stuffingLayout(bits);
  const wireSymbols: UsbSignallingSymbol[] = [];
  let nextSymbol: UsbSignallingSymbol = 'J';
  for (const bit of wire) {
    if (bit === 0) nextSymbol = nextSymbol === 'J' ? 'K' : 'J';
    wireSymbols.push(nextSymbol);
  }

  const frames: ExpectedFrame[] = [packet(start, start, ['SOP', null])];
  const cells: UsbSignallingCell[] = [];
  let bitwidth = width;
  let samplepos = -(bitwidth / 2) + 0.5;
  let targetRel = 0;
  let lastRel = 0;
  let edgeRel = 0;
  let previous: UsbSignallingSymbol = 'J';
  let ones = 0;
  const advance = (): void => {
    samplepos += bitwidth;
    targetRel = Math.trunc(samplepos);
    lastRel = edgeRel;
    edgeRel = Math.trunc(samplepos - bitwidth / 2);
  };
  const sampleAt = (offset: number): UsbSignallingSymbol => {
    if (offset < wire.length * width) return wireSymbols[Math.floor(offset / width)]!;
    if (offset < (wire.length + 2) * width) return 'SE0';
    return 'J';
  };
  const symbolAt = (sample: bigint): UsbSignallingSymbol => sampleAt(Number(sample - start));
  advance();
  let previousRel = 0;
  let currentRel = targetRel;

  let eopStart = start;
  for (;;) {
    const sampleRel = currentRel;
    const symbol = symbolAt(start + BigInt(currentRel));
    const edgeSymbol = symbolAt(start + BigInt(Math.max(previousRel, edgeRel)));
    advance();
    previousRel = sampleRel;
    currentRel = targetRel;
    const cellStart = start + BigInt(lastRel);
    const cellEnd = start + BigInt(edgeRel);
    if (symbol === 'SE0') {
      eopStart = cellStart;
    } else cells.push({ ss: cellStart, es: cellEnd });
    const bitValue: '0' | '1' = previous === symbol ? '1' : '0';
    if (symbol !== 'SE0') {
      previous = symbol;
      if (ones === 6) {
        if (bitValue === '0') {
          frames.push(packet(cellStart, cellEnd, ['STUFF BIT', null]));
          ones = 0;
        } else {
          frames.push(packet(cellStart, cellEnd, ['ERR', null]));
          frames.push(packet(cellStart, cellEnd, ['SYM', symbol]));
          throw new RangeError('USB packet contains an invalid bit-stuffing sequence');
        }
      } else {
        frames.push(packet(cellStart, cellEnd, ['BIT', bitValue]));
        ones = bitValue === '1' ? ones + 1 : 0;
      }
    }
    frames.push(packet(cellStart, cellEnd, ['SYM', symbol]));
    if (bitValue === '0' && edgeSymbol !== 'SE0' && edgeSymbol !== 'SE1') {
      if (edgeSymbol === symbol) {
        bitwidth -= 0.001 * bitwidth;
        samplepos -= 0.01 * bitwidth;
      } else {
        bitwidth += 0.001 * bitwidth;
        samplepos += 0.01 * bitwidth;
      }
    }
    if (symbol === 'SE0') break;
  }

  const firstSe0 = start + BigInt(edgeRel);
  const secondSymbol = symbolAt(start + BigInt(currentRel));
  advance();
  previousRel = currentRel;
  currentRel = targetRel;
  frames.push(packet(firstSe0, start + BigInt(edgeRel), ['SYM', secondSymbol]));
  const secondSe0 = start + BigInt(edgeRel);
  const lastSymbol = symbolAt(start + BigInt(currentRel));
  advance();
  previousRel = currentRel;
  const eopEnd = start + BigInt(edgeRel);
  frames.push(packet(secondSe0, eopEnd, ['SYM', lastSymbol]));
  frames.push(packet(eopStart, eopEnd, ['EOP', null]));
  return {
    frames,
    cells,
    wireMap: map,
    next: start + BigInt((wire.length + 2 + USB_PACKET_GAP_BITS) * width),
    packetEnd: eopEnd,
    wireBits: wire.length,
  };
}

export function packetFrames(
  bits: readonly number[],
  start: bigint,
  width: number,
): { frames: readonly ExpectedFrame[]; next: bigint; wireBits: number } {
  return signallingPacketLayout(bits, start, width);
}

function idleFrames(kind: 'reset' | 'keep-alive', start: bigint, bits: number, width: number): ExpectedFrame[] {
  const end = start + BigInt(bits * width);
  return [packet(start, end, [kind === 'reset' ? 'RESET' : 'KEEP ALIVE', null])];
}

function packetBits(seed: number, length: number): number[] {
  const random = randomWords(seed);
  const bits = [0];
  let ones = 0;
  while (bits.length < length) {
    const bit = ones < 4 ? random() & 1 : 0;
    bits.push(bit);
    ones = bit === 1 ? ones + 1 : 0;
  }
  if (bits.slice(0, 16).join('') === '0000000100111100') bits[1] = 1;
  return bits;
}

function boundaryCase(
  name: string,
  seed: number,
  sampleRate: number,
  startSample: bigint,
  signalling: UsbSignallingOption,
  busSpeed: UsbSpeed,
  items: readonly UsbSignallingItem[],
): UsbSignallingCase {
  return {
    name,
    kind: 'boundary',
    seed,
    sampleRate,
    startSample,
    channels: { dp: 1, dm: 3 },
    options: { signalling },
    chunkSamples: [1, 7, 257, 4093],
    minimumPayloadBits: 0,
    busSpeed,
    *generate() {
      const width = usbBitWidth(sampleRate, busSpeed);
      let cursor = startSample + BigInt(USB_LEAD_BITS * width);
      const expected: ExpectedFrame[] = [];
      const firstSample = startSample === 0n ? 0n : startSample + 1n;
      if (Number(firstSample) / sampleRate > 2.5e-6) expected.push(packet(0n, firstSample, ['RESET', null]));
      let payloadBits = 0;
      for (const item of items) {
        if (item.kind === 'packet') {
          const layout = packetFrames(item.bits, cursor, width);
          expected.push(...layout.frames);
          payloadBits += layout.wireBits;
          cursor = layout.next;
        } else {
          expected.push(...idleFrames(item.kind, cursor, item.bits, width));
          cursor += BigInt((item.bits + USB_PACKET_GAP_BITS) * width);
        }
      }
      yield { data: [...items], expected, payloadBits };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x55534253,
}: GenerationOptions = {}): Iterable<UsbSignallingCase> {
  const stuffing = [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 1, 0];
  yield boundaryCase('full-speed-stuffing-and-eop', seed, 48_000_000, 17n, 'full-speed', 'full-speed', [
    { kind: 'packet', bits: stuffing },
  ]);
  yield boundaryCase('automatic-low-speed', seed ^ 1, 6_000_000, 9_007_199_254_740_990n, 'automatic', 'low-speed', [
    { kind: 'packet', bits: [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1] },
  ]);
  yield boundaryCase('idle-reset-and-keep-alive', seed ^ 2, 6_000_000, 3n, 'low-speed', 'low-speed', [
    { kind: 'reset', bits: 5 },
    { kind: 'keep-alive', bits: 3 },
    { kind: 'packet', bits: [0, 1, 0, 1, 1, 0, 0, 1] },
  ]);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  yield {
    name: 'seeded-long-full-speed-bits',
    kind: 'long',
    seed,
    sampleRate: 96_000_000,
    startSample: 0n,
    channels: { dp: 2, dm: 5 },
    options: { signalling: 'full-speed' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    busSpeed: 'full-speed',
    *generate() {
      const width = usbBitWidth(96_000_000, 'full-speed');
      let cursor = BigInt(USB_LEAD_BITS * width);
      let payloadBits = 0;
      let index = 0;
      while (payloadBits < required) {
        const item: UsbSignalPacketItem = { kind: 'packet', bits: packetBits((seed + index * 0x9e3779b1) >>> 0, 48) };
        const layout = packetFrames(item.bits, cursor, width);
        cursor = layout.next;
        payloadBits += layout.wireBits;
        index++;
        yield { data: [item], expected: layout.frames, payloadBits: layout.wireBits };
      }
    },
  };
}
