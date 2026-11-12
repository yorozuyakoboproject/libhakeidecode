import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { OnewireTimeline } from './generator.js';
import type { OnewireCase, OnewireOperation } from './generator.js';

export function createEncoder(config: OnewireCase): WaveformEncoder<OnewireOperation> {
  const writer = new PackedWaveformWriter(config),
    bit = config.channels.owr!,
    timeline = new OnewireTimeline(config);
  let samples = 0;
  const run = (level: number, target: bigint): Iterable<SignalWindow> => {
    const end = Number(target - config.startSample),
      count = end - samples;
    samples = end;
    return writer.write(level << bit, count);
  };
  return {
    *push(data) {
      for (const operation of data) {
        if (operation.kind === 'reset') {
          const event = timeline.reset(operation);
          yield* run(1, event.fall);
          yield* run(0, event.rise);
          if (event.presenceStart !== null && event.presenceEnd !== null) {
            yield* run(1, event.presenceStart);
            yield* run(0, event.presenceEnd);
          }
          yield* run(1, event.end);
        } else {
          const events = timeline.bits(operation);
          for (const event of events) {
            yield* run(1, event.fall);
            yield* run(0, event.rise);
            yield* run(1, event.end);
          }
        }
      }
    },
    *finish() {
      yield* run(1, timeline.finish());
      yield* writer.finish();
    },
  };
}
