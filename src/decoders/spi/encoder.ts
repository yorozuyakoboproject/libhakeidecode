import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { SPICase, SPIWord } from './generator.js';

export function createEncoder(config: SPICase): WaveformEncoder<SPIWord> {
  const writer = new PackedWaveformWriter(config);
  const clkBit = config.channels.clk!,
    misoBit = config.channels.miso,
    mosiBit = config.channels.mosi,
    csBit = config.channels.cs,
    cpol = Number(config.options.cpol),
    bits = Number(config.options.wordsize),
    msb = config.options.bitorder === 'msb-first',
    csActive = config.options.cs_polarity === 'active-low' ? 0 : 1,
    csIdle = csActive ^ 1,
    halfSamples = config.sampleRate / 4_000_000;
  let halves = 0,
    samples = 0,
    started = false;
  const packed = (clock: number, mosi: number, miso: number, cs: number): number => {
    let value = clock << clkBit;
    if (mosiBit !== undefined) value |= mosi << mosiBit;
    if (misoBit !== undefined) value |= miso << misoBit;
    if (csBit !== undefined) value |= cs << csBit;
    return value;
  };
  function* emit(clock: number, mosi: number, miso: number, cs: number, duration: number): Iterable<SignalWindow> {
    halves += duration;
    const end = Math.round(halves * halfSamples);
    yield* writer.write(packed(clock, mosi, miso, cs), end - samples);
    samples = end;
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(cpol, 0, 0, csIdle, 3);
      }
      if (csBit !== undefined) yield* emit(cpol, 0, 0, csActive, 2);
      for (const word of data) {
        for (let index = 0; index < bits; index++) {
          const shift = msb ? bits - index - 1 : index,
            mosi = ((word.mosi ?? 0) >>> shift) & 1,
            miso = ((word.miso ?? 0) >>> shift) & 1;
          yield* emit(cpol, mosi, miso, csBit === undefined ? 0 : csActive, 1);
          yield* emit(cpol ^ 1, mosi, miso, csBit === undefined ? 0 : csActive, 1);
          yield* emit(cpol, mosi, miso, csBit === undefined ? 0 : csActive, 1);
        }
      }
      if (csBit !== undefined) {
        yield* emit(cpol, 0, 0, csIdle, 2);
      }
    },
    *finish() {
      yield* emit(cpol, 0, 0, csIdle, 3);
      yield* writer.finish();
    },
  };
}
