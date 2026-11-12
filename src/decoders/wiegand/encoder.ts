import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { WiegandCase, WiegandRun } from './generator.js';

export function createEncoder(config: WiegandCase): WaveformEncoder<WiegandRun> {
  const writer = new PackedWaveformWriter(config);
  const d0Bit = config.channels.d0!;
  const d1Bit = config.channels.d1!;
  const inactive = config.options.active === 'high' ? 0 : 1;
  const idle = (inactive << d0Bit) | (inactive << d1Bit);
  let started = false;
  return {
    *push(data): Iterable<SignalWindow> {
      if (!started) {
        started = true;
        yield* writer.write(idle, config.initialHold);
      }
      for (const run of data) {
        if (!Number.isSafeInteger(run.hold) || run.hold < 1)
          throw new RangeError('Wiegand hold length must be a positive integer');
        yield* writer.write((run.d0 << d0Bit) | (run.d1 << d1Bit), run.hold);
      }
    },
    *finish(): Iterable<SignalWindow> {
      if (!started) yield* writer.write(idle, config.initialHold);
      yield* writer.finish();
    },
  };
}
