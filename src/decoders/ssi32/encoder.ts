import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Ssi32Case, SsiMessage } from './generator.js';

export function createEncoder(config: Ssi32Case): WaveformEncoder<SsiMessage> {
  const writer = new PackedWaveformWriter(config);
  const options = config.chain?.[0]?.options ?? {};
  const cpol = Number(options.cpol ?? 0);
  const msb = options.bitorder !== 'lsb-first';
  const csActive = options.cs_polarity === 'active-high' ? 1 : 0;
  const csIdle = csActive ^ 1;
  const halfSamples = config.sampleRate / 4_000_000;
  const clk = config.channels.clk!;
  const miso = config.channels.miso;
  const mosi = config.channels.mosi;
  const cs = config.channels.cs;
  let units = 0;
  let samples = 0;
  let started = false;

  const packed = (clock: number, mosiLevel: number, misoLevel: number, csLevel: number): number => {
    let value = clock << clk;
    if (miso !== undefined) value |= misoLevel << miso;
    if (mosi !== undefined) value |= mosiLevel << mosi;
    if (cs !== undefined) value |= csLevel << cs;
    return value;
  };

  function* emit(
    clock: number,
    mosiLevel: number,
    misoLevel: number,
    csLevel: number,
    duration: number,
  ): Iterable<SignalWindow> {
    units += duration;
    const end = Math.round(units * halfSamples);
    if (end > samples) yield* writer.write(packed(clock, mosiLevel, misoLevel, csLevel), end - samples);
    samples = end;
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(cpol, 0, 0, csIdle, 3);
        if (cs !== undefined) yield* emit(cpol, 0, 0, csActive, 2);
      }
      for (const message of data) {
        if (!message.mosi.length || message.mosi.length !== message.miso.length)
          throw new RangeError('SSI32 messages need matching MISO/MOSI bytes');
        for (let index = 0; index < message.mosi.length; index++) {
          const tx = message.mosi[index]!;
          const rx = message.miso[index]!;
          if (![tx, rx].every((value) => Number.isInteger(value) && value >= 0 && value <= 0xff))
            throw new RangeError('SSI32 requires eight-bit SPI words');
          for (let bit = 0; bit < 8; bit++) {
            const shift = msb ? 7 - bit : bit;
            const mosiLevel = (tx >>> shift) & 1;
            const misoLevel = (rx >>> shift) & 1;
            yield* emit(cpol, mosiLevel, misoLevel, cs !== undefined ? csActive : 0, 1);
            yield* emit(cpol ^ 1, mosiLevel, misoLevel, cs !== undefined ? csActive : 0, 1);
            yield* emit(cpol, mosiLevel, misoLevel, cs !== undefined ? csActive : 0, 1);
          }
        }
      }
    },
    *finish() {
      yield* emit(cpol, 0, 0, csIdle, 3);
      yield* writer.finish();
    },
  };
}
