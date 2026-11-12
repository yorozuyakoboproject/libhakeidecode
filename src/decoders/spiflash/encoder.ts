import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { SpiflashCase, SpiflashFrame } from './generator.js';

export function createEncoder(config: SpiflashCase): WaveformEncoder<SpiflashFrame> {
  const writer = new PackedWaveformWriter(config),
    clkBit = config.channels.clk!,
    mosiBit = config.channels.mosi!,
    misoBit = config.channels.miso!,
    csBit = config.channels.cs!,
    halfSamples = config.sampleRate / 4_000_000;
  let halves = 0,
    samples = 0,
    started = false;
  const packed = (clk: number, mosi: number, miso: number, cs: number): number =>
    (clk << clkBit) | (mosi << mosiBit) | (miso << misoBit) | (cs << csBit);
  function* emit(clk: number, mosi: number, miso: number, cs: number, duration: number): Iterable<SignalWindow> {
    halves += duration;
    const end = Math.round(halves * halfSamples);
    yield* writer.write(packed(clk, mosi, miso, cs), end - samples);
    samples = end;
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(0, 0, 0, 1, 4);
      }
      for (const item of data) {
        yield* emit(0, 0, 0, 0, 4);
        for (const frameWord of item.words) {
          for (let shift = 7; shift >= 0; shift--) {
            const mosi = ((frameWord.mosi ?? 0) >>> shift) & 1,
              miso = ((frameWord.miso ?? 0) >>> shift) & 1;
            yield* emit(0, mosi, miso, 0, 1);
            yield* emit(1, mosi, miso, 0, 1);
            yield* emit(0, mosi, miso, 0, 1);
          }
        }
        yield* emit(0, 0, 0, 1, 16);
      }
    },
    *finish() {
      yield* emit(0, 0, 0, 1, 4);
      yield* writer.finish();
    },
  };
}
