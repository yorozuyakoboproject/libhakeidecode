import type { WaveformEncoder } from '../../build/roundtrip.js';
import { PackedWaveformWriter } from '../../build/roundtrip.js';
import { SEVEN_SEGMENT_STATE_SAMPLES, type SevenSegmentCase, type SevenSegmentState } from './generator.js';

const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;

export function createEncoder(config: SevenSegmentCase): WaveformEncoder<SevenSegmentState> {
  const writer = new PackedWaveformWriter(config);
  const channels = [...SEGMENTS, 'dp'];
  const segmentCount = config.channels.dp === undefined ? 7 : 8;
  const commonAnode = config.options.polarity === 'common-anode';

  const pack = (item: SevenSegmentState): number => {
    let value = 0;
    for (let index = 0; index < segmentCount; index++) {
      const channel = channels[index]!;
      const bit = config.channels[channel];
      if (bit === undefined) continue;
      const active = index === 7 ? Number(item.dp) : (item.segments >>> index) & 1;
      value |= (commonAnode ? active ^ 1 : active) << bit;
    }
    return value;
  };

  return {
    *push(data) {
      for (const item of data) {
        if (!Number.isInteger(item.segments) || item.segments < 0 || item.segments > 0x7f)
          throw new RangeError('Seven-segment state is out of range');
        yield* writer.write(pack(item), SEVEN_SEGMENT_STATE_SAMPLES);
      }
    },
    *finish() {
      yield* writer.write(pack({ segments: 0, dp: false, text: '' }), 1);
      yield* writer.finish();
    },
  };
}
