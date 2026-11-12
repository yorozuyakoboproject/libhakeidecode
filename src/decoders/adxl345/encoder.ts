import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { AdxlCase, AdxlTransaction } from './generator.js';

export function createEncoder(config: AdxlCase): WaveformEncoder<AdxlTransaction> {
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
      for (const transaction of data) {
        yield* emit(0, 0, 0, 1, 2);
        yield* emit(0, 0, 0, 0, 2);
        for (let index = 0; index < transaction.mosi.length; index++) {
          const mosi = transaction.mosi[index]! & 0xff,
            miso = (transaction.miso?.[index] ?? 0) & 0xff;
          for (let shift = 7; shift >= 0; shift--) {
            const mosiBitValue = (mosi >>> shift) & 1,
              misoBitValue = (miso >>> shift) & 1;
            yield* emit(0, mosiBitValue, misoBitValue, 0, 1);
            yield* emit(1, mosiBitValue, misoBitValue, 0, 1);
            yield* emit(0, mosiBitValue, misoBitValue, 0, 1);
          }
        }
        yield* emit(0, 0, 0, 1, 2);
        if (transaction.pauseAfter) yield* emit(0, 0, 0, 1, 48);
      }
    },
    *finish() {
      yield* emit(0, 0, 0, 1, 4);
      yield* writer.finish();
    },
  };
}
