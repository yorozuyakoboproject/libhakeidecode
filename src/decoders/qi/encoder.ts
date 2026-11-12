import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { QI_BIT_WIDTH, QI_PACKET_GAP_BITS, qiSymbols, type QiCase, type QiPacket } from './generator.js';

export function createEncoder(config: QiCase): WaveformEncoder<QiPacket> {
  if (!Number.isInteger(QI_BIT_WIDTH) || QI_BIT_WIDTH < 2)
    throw new RangeError('Qi bit width must contain at least two samples');
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.qi!;
  const half = QI_BIT_WIDTH / 2;
  let level = 0;
  let started = false;

  function* symbol(bit: number): Iterable<SignalWindow> {
    if (bit === 1) {
      yield* writer.write(level << channel, half);
      level ^= 1;
      yield* writer.write(level << channel, half);
      level ^= 1;
    } else {
      yield* writer.write(level << channel, QI_BIT_WIDTH);
      level ^= 1;
    }
  }

  function* gap(): Iterable<SignalWindow> {
    yield* writer.write(level << channel, QI_PACKET_GAP_BITS * QI_BIT_WIDTH);
    yield* symbol(0);
  }

  return {
    *push(data) {
      for (const packet of data) {
        yield* gap();
        started = true;
        for (const bit of qiSymbols(packet.bytes)) yield* symbol(bit);
      }
    },
    *finish() {
      if (started) yield* gap();
      else yield* writer.write(0, QI_BIT_WIDTH);
      yield* writer.finish();
    },
  };
}
