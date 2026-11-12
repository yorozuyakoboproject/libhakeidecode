import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { TimingCase, TimingItem } from './generator.js';

export function createEncoder(config: TimingCase): WaveformEncoder<TimingItem> {
  const bit = config.channels.data;
  if (bit === undefined) throw new Error('Timing encoder requires a data channel');
  if (!Number.isSafeInteger(config.initialSamples) || config.initialSamples < 1)
    throw new RangeError('Timing initial sample count must be positive');
  const writer = new PackedWaveformWriter(config);
  let level: 0 | 1 = config.initialLevel;
  let started = false;
  const write = function* (samples: number): Iterable<SignalWindow> {
    yield* writer.write(level << bit, samples);
  };
  return {
    *push(items) {
      if (!items.length) return;
      if (!started) {
        started = true;
        yield* write(config.initialSamples);
      }
      for (const item of items) {
        if (!Number.isSafeInteger(item.hold) || item.hold < 1)
          throw new RangeError('Timing hold length must be a positive integer');
        level = level ? 0 : 1;
        yield* write(item.hold);
      }
    },
    *finish() {
      if (!started) yield* write(config.initialSamples);
      yield* writer.finish();
    },
  };
}
