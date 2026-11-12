import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { SdcardSdCase, SdToken } from './generator.js';

export function createEncoder(config: SdcardSdCase): WaveformEncoder<SdToken> {
  const writer = new PackedWaveformWriter(config),
    cmdBit = config.channels.cmd!,
    clkBit = config.channels.clk!;
  const packed = (clk: number, cmd: number): number => (clk << clkBit) | (cmd << cmdBit);
  function* emit(clk: number, cmd: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(clk, cmd), samples);
  }
  return {
    *push(data) {
      for (const item of data)
        for (const bit of item.bits) {
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
