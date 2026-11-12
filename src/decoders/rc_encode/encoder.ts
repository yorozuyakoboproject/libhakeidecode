import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { RC_SYNC_SAMPLES, layoutPacket } from './generator.js';
import type { RcCase, RcPacket } from './generator.js';

export function createEncoder(config: RcCase): WaveformEncoder<RcPacket> {
  const writer = new PackedWaveformWriter(config);
  const bit = config.channels.data!;
  const packetBits = config.options.linecoding === 'xx1527' ? 24 : 12;
  let level = 0;

  function* write(samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(level << bit, samples);
  }

  return {
    *push(data) {
      for (const packet of data) {
        if (packet.bits.length !== packetBits) throw new RangeError('RC packet has the wrong bit count.');
        const layout = layoutPacket(packet, packetBits, 0n);
        yield* write(1);
        for (const duration of layout.durations) {
          level ^= 1;
          yield* write(duration);
        }
        level ^= 1;
        yield* write(RC_SYNC_SAMPLES);
        level ^= 1;
        yield* write(8 * RC_SYNC_SAMPLES + 1);
      }
    },
    *finish() {
      yield* writer.finish();
    },
  };
}
