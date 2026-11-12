import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { GraycodeCase, GraycodeItem } from './generator.js';

export function createEncoder(config: GraycodeCase): WaveformEncoder<GraycodeItem> {
  if (!Number.isSafeInteger(config.initialSamples) || config.initialSamples < 1)
    throw new RangeError('Graycode initial sample count must be positive');
  const writer = new PackedWaveformWriter(config);
  const mappings = Object.entries(config.channels).sort((left, right) => left[1] - right[1]);
  if (!mappings.length) throw new Error('Graycode encoder requires at least one data channel');
  let state = config.initial;
  let started = false;

  const packed = (value: number): number =>
    mappings.reduce((word, [, bit], index) => word | (((value >>> index) & 1) << bit), 0);
  function* write(value: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(value), samples);
  }

  return {
    *push(items) {
      if (!items.length) return;
      if (!started) {
        started = true;
        yield* write(state, config.initialSamples);
      }
      for (const item of items) {
        if (!Number.isSafeInteger(item.hold) || item.hold < 1)
          throw new RangeError('Graycode hold length must be a positive integer');
        if (item.state === state) throw new RangeError('Graycode item has no state transition');
        state = item.state;
        yield* write(state, item.hold);
      }
    },
    *finish() {
      if (!started) yield* write(state, config.initialSamples);
      yield* writer.finish();
    },
  };
}
