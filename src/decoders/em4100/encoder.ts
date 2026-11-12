import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { EM4100_BIT_SAMPLES, type Em4100Case, type Em4100Tag } from './generator.js';

function wireLevels(tag: Em4100Tag, invert: boolean): number[] {
  const levels: number[] = [];
  for (const bit of [...tag.bits, 0]) for (const half of [bit & 1, (bit & 1) ^ 1]) levels.push(half ^ (invert ? 1 : 0));
  return levels;
}

export function createEncoder(config: Em4100Case): WaveformEncoder<Em4100Tag> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.data!;
  const invert = config.options.polarity === 'active-low';
  const halfSamples = EM4100_BIT_SAMPLES / 2;
  let level = invert ? 0 : 1;
  let run = 0;

  function* flush(): Iterable<SignalWindow> {
    if (!run) return;
    yield* writer.write(level << channel, run);
    run = 0;
  }

  function* segment(value: number): Iterable<SignalWindow> {
    if (value !== level) {
      yield* flush();
      level = value;
    }
    run += halfSamples;
  }

  return {
    *push(data) {
      for (const tag of data) {
        for (const value of wireLevels(tag, invert)) yield* segment(value);
        yield* flush();
      }
    },
    *finish() {
      if (!run) yield* writer.write(level << channel, halfSamples);
      yield* flush();
      yield* writer.finish();
    },
  };
}
