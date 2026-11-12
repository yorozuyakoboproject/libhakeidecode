import { createPackedWindow } from '../../libhakeidecode/signal.js';
import type { RoundtripConfig, WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Z80Case, Z80Cycle } from './generator.js';

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

const CONTROLS: Readonly<
  Record<Z80Cycle['kind'], readonly [m1: number, rd: number, wr: number, mreq: number, iorq: number]>
> = {
  fetch: [0, 0, 1, 0, 1],
  memread: [1, 0, 1, 0, 1],
  memwrite: [1, 1, 0, 0, 1],
  ioread: [1, 0, 1, 1, 0],
  iowrite: [1, 1, 0, 1, 0],
};

export function createEncoder(config: Z80Case): WaveformEncoder<Z80Cycle> {
  const writer = new PackedWriter(config);
  const channels = config.channels;
  const required = [
    ...Array.from({ length: 8 }, (_, index) => channels[`d${index}`]),
    channels.m1,
    channels.rd,
    channels.wr,
    channels.mreq,
    channels.iorq,
    ...Array.from({ length: 16 }, (_, index) => channels[`a${index}`]),
  ];
  if (required.some((bit) => bit === undefined)) throw new Error('Z80 encoder requires all bus and control channels');
  const bit = (index: number): number => required[index]!;
  let started = false;

  const packed = (cycle: Z80Cycle | null, active: boolean): number => {
    let value = 0;
    if (cycle) {
      for (let index = 0; index < 8; index++) value |= ((cycle.data >>> index) & 1) << bit(index);
      for (let index = 0; index < 16; index++) value |= ((cycle.address >>> index) & 1) << bit(13 + index);
    }
    const [m1, rd, wr, mreq, iorq] = cycle && active ? CONTROLS[cycle.kind] : [1, 1, 1, 1, 1];
    value |= m1 << bit(8);
    value |= rd << bit(9);
    value |= wr << bit(10);
    value |= mreq << bit(11);
    value |= iorq << bit(12);
    return value;
  };

  function* phase(cycle: Z80Cycle | null, active: boolean): Iterable<SignalWindow> {
    yield* writer.write(packed(cycle, active), 1);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* phase(null, false);
      }
      for (const cycle of data) {
        yield* phase(cycle, false);
        yield* phase(cycle, true);
        yield* phase(cycle, false);
      }
    },
    *finish() {
      yield* phase(null, false);
      yield* writer.finish();
    },
  };
}
