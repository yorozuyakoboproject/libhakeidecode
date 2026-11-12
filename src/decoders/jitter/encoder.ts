import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { JitterCase, JitterItem } from './generator.js';

export function createEncoder(config: JitterCase): WaveformEncoder<JitterItem> {
  const clkBit = config.channels.clk;
  const sigBit = config.channels.sig;
  if (clkBit === undefined || sigBit === undefined) throw new Error('Jitter encoder requires clk and sig');
  if (!Number.isSafeInteger(config.initialSamples) || config.initialSamples < 1)
    throw new RangeError('Jitter initial sample count must be positive');
  const writer = new PackedWaveformWriter(config);
  let clk = config.initialClk;
  let sig = config.initialSig;
  let started = false;
  const packed = (): number => (clk << clkBit) | (sig << sigBit);
  function* write(samples: number): Iterable<SignalWindow> {
    yield* writer.write(packed(), samples);
  }
  return {
    *push(items) {
      if (!items.length) return;
      if (!started) {
        started = true;
        yield* write(config.initialSamples);
      }
      for (const item of items) {
        if (!Number.isSafeInteger(item.hold) || item.hold < 1)
          throw new RangeError('Jitter hold length must be a positive integer');
        if (item.clk === clk && item.sig === sig) throw new RangeError('Jitter item has no edge');
        clk = item.clk;
        sig = item.sig;
        yield* write(item.hold);
      }
    },
    *finish() {
      if (!started) yield* write(config.initialSamples);
      yield* writer.finish();
    },
  };
}
