import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { sdqHighSamples, sdqLowSamples, sdqWidth } from './generator.js';
import type { SdqCase, SdqItem } from './generator.js';

export function createEncoder(config: SdqCase): WaveformEncoder<SdqItem> {
  const writer = new PackedWaveformWriter(config),
    bit = config.channels.sdq,
    high = bit === undefined ? 0 : 1 << bit,
    width = sdqWidth(config.sampleRate, Number(config.options.bitrate)),
    highSamples = sdqHighSamples(width);
  let started = false;
  function* write(level: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(level ? high : 0, samples);
  }
  return {
    *push(items) {
      if (!started) {
        started = true;
        yield* write(1, config.initialSamples);
      }
      for (const item of items) {
        const low = sdqLowSamples(item, width);
        if (low < 1) throw new RangeError('SDQ pulse cannot be represented');
        yield* write(0, low);
        yield* write(1, highSamples);
      }
    },
    *finish() {
      if (!started) yield* write(1, config.initialSamples);
      yield* writer.finish();
    },
  };
}
