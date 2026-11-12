import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import {
  AC97_BIT_SAMPLES,
  AC97_FINAL_HIGH_SAMPLES,
  AC97_FRAME_BITS,
  AC97_INITIAL_LOW_SAMPLES,
  AC97_LEAD_BITS,
  AC97_SLOT_BITS,
  type AC97Case,
  type AC97Frame,
} from './generator.js';

function frameBits(slots: readonly number[]): number[] {
  if (slots.length !== AC97_SLOT_BITS.length) throw new RangeError('AC97 frame requires 13 slots');
  const bits: number[] = [];
  for (let slot = 0; slot < slots.length; slot++) {
    const width = AC97_SLOT_BITS[slot]!;
    const value = slots[slot]!;
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** width)
      throw new RangeError(`AC97 slot ${slot} does not fit in ${width} bits`);
    for (let shift = width - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1);
  }
  if (bits.length !== AC97_FRAME_BITS) throw new RangeError('AC97 frame must contain 256 bits');
  return bits;
}

export function createEncoder(config: AC97Case): WaveformEncoder<AC97Frame> {
  const writer = new PackedWaveformWriter(config);
  const syncBit = config.channels.sync!;
  const clkBit = config.channels.clk!;
  const outBit = config.channels.out;
  const inBit = config.channels.in;
  let started = false;

  const pack = (sync: number, clk: number, out: number, input: number): number =>
    (sync << syncBit) |
    (clk << clkBit) |
    (outBit === undefined ? 0 : out << outBit) |
    (inBit === undefined ? 0 : input << inBit);

  function* bit(sync: number, clk: number, out: number, input: number): Iterable<SignalWindow> {
    yield* writer.write(pack(sync, clk, out, input), AC97_BIT_SAMPLES / 2);
    yield* writer.write(pack(sync, clk ^ 1, out, input), AC97_BIT_SAMPLES / 2);
  }

  function* lead(): Iterable<SignalWindow> {
    for (let index = 0; index < AC97_LEAD_BITS; index++) yield* bit(index === AC97_LEAD_BITS - 1 ? 1 : 0, 1, 0, 0);
  }

  function* frame(frame: AC97Frame): Iterable<SignalWindow> {
    const out = frameBits(frame.out);
    const input = frameBits(frame.in);
    for (let index = 0; index < AC97_FRAME_BITS; index++) {
      const sync = index < 16 || index === AC97_FRAME_BITS - 1 ? 1 : 0;
      yield* bit(sync, 1, out[index]!, input[index]!);
    }
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* writer.write(pack(0, 0, 0, 0), AC97_INITIAL_LOW_SAMPLES);
        yield* lead();
      }
      for (const item of data) yield* frame(item);
    },
    *finish() {
      if (started) yield* writer.write(pack(0, 1, 0, 0), AC97_FINAL_HIGH_SAMPLES);
      yield* writer.finish();
    },
  };
}
