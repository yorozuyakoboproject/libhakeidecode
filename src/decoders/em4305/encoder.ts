import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Em4305Block, Em4305Case } from './generator.js';

function timing(config: Em4305Case) {
  const fieldClock = config.sampleRate / Number(config.options.coilfreq ?? 125_000);
  const start = Math.max(1, Math.round(Number(config.options.first_field_stop ?? 40) * fieldClock) + 1);
  const zero = Math.max(
    1,
    Math.round(
      ((Number(config.options.w_zero_on_min ?? 15) + Number(config.options.w_zero_off_max ?? 27)) / 2) * fieldClock,
    ),
  );
  const one = Math.max(1, Math.round(Number(config.options.w_one_max ?? 32) * fieldClock * 1.2));
  const terminator = Math.round(300 * fieldClock) + 1;
  return { start, zero, one, terminator };
}

export function createEncoder(config: Em4305Case): WaveformEncoder<Em4305Block> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.data!;
  const { start, zero, one, terminator } = timing(config);
  let level = 0;

  function* run(samples: number): Iterable<SignalWindow> {
    yield* writer.write(level << channel, samples);
  }

  return {
    *push(data) {
      for (const block of data) {
        yield* run(start);
        level ^= 1;
        for (const bit of block.bits) {
          yield* run(bit ? one : zero);
          level ^= 1;
        }
        yield* run(terminator);
        level ^= 1;
        yield* run(1);
        level ^= 1;
      }
    },
    *finish() {
      yield* writer.finish();
    },
  };
}
