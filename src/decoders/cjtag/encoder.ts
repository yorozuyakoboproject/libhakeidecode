import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { CjtagCase, CjtagStep } from './generator.js';

export function createEncoder(config: CjtagCase): WaveformEncoder<CjtagStep> {
  const writer = new PackedWaveformWriter(config);
  const tckc = config.channels.tckc;
  const tmsc = config.channels.tmsc;
  if (tckc === undefined || tmsc === undefined) throw new Error('cJTAG encoder requires TCKC and TMSC channels');
  let started = false;
  const packed = (clock: number, mode: number): number => (clock << tckc) | (mode << tmsc);
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* writer.write(packed(0, 0), 1);
      }
      for (const step of data) yield* writer.write(packed(step.tckc, step.tmsc), 1);
      yield* writer.finish();
    },
    *finish() {
      yield* writer.write(packed(0, 0), 1);
      yield* writer.finish();
    },
  };
}
