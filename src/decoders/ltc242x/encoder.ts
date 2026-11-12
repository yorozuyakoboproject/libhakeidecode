import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Ltc242xCase, Ltc242xFrame } from './generator.js';

export function createEncoder(config: Ltc242xCase): WaveformEncoder<Ltc242xFrame> {
  const options = config.chain?.[0]?.options ?? {};
  const writer = new PackedWaveformWriter(config);
  const clkBit = config.channels.clk;
  const misoBit = config.channels.miso;
  const csBit = config.channels.cs;
  if (clkBit === undefined || misoBit === undefined || csBit === undefined)
    throw new Error('LTC242x encoder requires clock, MISO and chip-select channels');
  const cpol = Number(options.cpol ?? 0);
  const msbFirst = options.bitorder !== 'lsb-first';
  const wordBits = Number(options.wordsize ?? 8);
  const activeLow = options.cs_polarity !== 'active-high';
  const activeCs = activeLow ? 0 : 1;
  const idleCs = activeCs ^ 1;
  const frameGap = wordBits * 3 + 16;
  const halfSamples = config.sampleRate / 4_000_000;
  let halves = 0;
  let samples = 0;
  let started = false;

  const packed = (clock: number, miso: number, cs: number): number =>
    (clock << clkBit) | (miso << misoBit) | (cs << csBit);
  function* emit(clock: number, miso: number, cs: number, duration: number): Iterable<SignalWindow> {
    halves += duration;
    const end = Math.round(halves * halfSamples);
    yield* writer.write(packed(clock, miso, cs), end - samples);
    samples = end;
  }

  function* word(value: number, last: boolean): Iterable<SignalWindow> {
    for (let bit = 0; bit < wordBits; bit++) {
      const offset = msbFirst ? wordBits - 1 - bit : bit;
      const level = Math.floor(value / 2 ** offset) & 1;
      yield* emit(cpol, level, activeCs, 1);
      yield* emit(cpol ^ 1, level, activeCs, 1);
      yield* emit(cpol, level, activeCs, 1);
    }
    yield* emit(cpol, 0, activeCs, last ? 3 : 4);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(cpol, 0, idleCs, 6);
      }
      for (const frame of data) {
        yield* emit(cpol, 0, idleCs, frameGap);
        yield* emit(cpol, 0, activeCs, 4);
        for (let index = 0; index < frame.words.length; index++) {
          yield* word(frame.words[index]!, index === frame.words.length - 1);
        }
      }
    },
    *finish() {
      yield* emit(cpol, 0, idleCs, 12);
      yield* writer.finish();
    },
  };
}
