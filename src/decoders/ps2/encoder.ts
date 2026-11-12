import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Ps2Case, Ps2Frame } from './generator.js';

function oddParity(value: number): 0 | 1 {
  let ones = 0;
  for (let index = 0; index < 8; index++) ones ^= (value >>> index) & 1;
  return ones === 1 ? 0 : 1;
}

export function createEncoder(config: Ps2Case): WaveformEncoder<Ps2Frame> {
  const writer = new PackedWaveformWriter(config);
  const clkBit = config.channels.clk!;
  const dataBit = config.channels.data!;
  let started = false;
  function* emit(clk: number, data: number, count = 1): Iterable<SignalWindow> {
    yield* writer.write((clk << clkBit) | (data << dataBit), count);
  }
  function* cycle(value: number): Iterable<SignalWindow> {
    yield* emit(0, value);
    yield* emit(1, value);
  }
  return {
    *push(data): Iterable<SignalWindow> {
      if (!started) {
        started = true;
        yield* emit(1, 1, config.initialHalves);
      }
      for (const frame of data) {
        if (!Number.isInteger(frame.value) || frame.value < 0 || frame.value > 0xff)
          throw new RangeError('PS/2 byte must be in the range 0..255');
        for (let index = 0; index < (frame.leadingOnes ?? 0); index++) yield* cycle(1);
        const parity = frame.parity ?? oddParity(frame.value);
        const values = [0, ...Array.from({ length: 8 }, (_, index) => (frame.value >>> index) & 1), parity, 1];
        for (const value of values) yield* cycle(value);
      }
    },
    *finish(): Iterable<SignalWindow> {
      if (!started) yield* emit(1, 1, config.initialHalves);
      yield* emit(1, 1, config.initialHalves);
      yield* writer.finish();
    },
  };
}
