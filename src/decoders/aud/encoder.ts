import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { RoundtripCase } from '../../build/roundtrip.js';
import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { AUD_SAMPLES_PER_NIBBLE, type AudCommand } from './generator.js';

const COMMAND_NIBBLE: Readonly<Record<AudCommand['nibbles'], number>> = {
  1: 0x08,
  2: 0x09,
  4: 0x0a,
  8: 0x0b,
};

export function createEncoder(config: RoundtripCase<AudCommand>): WaveformEncoder<AudCommand> {
  const writer = new PackedWaveformWriter(config);
  const audck = config.channels.audck!;
  const naudsync = config.channels.naudsync!;
  const dataBits = [
    config.channels.audata3!,
    config.channels.audata2!,
    config.channels.audata1!,
    config.channels.audata0!,
  ];

  const pack = (clock: number, sync: number, nibble: number): number => {
    let value = (clock << audck) | (sync << naudsync);
    for (let index = 0; index < 4; index++) value |= ((nibble >>> (3 - index)) & 1) << dataBits[index]!;
    return value;
  };

  function* nibble(value: number, sync: number): Iterable<SignalWindow> {
    yield* writer.write(pack(0, sync, value), AUD_SAMPLES_PER_NIBBLE / 2);
    yield* writer.write(pack(1, sync, value), AUD_SAMPLES_PER_NIBBLE / 2);
  }

  return {
    *push(commands) {
      for (const command of commands) {
        if (!Number.isInteger(command.value) || command.value < 0 || command.value >= 2 ** (4 * command.nibbles))
          throw new RangeError(
            `AUD address ${command.value} does not fit ${command.nibbles} nibble${command.nibbles === 1 ? '' : 's'}`,
          );
        yield* nibble(COMMAND_NIBBLE[command.nibbles], 1);
        for (let index = 0; index < command.nibbles; index++)
          yield* nibble(Math.floor(command.value / 2 ** (4 * index)) & 0x0f, 0);
      }
    },
    *finish() {
      yield* nibble(0, 1);
      yield* writer.finish();
    },
  };
}
