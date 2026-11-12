import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { RoundtripCase } from '../../build/roundtrip.js';
import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { I2S_DUMMY_BITS, I2S_SAMPLES_PER_BIT, type I2SCase, type I2SWord } from './generator.js';

export function createEncoder(config: RoundtripCase<I2SWord>): WaveformEncoder<I2SWord> {
  const writer = new PackedWaveformWriter(config);
  const caseConfig = config as I2SCase;
  const sck = config.channels.sck!;
  const ws = config.channels.ws!;
  const sd = config.channels.sd!;
  let currentWs = caseConfig.initialWordSelect ?? 1;
  let started = false;
  let lastWs = 1;
  let lastSd = 0;

  const pack = (clock: number, wordSelect: number, data: number): number =>
    (clock << sck) | (wordSelect << ws) | (data << sd);

  function* bit(wordSelect: number, data: number): Iterable<SignalWindow> {
    yield* writer.write(pack(0, wordSelect, data), I2S_SAMPLES_PER_BIT / 2);
    yield* writer.write(pack(1, wordSelect, data), I2S_SAMPLES_PER_BIT / 2);
    lastWs = wordSelect;
    lastSd = data;
  }

  function* word(value: number, bits: number): Iterable<SignalWindow> {
    for (let index = 0; index < bits; index++) {
      const finalBit = index === bits - 1;
      const wordSelect = finalBit ? currentWs ^ 1 : currentWs;
      yield* bit(wordSelect, Math.floor(value / 2 ** (bits - index - 1)) & 1);
    }
    currentWs ^= 1;
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* word(0, caseConfig.initialWordBits ?? I2S_DUMMY_BITS);
      }
      for (const item of data) {
        if (
          !Number.isInteger(item.bits) ||
          item.bits < 1 ||
          item.bits > 32 ||
          !Number.isSafeInteger(item.value) ||
          item.value < 0 ||
          item.value >= 2 ** item.bits
        )
          throw new RangeError('I2S word does not fit its declared bit width');
        yield* word(item.value, item.bits);
      }
    },
    *finish() {
      if (started) yield* writer.write(pack(0, lastWs, lastSd), 1);
      yield* writer.finish();
    },
  };
}
