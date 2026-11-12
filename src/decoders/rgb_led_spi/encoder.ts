import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { RgbLedSpiCase } from './generator.js';

export function createEncoder(config: RgbLedSpiCase): WaveformEncoder<number> {
  const writer = new PackedWaveformWriter(config);
  const clkBit = config.channels.clk!,
    mosiBit = config.channels.mosi!,
    csBit = config.channels.cs;
  const cpol = Number(config.options.cpol ?? 0);
  const order = config.options.bitorder === 'lsb-first' ? 'lsb-first' : 'msb-first';
  const csActive = config.options.cs_polarity === 'active-high' ? 1 : 0;
  const csIdle = csActive ^ 1;
  let started = false;
  const packed = (clk: number, mosi: number, cs: number): number => {
    let value = (clk << clkBit) | (mosi << mosiBit);
    if (csBit !== undefined) value |= cs << csBit;
    return value;
  };
  function* emit(clk: number, mosi: number, cs: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(clk, mosi, cs), samples);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(cpol, 0, csIdle, 3);
      }
      if (csBit !== undefined) yield* emit(cpol, 0, csActive, 2);
      for (const byte of data) {
        for (let index = 0; index < 8; index++) {
          const shift = order === 'msb-first' ? 7 - index : index;
          const mosi = (byte >>> shift) & 1;
          yield* emit(cpol, mosi, csBit === undefined ? 0 : csActive, 1);
          yield* emit(cpol ^ 1, mosi, csBit === undefined ? 0 : csActive, 1);
          yield* emit(cpol, mosi, csBit === undefined ? 0 : csActive, 1);
        }
        yield* emit(cpol, 0, csBit === undefined ? 0 : csActive, 1);
      }
      if (csBit !== undefined) yield* emit(cpol, 0, csIdle, 2);
    },
    *finish() {
      yield* emit(cpol, 0, csIdle, 3);
      yield* writer.finish();
    },
  };
}
