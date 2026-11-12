import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { RoundtripCase, WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';

export interface LfastRun {
  readonly data: 0 | 1;
  readonly samples: number;
}

export function createEncoder(config: RoundtripCase<LfastRun>): WaveformEncoder<LfastRun> {
  const writer = new PackedWaveformWriter(config);
  const dataBit = config.channels.data;
  if (dataBit === undefined) throw new Error('LFAST encoder requires the data channel.');
  let started = false;

  const write = function* (value: number, samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(value << dataBit, samples);
  };

  return {
    *push(runs) {
      for (const run of runs) {
        if (!Number.isSafeInteger(run.samples) || run.samples < 1)
          throw new RangeError('LFAST run length must be a positive integer.');
        started = true;
        yield* write(run.data, run.samples);
      }
    },
    *finish() {
      if (!started) yield* write(0, 2);
      yield* writer.finish();
    },
  };
}
