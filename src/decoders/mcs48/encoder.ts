import { createPackedWindow } from '../../libhakeidecode/signal.js';
import type { RoundtripConfig, WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Mcs48Case, Mcs48Word } from './generator.js';

function sampleWidth(channels: Readonly<Record<string, number>>): 1 | 2 | 3 | 4 {
  const highest = Math.max(...Object.values(channels));
  if (!Number.isInteger(highest) || highest < 0 || highest > 31)
    throw new RangeError('Waveform channel bit is out of range');
  return Math.max(1, Math.ceil((highest + 1) / 8)) as 1 | 2 | 3 | 4;
}

class PackedWriter {
  private buffer: Uint8Array;
  private offset = 0;
  private chunk = 0;
  private start: bigint;
  private readonly sampleBytes: 1 | 2 | 3 | 4;

  constructor(private readonly config: RoundtripConfig) {
    if (!config.chunkSamples.length || config.chunkSamples.some((size) => !Number.isSafeInteger(size) || size < 1))
      throw new RangeError('Waveform chunk sizes must be positive integers');
    this.sampleBytes = sampleWidth(config.channels);
    this.buffer = new Uint8Array(config.chunkSamples[0]! * this.sampleBytes);
    this.start = config.startSample;
  }

  *write(value: number, samples: number): Iterable<SignalWindow> {
    if (!Number.isSafeInteger(samples) || samples < 0) throw new RangeError('Invalid waveform run length');
    const bytes = new Uint8Array(this.sampleBytes);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (value >>> (index * 8)) & 0xff;
    while (samples > 0) {
      const capacity = this.buffer.length / this.sampleBytes;
      const count = Math.min(samples, capacity - this.offset);
      for (let index = 0; index < count; index++) this.buffer.set(bytes, (this.offset + index) * this.sampleBytes);
      this.offset += count;
      samples -= count;
      if (this.offset === capacity) {
        yield createPackedWindow(
          this.start,
          this.config.sampleRate,
          this.buffer,
          this.config.channels,
          this.sampleBytes,
        );
        this.start += BigInt(capacity);
        this.chunk++;
        this.buffer = new Uint8Array(
          this.config.chunkSamples[this.chunk % this.config.chunkSamples.length]! * this.sampleBytes,
        );
        this.offset = 0;
      }
    }
  }

  *finish(): Iterable<SignalWindow> {
    if (!this.offset) return;
    yield createPackedWindow(
      this.start,
      this.config.sampleRate,
      this.buffer.subarray(0, this.offset * this.sampleBytes),
      this.config.channels,
      this.sampleBytes,
    );
    this.start += BigInt(this.offset);
    this.offset = 0;
  }
}

export function createEncoder(config: Mcs48Case): WaveformEncoder<Mcs48Word> {
  const writer = new PackedWriter(config);
  const ale = config.channels.ale;
  const psen = config.channels.psen;
  const dataBits = Array.from({ length: 8 }, (_, index) => config.channels[`d${index}`]);
  const addressBits = Array.from({ length: 4 }, (_, index) => config.channels[`a${index + 8}`]);
  const bank = config.channels.a12;
  if (
    ale === undefined ||
    psen === undefined ||
    dataBits.some((bit) => bit === undefined) ||
    addressBits.some((bit) => bit === undefined)
  )
    throw new Error('MCS-48 encoder requires ALE, PSEN, D0-D7, and A8-A11 channels');
  let started = false;

  const packed = (aleLevel: 0 | 1, psenLevel: 0 | 1, data: number, address: number): number => {
    let value = (aleLevel << ale) | (psenLevel << psen);
    for (let bit = 0; bit < 8; bit++) value |= ((data >>> bit) & 1) << dataBits[bit]!;
    for (let bit = 0; bit < 4; bit++) value |= ((address >>> (bit + 8)) & 1) << addressBits[bit]!;
    if (bank !== undefined) value |= ((address >>> 12) & 1) << bank;
    return value;
  };

  function* write(value: number, samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(value, samples);
  }

  return {
    *push(words) {
      if (!started) {
        started = true;
        yield* write(packed(1, 0, 0, 0), 2);
      }
      for (const word of words) {
        if (!Number.isInteger(word.address) || word.address < 0 || word.address > (bank === undefined ? 0xfff : 0x1fff))
          throw new RangeError('MCS-48 address is out of range');
        if (!Number.isInteger(word.data) || word.data < 0 || word.data > 0xff)
          throw new RangeError('MCS-48 data must be a byte');
        yield* write(packed(0, 0, word.address & 0xff, word.address), 1);
        yield* write(packed(0, 1, word.data, word.address), 1);
        yield* write(packed(1, 0, word.data, word.address), 1);
      }
    },
    *finish() {
      if (!started) yield* write(packed(1, 0, 0, 0), 2);
      yield* write(packed(1, 0, 0, 0), 1);
      yield* writer.finish();
    },
  };
}
