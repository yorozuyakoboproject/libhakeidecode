import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { DsiCase, DsiFrame } from './generator.js';
import { dsiDecodedBits } from './generator.js';

export function createEncoder(config: DsiCase): WaveformEncoder<DsiFrame> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.dsi!;
  const halfbit = Math.trunc((config.sampleRate * 0.0016667) / 2);
  const activeLow = config.options.polarity === 'active-low';
  let started = false;
  function* level(value: number, samples = halfbit): Iterable<SignalWindow> {
    yield* writer.write(value << channel, samples);
  }
  function* frame(item: DsiFrame): Iterable<SignalWindow> {
    const decoded = dsiDecodedBits(item);
    const bits = [0, ...decoded.slice(1)];
    for (const physical of bits) {
      if (activeLow) {
        yield* level(physical ^ 1);
        yield* level(physical);
      } else {
        yield* level(physical);
        yield* level(physical ^ 1);
      }
    }
    yield* level(activeLow ? 1 : 0);
    yield* level(activeLow ? 1 : 0);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* level(activeLow ? 1 : 0, 3);
      }
      for (const item of data) yield* frame(item);
    },
    *finish() {
      yield* level(activeLow ? 1 : 0, halfbit * 3);
      yield* writer.finish();
    },
  };
}
