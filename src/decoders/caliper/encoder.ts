import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { CaliperCase, CaliperItem } from './generator.js';

export function createEncoder(config: CaliperCase): WaveformEncoder<CaliperItem> {
  if (!Number.isInteger(config.halfClockSamples) || config.halfClockSamples < 1)
    throw new RangeError('Caliper half clock must be a positive whole number of samples');
  const writer = new PackedWaveformWriter(config),
    clkBit = config.channels.clk,
    dataBit = config.channels.data;
  if (clkBit === undefined || dataBit === undefined) throw new Error('Caliper encoder requires clk and data');
  let clk = 0,
    data = 0,
    started = false;
  const packed = (): number => (clk << clkBit) | (data << dataBit);
  function* write(samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(), samples);
  }
  return {
    *push(items) {
      if (!started) {
        started = true;
        yield* write(config.initialSamples);
      }
      for (const item of items) {
        const count = item.bits ?? 24;
        if (!Number.isInteger(item.raw) || item.raw < 0 || item.raw > 0xffff || !Number.isInteger(item.flags))
          throw new RangeError('Invalid caliper payload');
        if (!Number.isInteger(count) || count < 0 || count > 24) throw new RangeError('Invalid caliper bit count');
        if (item.gap) {
          clk = 0;
          yield* write(Math.max(0, Math.trunc(item.gap)));
        }
        for (let bit = 0; bit < count; bit++) {
          const value = bit < 16 ? (item.raw >>> bit) & 1 : (item.flags >>> (bit - 16)) & 1;
          clk = 0;
          data = value;
          yield* write(config.halfClockSamples);
          clk = 1;
          yield* write(config.halfClockSamples);
        }
      }
    },
    *finish() {
      if (!started) {
        started = true;
        yield* write(config.initialSamples);
      }
      clk = 0;
      data = 0;
      yield* writer.finish();
    },
  };
}
