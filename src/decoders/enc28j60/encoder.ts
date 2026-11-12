import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Enc28j60Case, Enc28j60Frame } from './generator.js';

export function createEncoder(config: Enc28j60Case): WaveformEncoder<Enc28j60Frame> {
  const spiOptions = config.chain?.[0]?.options ?? config.options,
    writer = new PackedWaveformWriter(config),
    clkBit = config.channels.clk!,
    mosiBit = config.channels.mosi!,
    misoBit = config.channels.miso!,
    csBit = config.channels.cs!,
    cpol = Number(spiOptions.cpol),
    msbFirst = spiOptions.bitorder === 'msb-first',
    activeCs = spiOptions.cs_polarity === 'active-low' ? 0 : 1,
    idleCs = activeCs ^ 1,
    halfSamples = Math.max(1, config.sampleRate / 4_000_000);
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
        yield* emit(cpol, 0, 0, idleCs, 8);
      }
      for (const frame of data) {
        yield* emit(cpol, 0, 0, idleCs, 64);
        yield* emit(cpol, 0, 0, activeCs, 4);
        const count = Math.max(frame.mosi.length, frame.miso.length);
        for (let index = 0; index < count; index++) {
          const mosi = frame.mosi[index] ?? 0,
            miso = frame.miso[index] ?? 0;
          for (let bit = 0; bit < 8; bit++) {
            const shift = msbFirst ? 7 - bit : bit,
              mosiLevel = (mosi >>> shift) & 1,
              misoLevel = (miso >>> shift) & 1;
            yield* emit(cpol, mosiLevel, misoLevel, activeCs, 1);
            yield* emit(cpol ^ 1, mosiLevel, misoLevel, activeCs, 1);
            yield* emit(cpol, mosiLevel, misoLevel, activeCs, 1);
          }
          yield* emit(cpol, 0, 0, activeCs, 4);
        }
        yield* emit(cpol, 0, 0, idleCs, 16);
      }
    },
    *finish() {
      yield* emit(cpol, 0, 0, idleCs, 8);
      yield* writer.finish();
    },
  };
}
