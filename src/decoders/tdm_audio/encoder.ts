import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { RoundtripCase } from '../../build/roundtrip.js';
import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { TDM_SAMPLES_PER_BIT, type TdmFrame } from './generator.js';

export function createEncoder(config: RoundtripCase<TdmFrame>): WaveformEncoder<TdmFrame> {
  const writer = new PackedWaveformWriter(config);
  const clockBit = config.channels.clock!;
  const frameBit = config.channels.frame!;
  const dataBit = config.channels.data!;
  const bps = Math.trunc(Number(config.options.bps));
  const channelCount = Math.trunc(Number(config.options.channels));
  const falling = config.options.edge === 'falling';

  const pack = (clock: number, frame: number, data: number): number =>
    (clock << clockBit) | (frame << frameBit) | (data << dataBit);

  function* bit(frame: number, data: number): Iterable<SignalWindow> {
    if (falling) {
      yield* writer.write(pack(1, frame, data), TDM_SAMPLES_PER_BIT / 2);
      yield* writer.write(pack(0, frame, data), TDM_SAMPLES_PER_BIT / 2);
    } else {
      yield* writer.write(pack(0, frame, data), TDM_SAMPLES_PER_BIT / 2);
      yield* writer.write(pack(1, frame, data), TDM_SAMPLES_PER_BIT / 2);
    }
  }

  return {
    *push(data) {
      if (
        !Number.isInteger(bps) ||
        bps < 1 ||
        bps > 32 ||
        !Number.isInteger(channelCount) ||
        channelCount < 1 ||
        channelCount > 8
      )
        throw new RangeError('Invalid TDM bit depth or channel count');
      for (const frame of data) {
        if (frame.samples.length !== channelCount)
          throw new RangeError('TDM frame sample count does not match the channel option');
        yield* bit(1, 0);
        for (const sample of frame.samples) {
          if (!Number.isSafeInteger(sample) || sample < 0 || sample >= 2 ** bps)
            throw new RangeError('TDM sample does not fit the configured bit depth');
          for (let index = 0; index < bps; index++) yield* bit(0, Math.floor(sample / 2 ** (bps - index - 1)) & 1);
        }
      }
    },
    *finish() {
      yield* writer.finish();
    },
  };
}
