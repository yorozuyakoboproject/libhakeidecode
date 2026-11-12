import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { SignatureCase, SignatureStep } from './generator.js';

export function createEncoder(config: SignatureCase): WaveformEncoder<SignatureStep> {
  const writer = new PackedWaveformWriter(config);
  const startBit = config.channels.start;
  const stopBit = config.channels.stop;
  const clkBit = config.channels.clk;
  const dataBit = config.channels.data;
  if (startBit === undefined || stopBit === undefined || clkBit === undefined || dataBit === undefined)
    throw new Error('Signature encoder requires all four channels');
  const startActive = config.options.start_edge === 'rising' ? 1 : 0;
  const stopActive = config.options.stop_edge === 'rising' ? 1 : 0;
  const sampleClock = config.options.clk_edge === 'rising' ? 1 : 0;
  const idleClock = sampleClock ^ 1;
  let start = startActive ^ 1;
  let stop = stopActive ^ 1;
  let data = 0;
  let clock = idleClock;
  let started = false;
  const packed = (): number => (start << startBit) | (stop << stopBit) | (clock << clkBit) | (data << dataBit);
  function* write(samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(packed(), samples);
  }
  return {
    *push(steps) {
      if (!started) {
        started = true;
        yield* write(2);
      }
      for (const step of steps) {
        start = step.start;
        stop = step.stop;
        data = step.data;
        yield* write(2);
        clock = sampleClock;
        yield* write(2);
        clock = idleClock;
        yield* write(2);
      }
    },
    *finish() {
      if (!started) yield* write(2);
      yield* writer.finish();
    },
  };
}
