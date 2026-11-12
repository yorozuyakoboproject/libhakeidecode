import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { CounterCase, CounterItem } from './generator.js';

export function createEncoder(config: CounterCase): WaveformEncoder<CounterItem> {
  const writer = new PackedWaveformWriter(config);
  const dataBit = config.channels.data;
  const resetBit = config.channels.reset;
  if (dataBit === undefined) throw new Error('Counter encoder requires a data channel');
  let data = config.initial.data;
  let reset = config.initial.reset ?? 0;
  let started = false;
  const packed = (): number => (data << dataBit) | (resetBit === undefined ? 0 : reset << resetBit);
  function* write(samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(), samples);
  }
  return {
    *push(items) {
      if (!started) {
        started = true;
        yield* write(2);
      }
      for (const item of items) {
        yield* write(Math.max(0, Math.trunc(item.hold ?? 0)));
        const nextData = item.data ?? data;
        const nextReset = item.reset ?? reset;
        if (nextData === data && nextReset === reset) throw new RangeError('Counter item has no edge');
        data = nextData;
        reset = nextReset;
        yield* write(1);
      }
    },
    *finish() {
      if (!started) yield* write(2);
      yield* writer.finish();
    },
  };
}
