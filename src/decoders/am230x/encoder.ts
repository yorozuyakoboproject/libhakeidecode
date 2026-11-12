import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { AM230X_PROFILES, am230xItemBits } from './generator.js';
import type { Am230xCase, Am230xItem } from './generator.js';

export function createEncoder(config: Am230xCase): WaveformEncoder<Am230xItem> {
  const writer = new PackedWaveformWriter(config),
    profile = AM230X_PROFILES[config.profile],
    bit = config.channels.sda;
  if (bit === undefined) throw new Error('AM230x encoder requires an SDA channel');
  const high = 1 << bit;
  let elapsedMicros = 0,
    samples = 0,
    started = false;
  function* run(level: number, micros: number): Iterable<SignalWindow> {
    if (micros < 0) throw new RangeError('Invalid AM230x pulse duration');
    elapsedMicros += micros;
    const end = Math.round((elapsedMicros * config.sampleRate) / 1_000_000);
    yield* writer.write(level ? high : 0, end - samples);
    samples = end;
  }
  return {
    *push(items) {
      if (!started) {
        started = true;
        yield* run(1, config.initialHighMicros);
      }
      for (const item of items) {
        if (item.kind === 'noise') {
          yield* run(0, 300);
          yield* run(1, 30);
          continue;
        }
        yield* run(0, profile.startLow);
        yield* run(1, profile.startHigh);
        yield* run(0, profile.responseLow);
        yield* run(1, profile.responseHigh);
        for (const value of am230xItemBits(item)) {
          yield* run(0, profile.bitLow);
          yield* run(1, value ? profile.bit1High : profile.bit0High);
        }
        yield* run(0, profile.endLow);
        yield* run(1, profile.endHigh);
      }
    },
    *finish() {
      if (!started) yield* run(1, config.initialHighMicros);
      yield* writer.finish();
    },
  };
}
