import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { StepperCase, StepperItem } from './generator.js';

export function createEncoder(config: StepperCase): WaveformEncoder<StepperItem> {
  if (!Number.isInteger(config.stepSamples) || config.stepSamples < 2)
    throw new RangeError('Stepper period must contain at least two samples');
  const writer = new PackedWaveformWriter(config),
    stepBit = config.channels.step,
    dirBit = config.channels.dir;
  if (stepBit === undefined || dirBit === undefined) throw new Error('Stepper encoder requires step and dir');
  let direction = 0,
    started = false;
  const packed = (level: number): number => (level << stepBit) | (direction << dirBit);
  function* write(level: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(level), samples);
  }
  return {
    *push(items) {
      if (!items.length) return;
      if (!started) {
        started = true;
        direction = items[0]!.direction;
        yield* write(0, config.initialSamples);
      } else {
        direction = items[0]!.direction;
        yield* write(0, config.stepSamples - 1);
      }
      for (let index = 0; index < items.length; index++) {
        direction = items[index]!.direction;
        yield* write(1, 1);
        if (index + 1 < items.length) {
          direction = items[index + 1]!.direction;
          yield* write(0, config.stepSamples - 1);
        }
      }
    },
    *finish() {
      if (!started) yield* write(0, config.initialSamples);
      yield* writer.finish();
    },
  };
}
