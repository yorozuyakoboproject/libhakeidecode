import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { RC6_GAP_HALF_BITS, RC6_LEAD_HALF_BITS, rc6FrameRuns, type Rc6Case } from './generator.js';
import { rc6HalfBit, type Rc6Frame } from './index.js';

export function createEncoder(config: Rc6Case): WaveformEncoder<Rc6Frame> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.ir!;
  const halfbit = rc6HalfBit(config.sampleRate);
  const invert = config.options.polarity === 'active-high';
  const idle = 1;
  let started = false;

  function* write(level: number, halfBits: number): Iterable<SignalWindow> {
    yield* writer.write((invert ? level ^ 1 : level) << channel, halfBits * halfbit);
  }

  return {
    *push(data) {
      for (const frame of data) {
        if (!started) {
          started = true;
          yield* write(idle, RC6_LEAD_HALF_BITS);
        } else {
          yield* write(idle, RC6_GAP_HALF_BITS);
        }
        for (const run of rc6FrameRuns(frame)) yield* write(run.level, run.halfBits);
      }
    },
    *finish() {
      // The upstream decoder commits a completed frame after a six-half-bit timeout.
      yield* write(idle, RC6_GAP_HALF_BITS);
      yield* write(idle ^ 1, 1);
      yield* write(idle, 1);
      yield* writer.finish();
    },
  };
}
