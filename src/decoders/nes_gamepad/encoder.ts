import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { NesGamepadCase } from './generator.js';

export function createEncoder(config: NesGamepadCase): WaveformEncoder<number> {
  const writer = new PackedWaveformWriter(config);
  const clkBit = config.channels.clk!;
  const misoBit = config.channels.miso!;
  let started = false;
  const packed = (clk: number, miso: number): number => (clk << clkBit) | (miso << misoBit);
  function* emit(clk: number, miso: number, samples = 1): Iterable<SignalWindow> {
    yield* writer.write(packed(clk, miso), samples);
  }
  return {
    *push(data): Iterable<SignalWindow> {
      if (!started) {
        started = true;
        yield* emit(1, 1, config.initialSamples);
      }
      for (const value of data) {
        if (!Number.isInteger(value) || value < 0 || value > 0xff)
          throw new RangeError('NES gamepad byte must be in the range 0..255');
        for (let bit = 7; bit >= 0; bit--) {
          const level = (value >>> bit) & 1;
          yield* emit(0, level);
          yield* emit(1, level);
        }
      }
    },
    *finish(): Iterable<SignalWindow> {
      if (!started) yield* emit(1, 1, config.initialSamples);
      yield* emit(1, 1, 2);
      yield* writer.finish();
    },
  };
}
