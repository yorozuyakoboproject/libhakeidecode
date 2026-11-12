import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { XyCase, XyFrame } from './generator.js';

export function createEncoder(config: XyCase): WaveformEncoder<XyFrame> {
  const writer = new PackedWaveformWriter(config);
  const clkBit = config.channels.clk!;
  const syncBit = config.channels.sync!;
  const dataBit = config.channels.data!;
  const statusBit = config.statusChannel;
  let started = false;
  const packed = (clk: number, sync: number, data: number, status: number): number =>
    (clk << clkBit) | (sync << syncBit) | (data << dataBit) | (statusBit === undefined ? 0 : status << statusBit);
  function* emit(clk: number, sync: number, data: number, status = 0): Iterable<SignalWindow> {
    yield* writer.write(packed(clk, sync, data, status), 1);
  }
  return {
    *push(frames): Iterable<SignalWindow> {
      if (!started) {
        started = true;
        yield* writer.write(packed(0, 1, 0, 0), config.initialSamples);
      }
      for (const frame of frames) {
        if (
          frame.bits.length !== 20 ||
          frame.bits.some((bit) => bit !== 0 && bit !== 1) ||
          (frame.status !== undefined &&
            (frame.status.length !== 19 || frame.status.some((bit) => bit !== 0 && bit !== 1)))
        )
          throw new RangeError('XY2-100 frames require twenty data bits and nineteen optional status bits');
        yield* emit(1, 1, 0, 0);
        for (let index = 0; index <= 20; index++) {
          const data = index < 20 ? frame.bits[index]! : 0;
          const sync = index < 19 ? 1 : 0;
          const status = statusBit !== undefined && index >= 1 && index <= 19 ? frame.status![index - 1]! : 0;
          yield* emit(0, sync, data, status);
          if (index < 20) yield* emit(1, sync, data, status);
        }
      }
    },
    *finish(): Iterable<SignalWindow> {
      if (!started) yield* writer.write(packed(0, 1, 0, 0), config.initialSamples);
      yield* writer.finish();
    },
  };
}
