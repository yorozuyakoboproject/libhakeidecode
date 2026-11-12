import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SwimCase, SwimStep } from './generator.js';

export function createEncoder(config: SwimCase): WaveformEncoder<SwimStep> {
  const writer = new PackedWaveformWriter(config);
  const swim = config.channels.swim;
  if (swim === undefined) throw new Error('SWIM encoder requires the SWIM channel');
  const packed = (level: number): number => level << swim;
  let level: 0 | 1 = 0;
  return {
    *push(data) {
      for (const step of data) {
        level = step.level;
        yield* writer.write(packed(step.level), step.samples);
      }
      yield* writer.finish();
    },
    *finish() {
      if (level === 1) yield* writer.write(packed(0), 1);
      yield* writer.finish();
    },
  };
}
