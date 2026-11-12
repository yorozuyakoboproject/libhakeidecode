import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Ws281xCase, WsPixel } from './generator.js';

export function createEncoder(config: Ws281xCase): WaveformEncoder<WsPixel> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.din!;
  const wireorder = [...String(config.options.wireorder).toLowerCase()];
  const resetSamples = Math.round(config.sampleRate * 50e-6) + 16;
  const timing = config.bitTiming ?? { zeroHigh: 2, oneHigh: 3, period: 5 };
  let started = false;
  function* level(value: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(value << channel, samples);
  }
  function* bit(value: number): Iterable<SignalWindow> {
    const high = value ? timing.oneHigh : timing.zeroHigh;
    yield* level(1, high);
    yield* level(0, timing.period - high);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* level(0, 4);
      }
      for (const pixel of data) {
        for (const name of wireorder) {
          const value = name === 'r' ? pixel.r : name === 'g' ? pixel.g : name === 'b' ? pixel.b : (pixel.w ?? 0);
          for (let index = 7; index >= 0; index--) yield* bit((value >>> index) & 1);
        }
      }
      yield* level(0, resetSamples);
    },
    *finish() {
      yield* level(1, 3);
      yield* writer.finish();
    },
  };
}
