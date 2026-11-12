import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Ade77xxCase, Ade77xxFrame } from './generator.js';

export function createEncoder(config: Ade77xxCase): WaveformEncoder<Ade77xxFrame> {
  const spiOptions = config.chain?.[0]?.options ?? config.options,
    writer = new PackedWaveformWriter(config),
    clkBit = config.channels.clk!,
    mosiBit = config.channels.mosi!,
    misoBit = config.channels.miso!,
    csBit = config.channels.cs!,
    cpol = Number(spiOptions.cpol),
    msbFirst = spiOptions.bitorder === 'msb-first',
    activeLow = spiOptions.cs_polarity === 'active-low',
    activeCs = activeLow ? 0 : 1,
    idleCs = activeCs ^ 1,
    halfSamples = config.sampleRate / 4_000_000;
  let halves = 0,
    samples = 0,
    started = false;
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
        yield* emit(cpol, 0, 0, idleCs, 4);
      }
      for (const frame of data) {
        const bits = Math.max(frame.mosi.length, frame.miso.length) * 8;
        yield* emit(cpol, 0, 0, idleCs, 8);
        yield* emit(cpol, 0, 0, activeCs, 4);
        for (let index = 0; index < bits; index++) {
          const byteIndex = Math.floor(index / 8),
            offset = index % 8,
            shift = msbFirst ? 7 - offset : offset,
            mosi = ((frame.mosi[byteIndex] ?? 0) >> shift) & 1,
            miso = ((frame.miso[byteIndex] ?? 0) >> shift) & 1;
          yield* emit(cpol, mosi, miso, activeCs, 1);
          yield* emit(cpol ^ 1, mosi, miso, activeCs, 1);
          yield* emit(cpol, mosi, miso, activeCs, 1);
        }
        yield* emit(cpol, 0, 0, activeCs, 3);
      }
    },
    *finish() {
      yield* emit(cpol, 0, 0, idleCs, 8);
      yield* writer.finish();
    },
  };
}
