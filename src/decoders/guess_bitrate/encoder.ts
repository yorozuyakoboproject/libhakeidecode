import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { GuessBitrateCase, GuessBitrateItem } from './generator.js';

export function createEncoder(config: GuessBitrateCase): WaveformEncoder<GuessBitrateItem> {
  const bit = config.channels.data;
  if (bit === undefined) throw new Error('Guess bitrate encoder requires a data channel');
  if (!Number.isSafeInteger(config.initialSamples) || config.initialSamples < 1)
    throw new RangeError('Guess bitrate initial sample count must be positive');
  const writer = new PackedWaveformWriter(config);
  let level = config.initialLevel;
  let started = false;
  const write = function* (value: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(value << bit, samples);
  };
  return {
    *push(items) {
      if (!items.length) return;
      if (!started) {
        started = true;
        yield* write(level, config.initialSamples);
      }
      for (const item of items) {
        if (!Number.isSafeInteger(item.hold) || item.hold < 1)
          throw new RangeError('Guess bitrate hold length must be a positive integer');
        if (item.level === level) throw new RangeError('Guess bitrate item has no edge');
        level = item.level;
        yield* write(level, item.hold);
      }
    },
    *finish() {
      if (!started) yield* write(level, config.initialSamples);
      yield* writer.finish();
    },
  };
}
