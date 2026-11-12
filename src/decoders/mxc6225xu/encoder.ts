import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { MxcCase, MxcOperation } from './generator.js';

export function createEncoder(config: MxcCase): WaveformEncoder<MxcOperation> {
  const writer = new PackedWaveformWriter(config),
    sclBit = config.channels.scl!,
    sdaBit = config.channels.sda!,
    halfSamples = config.sampleRate / 800_000;
  let halves = 0,
    samples = 0,
    started = false,
    busActive = false;

  const packed = (scl: number, sda: number): number => (scl << sclBit) | (sda << sdaBit);

  function* emit(scl: number, sda: number, duration: number): Iterable<SignalWindow> {
    halves += duration;
    const end = Math.round(halves * halfSamples);
    yield* writer.write(packed(scl, sda), end - samples);
    samples = end;
  }

  function* start(repeated: boolean): Iterable<SignalWindow> {
    if (!repeated) {
      yield* emit(1, 1, 2);
      yield* emit(1, 0, 1);
    } else {
      yield* emit(0, 1, 1);
      yield* emit(1, 1, 1);
      yield* emit(1, 0, 1);
    }
    yield* emit(0, 0, 1);
    busActive = true;
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

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(1, 1, 3);
      }
      for (const operation of data) {
        yield* start(operation.repeatedStart ?? false);
        const read = operation.direction === 'read' ? 1 : 0;
        if ((operation.addressBits ?? 7) === 10) {
          yield* byte(0xf0 | ((operation.address >>> 7) & 0x06) | read);
          yield* bit(0);
          yield* byte(operation.address & 0xff);
          yield* bit(0);
        } else {
          yield* byte(((operation.address & 0x7f) << 1) | read);
          yield* bit(0);
        }
        for (const value of operation.data) {
          yield* byte(value);
          yield* bit(0);
        }
        if (operation.stop !== false) {
          yield* emit(0, 0, 1);
          yield* emit(1, 0, 1);
          yield* emit(1, 1, 2);
          busActive = false;
        }
      }
    },
    *finish() {
      if (busActive) {
        yield* emit(0, 0, 1);
        yield* emit(1, 0, 1);
        yield* emit(1, 1, 2);
      }
      yield* emit(1, 1, 3);
      yield* writer.finish();
    },
  };
}
