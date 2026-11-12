import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { CecCase, CecMessage } from './generator.js';

export function createEncoder(config: CecCase): WaveformEncoder<CecMessage> {
  const writer = new PackedWaveformWriter(config);
  const bit = config.channels.cec!;
  const startLow = 7;
  const startTotal = 9;
  const bitTotal = 5;
  const zeroLow = 3;
  const oneLow = 1;
  const ackGap = 12;
  let started = false;
  function* emit(level: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(level << bit, samples);
  }
  function* valueBit(value: number): Iterable<SignalWindow> {
    const low = value ? oneLow : zeroLow;
    yield* emit(0, low);
    yield* emit(1, bitTotal - low);
  }
  function* message(item: CecMessage): Iterable<SignalWindow> {
    yield* emit(0, startLow);
    yield* emit(1, startTotal - startLow);
    for (let index = 0; index < item.bytes.length; index++) {
      const value = item.bytes[index]!;
      for (let position = 7; position >= 0; position--) yield* valueBit((value >>> position) & 1);
      yield* valueBit((item.eoms?.[index] ?? index === item.bytes.length - 1) ? 1 : 0);
      const ack = item.acks?.[index] ?? true;
      const broadcast = (item.bytes[0]! & 0x0f) === 0x0f;
      const wireNack = broadcast ? ack : !ack;
      yield* valueBit(wireNack ? 1 : 0);
      if ((item.eoms?.[index] ?? index === item.bytes.length - 1) || !ack) break;
    }
    yield* emit(1, ackGap);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(1, 2);
      }
      for (const item of data) yield* message(item);
    },
    *finish() {
      yield* emit(1, 4);
      yield* writer.finish();
    },
  };
}
