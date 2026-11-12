import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { daliFrameBits, daliHalfbit, type DaliCase, type DaliFrame } from './generator.js';

export function createEncoder(config: DaliCase): WaveformEncoder<DaliFrame> {
  const writer = new PackedWaveformWriter(config);
  const line = config.channels.dali!;
  const halfbit = daliHalfbit(config.sampleRate);
  const invert = config.options.polarity === 'active-high' ? 1 : 0;
  let started = false;

  function* half(level: number): Iterable<SignalWindow> {
    yield* writer.write((level ^ invert) << line, halfbit);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* half(1);
      }
      for (const frame of data) {
        for (const bit of daliFrameBits(frame)) {
          yield* half(bit ^ 1);
          yield* half(bit);
        }
        for (let index = 0; index < 4; index++) yield* half(1);
      }
    },
    *finish() {
      if (!started) yield* half(1);
      yield* writer.finish();
    },
  };
}
