import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { MicrowireCase, MicrowirePacket } from './generator.js';

export const MICROWIRE_INITIAL_IDLE_SAMPLES = 2;

export function createEncoder(config: MicrowireCase): WaveformEncoder<MicrowirePacket> {
  const writer = new PackedWaveformWriter(config);
  const csBit = config.channels.cs;
  const skBit = config.channels.sk;
  const siBit = config.channels.si;
  const soBit = config.channels.so;
  if (csBit === undefined || skBit === undefined || siBit === undefined || soBit === undefined)
    throw new Error('Microwire encoder requires CS, SK, SI, and SO channels');
  let started = false;
  let firstPacket = true;

  const packed = (cs: number, sk: number, si: number, so: number): number =>
    (cs << csBit) | (sk << skBit) | (si << siBit) | (so << soBit);

  function* write(cs: number, sk: number, si: number, so: number, samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(packed(cs, sk, si, so), samples);
  }

  function* bitPacket(packet: Extract<MicrowirePacket, { kind: 'bits' }>): Iterable<SignalWindow> {
    if (!firstPacket) yield* write(0, 0, 0, 0, 1);
    firstPacket = false;
    yield* write(1, 0, packet.bits[0] ?? 0, packet.soBits[0] ?? 0, 1);
    for (let index = 0; index < packet.bits.length; index++) {
      const si = packet.bits[index] ?? 0;
      const so = packet.soBits[index] ?? 0;
      yield* write(1, 1, si, so, 1);
      yield* write(1, 0, si, so, 1);
    }
    const last = packet.bits.length - 1;
    yield* write(0, 0, packet.bits[last] ?? 0, packet.soBits[last] ?? 0, 1);
  }

  function* statusPacket(packet: Extract<MicrowirePacket, { kind: 'status' }>): Iterable<SignalWindow> {
    if (!firstPacket) yield* write(0, 0, 0, 0, 1);
    firstPacket = false;
    yield* write(1, 0, 0, 0, 1);
    for (let clock = 0; clock < packet.clocks; clock++) {
      const so = Math.floor(clock / packet.soPeriod) & 1;
      yield* write(1, 0, 0, so, 1);
      yield* write(1, 1, 0, so, 1);
    }
    const finalSo = Math.floor(packet.clocks / packet.soPeriod) & 1;
    yield* write(0, 0, 0, finalSo, 1);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(0, 0, 0, 0, MICROWIRE_INITIAL_IDLE_SAMPLES);
      }
      for (const packet of data) {
        if (packet.kind === 'bits') yield* bitPacket(packet);
        else yield* statusPacket(packet);
      }
    },
    *finish() {
      if (!started) yield* write(0, 0, 0, 0, MICROWIRE_INITIAL_IDLE_SAMPLES);
      yield* write(0, 0, 0, 0, 1);
      yield* writer.finish();
    },
  };
}
