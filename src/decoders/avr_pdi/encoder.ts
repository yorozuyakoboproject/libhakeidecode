import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { AvrPdiCase, AvrPdiFrame } from './generator.js';

export function createEncoder(config: AvrPdiCase): WaveformEncoder<AvrPdiFrame> {
  const writer = new PackedWaveformWriter(config),
    resetBit = config.channels.reset!,
    dataBit = config.channels.data!;
  let started = false;
  const packed = (reset: number, data: number): number => (reset << resetBit) | (data << dataBit);
  function* emit(reset: number, data: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(reset, data), samples);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(0, 0, 2);
        yield* emit(1, 0, 2);
        yield* emit(0, 0, 2);
      }
      for (const frame of data)
        for (const bit of frame.bits) {
          yield* emit(0, bit, 2);
          yield* emit(1, bit, 2);
          yield* emit(0, bit, 2);
        }
    },
    *finish() {
      yield* emit(0, 0, 2);
      yield* writer.finish();
    },
  };
}
