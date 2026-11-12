import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import { morseUnits } from './index.js';
import type { MorseCase, MorseSymbol } from './generator.js';

export function createEncoder(config: MorseCase): WaveformEncoder<MorseSymbol> {
  const writer = new PackedWaveformWriter(config);
  const bit = config.channels.data!;
  const unitSamples = Math.round(config.sampleRate * Number(config.options.timeunit));
  if (!(unitSamples > 0) || !Number.isSafeInteger(unitSamples))
    throw new RangeError('Morse time unit is not representable at this sample rate.');
  let started = false;

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* writer.write(0, 1);
      }
      for (const symbol of data) {
        const units = morseUnits(symbol.code);
        for (let index = 0; index < units.length; index++) {
          yield* writer.write(1 << bit, units[index]! * unitSamples);
          if (index + 1 < units.length) yield* writer.write(0, unitSamples);
        }
        yield* writer.write(0, (symbol.gap === 'word' ? 7 : 3) * unitSamples);
      }
    },
    *finish() {
      yield* writer.finish();
    },
  };
}
