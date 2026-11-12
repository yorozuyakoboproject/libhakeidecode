import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { I2cdemuxCase, I2COperation } from './generator.js';

export function createEncoder(config: I2cdemuxCase): WaveformEncoder<I2COperation> {
  const writer = new PackedWaveformWriter(config),
    scl = config.channels.scl!,
    sda = config.channels.sda!,
    packed = (sclValue: number, sdaValue: number): number => (sclValue << scl) | (sdaValue << sda);
  let started = false,
    active = false;
  function* emit(sclValue: number, sdaValue: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(sclValue, sdaValue), samples);
  }
  function* start(repeated: boolean): Iterable<SignalWindow> {
    if (repeated) {
      yield* emit(0, 1, 1);
      yield* emit(1, 1, 1);
    } else {
      yield* emit(1, 1, 2);
    }
    yield* emit(1, 0, 1);
    yield* emit(0, 0, 1);
    active = true;
  }
  function* bit(value: number): Iterable<SignalWindow> {
    const level = value & 1;
    yield* emit(0, level, 1);
    yield* emit(1, level, 1);
    yield* emit(0, level, 1);
  }
  function* byte(value: number): Iterable<SignalWindow> {
    for (let index = 7; index >= 0; index--) yield* bit(value >>> index);
  }
  function* stop(): Iterable<SignalWindow> {
    yield* emit(0, 0, 1);
    yield* emit(1, 0, 1);
    yield* emit(1, 1, 2);
    active = false;
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(1, 1, 3);
      }
      for (const operation of data) {
        yield* start(operation.repeatedStart ?? false);
        yield* byte(((operation.address & 0x7f) << 1) | (operation.direction === 'read' ? 1 : 0));
        yield* bit(operation.addressAck === false ? 1 : 0);
        for (let index = 0; index < operation.data.length; index++) {
          yield* byte(operation.data[index]!);
          yield* bit(operation.dataAcks?.[index] === false ? 1 : 0);
        }
        if (operation.stop !== false) yield* stop();
      }
    },
    *finish() {
      if (active) yield* stop();
      yield* emit(1, 1, 3);
      yield* writer.finish();
    },
  };
}
