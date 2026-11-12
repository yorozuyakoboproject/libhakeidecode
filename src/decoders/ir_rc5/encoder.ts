import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { RC5_GAP_HALF_BITS, RC5_LEAD_HALF_BITS, RC5_TRAIL_HALF_BITS, type Rc5Case } from './generator.js';
import { rc5FrameBits, rc5HalfBit, type Rc5Frame } from './index.js';

export function createEncoder(config: Rc5Case): WaveformEncoder<Rc5Frame> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.ir!;
  const halfbit = rc5HalfBit(config.sampleRate);
  const extended = config.options.protocol === 'extended';
  const activeLow = config.options.polarity !== 'active-high';
  const idle = 1;
  const active = 0;
  let started = false;

  function* write(level: number, halfBits: number): Iterable<SignalWindow> {
    yield* writer.write((activeLow ? level : level ^ 1) << channel, halfBits * halfbit);
  }

  return {
    *push(data) {
      for (const frame of data) {
        if (!started) {
          started = true;
          yield* write(idle, RC5_LEAD_HALF_BITS);
        } else {
          yield* write(idle, RC5_GAP_HALF_BITS);
        }
        for (const bit of rc5FrameBits(frame, extended)) {
          const base = bit ? idle : active;
          yield* write(base, 1);
          yield* write(base ^ 1, 1);
        }
      }
    },
    *finish() {
      yield* write(idle, RC5_TRAIL_HALF_BITS);
      yield* writer.finish();
    },
  };
}
