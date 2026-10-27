import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { PWMCase, PWMCycle } from './generator.js';

export function createEncoder(config: PWMCase): WaveformEncoder<PWMCycle> {
  const writer = new PackedWaveformWriter(config);
  const bit = config.channels.data!;
  const active = config.options.polarity === 'active-low' ? 0 : 1 << bit;
  const idle = active ^ (1 << bit);
  let started = false;
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* writer.write(idle, 3);
      }
      for (const cycle of data) {
        if (
          !Number.isInteger(cycle.periodTicks) ||
          cycle.periodTicks < 1 ||
          cycle.periodTicks > 65535 ||
          !Number.isInteger(cycle.dutyUnits) ||
          cycle.dutyUnits < 1 ||
          cycle.dutyUnits >= 65535
        )
          throw new RangeError('PWM payload fields must fit in 16 bits');
        const exactPeriod = (cycle.periodTicks * config.sampleRate) / config.tickRate;
        const period = Math.round(exactPeriod);
        const duration = Math.round((exactPeriod * cycle.dutyUnits) / 65535);
        if (duration < 1 || duration >= period)
          throw new RangeError('PWM cycle cannot be represented at this sample rate');
        yield* writer.write(active, duration);
        yield* writer.write(idle, period - duration);
      }
    },
    *finish() {
      yield* writer.write(active, 1);
      yield* writer.finish();
    },
  };
}
