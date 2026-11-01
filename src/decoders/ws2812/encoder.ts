import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { WS2812Case, WS2812Item } from './generator.js';

export function createEncoder(config: WS2812Case): WaveformEncoder<WS2812Item> {
  const writer = new PackedWaveformWriter(config),
    bit = config.channels.din!,
    high = 1 << bit,
    resetSamples = Math.round(config.sampleRate * 50e-6);
  let elapsedNs = 0,
    samples = 0,
    started = false;
  function* pulse(level: number, nanoseconds: number): Iterable<SignalWindow> {
    elapsedNs += nanoseconds;
    const end = Math.round((elapsedNs * config.sampleRate) / 1e9);
    yield* writer.write(level ? high : 0, end - samples);
    samples = end;
  }
  function* rawBit(value: number): Iterable<SignalWindow> {
    const skew = 1 + config.timingSkew;
    if (value) {
      yield* pulse(1, 800 * skew);
      yield* pulse(0, 450 / skew);
    } else {
      yield* pulse(1, 400 * skew);
      yield* pulse(0, 850 / skew);
    }
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* writer.write(0, 10);
      }
      for (const item of data) {
        if (item.kind === 'reset') {
          yield* writer.write(0, resetSamples);
        } else if (item.kind === 'partial') {
          for (const value of item.bits) yield* rawBit(value);
        } else {
          const values = { R: item.r, G: item.g, B: item.b, W: item.w ?? 0 };
          for (const channel of config.options.wireorder as string) {
            const value = values[channel as 'R' | 'G' | 'B' | 'W'];
            if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Invalid WS2812 pixel');
            for (let shift = 7; shift >= 0; shift--) yield* rawBit((value >>> shift) & 1);
          }
        }
      }
    },
    *finish() {
      yield* writer.write(0, resetSamples);
      yield* writer.finish();
    },
  };
}
