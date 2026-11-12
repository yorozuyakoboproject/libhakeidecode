import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { St25Case, St25Frame } from './generator.js';

const HALF_SAMPLES = 1;
const IDLE_HALVES = 64;

export function createEncoder(config: St25Case): WaveformEncoder<St25Frame> {
  const writer = new PackedWaveformWriter(config);
  const clk = config.channels.clk!;
  const mosiBit = config.channels.mosi;
  const misoBit = config.channels.miso;
  const cs = config.channels.cs;
  let started = false;

  const packed = (clock: number, mosi: number, miso: number, select: number): number => {
    let value = clock << clk;
    if (mosiBit !== undefined) value |= mosi << mosiBit;
    if (misoBit !== undefined) value |= miso << misoBit;
    if (cs !== undefined) value |= select << cs;
    return value;
  };

  function* idle(halves: number): Iterable<SignalWindow> {
    yield* writer.write(packed(0, 0, 0, 1), halves * HALF_SAMPLES);
  }

  function* transaction(item: St25Frame): Iterable<SignalWindow> {
    yield* writer.write(packed(0, 0, 0, 0), 2 * HALF_SAMPLES);
    for (const word of item.words) {
      const mosi = word.mosi & 0xff;
      const miso = word.miso & 0xff;
      for (let bit = 7; bit >= 0; bit--) {
        const mosiValue = (mosi >>> bit) & 1;
        const misoValue = (miso >>> bit) & 1;
        yield* writer.write(packed(0, mosiValue, misoValue, 0), HALF_SAMPLES);
        yield* writer.write(packed(1, mosiValue, misoValue, 0), HALF_SAMPLES);
        yield* writer.write(packed(0, mosiValue, misoValue, 0), HALF_SAMPLES);
      }
    }
    yield* writer.write(packed(0, 0, 0, 1), 2 * HALF_SAMPLES);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* idle(3);
      }
      for (const item of data) {
        yield* transaction(item);
        yield* idle(IDLE_HALVES);
      }
    },
    *finish() {
      if (!started) yield* idle(3);
      yield* idle(3);
      yield* writer.finish();
    },
  };
}
