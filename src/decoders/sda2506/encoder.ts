import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Sda2506Case, SdaTransaction } from './generator.js';

export function createEncoder(config: Sda2506Case): WaveformEncoder<SdaTransaction> {
  const writer = new PackedWaveformWriter(config),
    clkBit = config.channels.clk!,
    dataBit = config.channels.d!,
    ceBit = config.channels.ce!;
  let started = false;
  const packed = (clk: number, data: number, ce: number): number => (clk << clkBit) | (data << dataBit) | (ce << ceBit);
  function* emit(clk: number, data: number, ce: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(clk, data, ce), samples);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(0, 0, 1, 2);
      }
      for (const item of data) {
        for (const bit of item.command) {
          yield* emit(0, bit, 1, 2);
          yield* emit(1, bit, 1, 2);
          yield* emit(0, bit, 1, 2);
        }
        yield* emit(0, item.chipEnableData, 0, 2);
        if (item.command.at(-1) === 0 && item.readData.length) {
          yield* emit(1, 0, 0, 2);
          for (const value of item.readData)
            for (let shift = 7; shift >= 0; shift--) {
              const bit = (value >>> shift) & 1;
              yield* emit(0, bit, 0, 2);
              yield* emit(1, bit, 0, 2);
            }
        } else yield* emit(0, item.chipEnableData, 0, 2);
        yield* emit(0, 0, 1, 2);
      }
    },
    *finish() {
      yield* emit(0, 0, 1, 2);
      yield* writer.finish();
    },
  };
}
