import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Tlc5620Case, Tlc5620Command } from './generator.js';

export function createEncoder(config: Tlc5620Case): WaveformEncoder<Tlc5620Command> {
  const writer = new PackedWaveformWriter(config);
  const clkBit = config.channels.clk;
  const dataBit = config.channels.data;
  const loadBit = config.channels.load;
  const ldacBit = config.channels.ldac;
  if (clkBit === undefined || dataBit === undefined || loadBit === undefined)
    throw new Error('TLC5620 encoder requires clock, data and load channels');
  let clock = 1;
  let data = 0;
  let load = 1;
  let ldac = ldacBit === undefined ? 1 : 0;
  let started = false;

  const packed = (): number =>
    (clock << clkBit) | (data << dataBit) | (load << loadBit) | (ldacBit === undefined ? 0 : ldac << ldacBit);
  function* write(samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(packed(), samples);
  }

  return {
    *push(items) {
      if (!started) {
        started = true;
        yield* write(2);
      }
      for (const item of items) {
        const bitCount = Math.max(0, Math.min(11, Math.trunc(item.bitCount ?? 11)));
        for (let index = 0; index < bitCount; index++) {
          data = (item.bits >> (bitCount - index - 1)) & 1;
          yield* write(1);
          clock = 0;
          yield* write(1);
          clock = 1;
          yield* write(1);
        }
        if (item.load !== false) {
          ldac = item.ldac ?? 1;
          yield* write(1);
          load = 0;
          yield* write(1);
          load = 1;
          yield* write(1);
        }
        if (item.ldacFall) {
          ldac = 0;
          yield* write(1);
          ldac = 1;
          yield* write(1);
        }
      }
    },
    *finish() {
      if (!started) yield* write(2);
      yield* writer.finish();
    },
  };
}
