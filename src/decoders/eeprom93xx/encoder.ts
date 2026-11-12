import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Eeprom93xxCase, MicrowireFrame } from './generator.js';

export function createEncoder(config: Eeprom93xxCase): WaveformEncoder<MicrowireFrame> {
  const writer = new PackedWaveformWriter(config),
    csBit = config.channels.cs!,
    skBit = config.channels.sk!,
    siBit = config.channels.si!,
    soBit = config.channels.so!;
  const packed = (cs: number, sk: number, si: number, so: number): number =>
    (cs << csBit) | (sk << skBit) | (si << siBit) | (so << soBit);
  function* emit(cs: number, sk: number, si: number, so: number, duration: number): Iterable<SignalWindow> {
    yield* writer.write(packed(cs, sk, si, so), duration);
  }
  return {
    *push(data) {
      for (const item of data) {
        const si = [1, ...item.si],
          so = [0, ...item.so];
        yield* emit(0, 0, 0, 0, 2);
        yield* emit(1, 0, si[0]!, so[0]!, 2);
        yield* emit(1, 1, si[0]!, so[0]!, 1);
        yield* emit(1, 0, si[0]!, so[0]!, 1);
        for (let index = 1; index < si.length; index++) {
          yield* emit(1, 0, si[index]!, so[index]!, 1);
          yield* emit(1, 1, si[index]!, so[index]!, 1);
          yield* emit(1, 0, si[index]!, so[index]!, 1);
        }
        yield* emit(0, 0, 0, 0, 2);
      }
    },
    *finish() {
      yield* emit(0, 0, 0, 0, 2);
      yield* writer.finish();
    },
  };
}
