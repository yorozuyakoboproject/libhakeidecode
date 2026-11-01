import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { RF433Case, RF433Word } from './generator.js';

export function createEncoder(config: RF433Case): WaveformEncoder<RF433Word> {
  const writer = new PackedWaveformWriter(config),
    bit = config.channels.data!,
    high = 1 << bit,
    unit =
      config.sampleRate >= 1_000_000
        ? Math.round(config.sampleRate * 350e-6)
        : Math.max(2, Math.round(config.sampleRate * 350e-6));
  let started = false;
  function* write(level: number, units: number): Iterable<SignalWindow> {
    const count = Math.max(1, Math.round(units * unit));
    yield* writer.write(level ? high : 0, count);
  }
  function* sync(): Iterable<SignalWindow> {
    yield* write(1, 1);
    yield* write(0, 31);
  }
  function* pulse(value: number, invalid = false): Iterable<SignalWindow> {
    if (invalid) {
      yield* write(1, 1);
      yield* write(0, 1);
    } else if (value === 2) {
      yield* write(1, 1);
      yield* write(0, 1);
    } else if (value === 1) {
      yield* write(1, 3);
      yield* write(0, 1);
    } else {
      yield* write(1, 1);
      yield* write(0, 3);
    }
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(0, 4);
      }
      for (const word of data) {
        if (word.noise) {
          yield* write(1, 1);
          yield* write(0, 1);
          yield* write(1, 2);
          yield* write(0, 2);
          continue;
        }
        yield* sync();
        if (config.options.encoding === 'ev1527') {
          const code = (word.code ?? 0) & 0xffffff;
          for (let index = 23; index >= 0; index--) yield* pulse((code >>> index) & 1, !!word.invalid && index === 11);
        } else {
          const trits = word.trits ?? [];
          if (trits.length !== 12) throw new RangeError('PT2262 requires 12 trits');
          for (const trit of trits) yield* pulse(trit);
        }
      }
    },
    *finish() {
      yield* write(1, 1);
      yield* write(0, 30);
      yield* writer.finish();
    },
  };
}
