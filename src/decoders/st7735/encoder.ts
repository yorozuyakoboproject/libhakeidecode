import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { St7735Byte, St7735Case } from './generator.js';

export function createEncoder(config: St7735Case): WaveformEncoder<St7735Byte> {
  const writer = new PackedWaveformWriter(config);
  const csBit = config.channels.cs!,
    clkBit = config.channels.clk!,
    mosiBit = config.channels.mosi!,
    dcBit = config.channels.dc!;
  let started = false;
  const packed = (cs: number, clk: number, mosi: number, dc: number): number =>
    (cs << csBit) | (clk << clkBit) | (mosi << mosiBit) | (dc << dcBit);
  function* emit(cs: number, clk: number, mosi: number, dc: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(cs, clk, mosi, dc), samples);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(1, 0, 0, 0, 3);
      }
      yield* emit(0, 0, 0, 0, 2);
      for (const item of data) {
        const dc = item.command ? 0 : 1;
        yield* emit(0, 0, 0, dc, 1);
        for (let index = 7; index >= 0; index--) {
          const mosi = (item.value >>> index) & 1;
          yield* emit(0, 1, mosi, dc, 1);
          yield* emit(0, 0, mosi, dc, 1);
        }
        yield* emit(0, 0, 0, dc, 1);
      }
      yield* emit(1, 0, 0, 0, 2);
    },
    *finish() {
      yield* emit(1, 0, 0, 0, 3);
      yield* writer.finish();
    },
  };
}
