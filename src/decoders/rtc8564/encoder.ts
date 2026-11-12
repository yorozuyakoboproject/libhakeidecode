import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { I2COperation, Rtc8564Case } from './generator.js';

export function createEncoder(config: Rtc8564Case): WaveformEncoder<I2COperation> {
  const writer = new PackedWaveformWriter(config);
  const sclBit = config.channels.scl;
  const sdaBit = config.channels.sda;
  if (sclBit === undefined || sdaBit === undefined) throw new Error('I2C encoder requires SCL and SDA channels');
  const halfSamples = config.sampleRate / 800_000;
  let halves = 0;
  let samples = 0;
  let started = false;
  let busActive = false;
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

  function* stop(): Iterable<SignalWindow> {
    yield* emit(0, 0, 1);
    yield* emit(1, 0, 1);
    yield* emit(1, 1, 2);
    busActive = false;
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
      if (busActive) yield* stop();
      yield* emit(1, 1, 3);
      yield* writer.finish();
    },
  };
}
