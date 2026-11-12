import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { X2444mCase, X2444mFrame } from './generator.js';

export function createEncoder(config: X2444mCase): WaveformEncoder<X2444mFrame> {
  const options = config.chain?.[0]?.options ?? {};
  const writer = new PackedWaveformWriter(config);
  const clkBit = config.channels.clk;
  const mosiBit = config.channels.mosi;
  const misoBit = config.channels.miso;
  const csBit = config.channels.cs;
  if (clkBit === undefined || mosiBit === undefined || misoBit === undefined || csBit === undefined)
    throw new Error('X2444M encoder requires clock, MOSI, MISO and chip-select channels');
  const cpol = Number(options.cpol ?? 0);
  const msbFirst = options.bitorder !== 'lsb-first';
  const activeLow = options.cs_polarity !== 'active-high';
  const activeCs = activeLow ? 0 : 1;
  const idleCs = activeCs ^ 1;
  const halfSamples = config.sampleRate / 4_000_000;
  let halves = 0;
  let samples = 0;
  let started = false;
  const packed = (clock: number, mosi: number, miso: number, cs: number): number =>
    (clock << clkBit) | (mosi << mosiBit) | (miso << misoBit) | (cs << csBit);
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
        yield* emit(cpol, 0, 0, idleCs, 6);
      }
      for (const frame of data) {
        yield* emit(cpol, 0, 0, idleCs, 8);
        yield* emit(cpol, 0, 0, activeCs, 4);
        for (let index = 0; index < frame.mosi.length; index++) {
          const mosi = frame.mosi[index] ?? 0;
          const miso = frame.miso[index] ?? 0;
          for (let bit = 0; bit < 8; bit++) {
            const offset = msbFirst ? 7 - bit : bit;
            const mosiLevel = (mosi >> offset) & 1;
            const misoLevel = (miso >> offset) & 1;
            yield* emit(cpol, mosiLevel, misoLevel, activeCs, 1);
            yield* emit(cpol ^ 1, mosiLevel, misoLevel, activeCs, 1);
            yield* emit(cpol, mosiLevel, misoLevel, activeCs, 1);
          }
          yield* emit(cpol, 0, 0, activeCs, 4);
        }
      }
    },
    *finish() {
      yield* emit(cpol, 0, 0, idleCs, 8);
      yield* writer.finish();
    },
  };
}
