import { createPackedWindow } from '../../libhakeidecode/signal.js';
import type { RoundtripConfig, WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Ieee488Case, Ieee488Step } from './generator.js';

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

  *flush(): Iterable<SignalWindow> {
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

  *finish(): Iterable<SignalWindow> {
    yield* this.flush();
  }
}

export function createEncoder(config: Ieee488Case): WaveformEncoder<Ieee488Step> {
  const writer = new PackedWriter(config);
  const channels = config.channels;
  const dio = Array.from({ length: 8 }, (_, index) => channels[`dio${index + 1}`]);
  const serial = channels.clk !== undefined;
  let started = false;

  if (serial) {
    const atn = channels.atn;
    const clk = channels.clk;
    if (dio[0] === undefined || atn === undefined || clk === undefined)
      throw new Error('IEC encoder requires DATA, ATN, and CLK channels');
    let atnLevel = 0;
    let dataLevel = 1;
    let clkLevel = 1;
    const packed = (): number => (dataLevel << dio[0]!) | ((1 - atnLevel) << atn) | (clkLevel << clk);
    function* write(level: number, samples = 1): Iterable<SignalWindow> {
      yield* writer.write(level, samples);
    }
    return {
      *push(data) {
        if (!started) {
          started = true;
          yield* write(packed());
        }
        for (const step of data) {
          if (step.kind === 'serial-state') {
            atnLevel = step.atn;
            dataLevel = step.data;
            clkLevel = step.clk;
            yield* write(packed(), 2);
            continue;
          }
          if (step.kind !== 'serial-byte') throw new Error('Parallel step in a serial IEEE-488 case');
          atnLevel = step.atn;
          yield* write(packed(), 2);
          dataLevel = 0;
          clkLevel = 1;
          yield* write(packed(), 2);
          dataLevel = 1;
          yield* write(packed());
          if (step.eoi) {
            dataLevel = 0;
            yield* write(packed(), 2);
            dataLevel = 1;
          }
          clkLevel = 0;
          yield* write(packed());
          for (let index = 0; index < 8; index++) {
            dataLevel = (step.value >>> index) & 1;
            yield* write(packed());
            clkLevel = 1;
            yield* write(packed());
            clkLevel = 0;
            yield* write(packed());
          }
        }
      },
      *finish() {
        yield* write(packed());
        yield* writer.finish();
      },
    };
  }

  const eoi = channels.eoi;
  const dav = channels.dav;
  const ifc = channels.ifc;
  const atn = channels.atn;
  if (
    dio.some((bit) => bit === undefined) ||
    eoi === undefined ||
    dav === undefined ||
    ifc === undefined ||
    atn === undefined
  )
    throw new Error('GPIB encoder requires DIO1-DIO8, EOI, DAV, IFC, and ATN channels');
  let atnLevel: 0 | 1 = 0;
  let eoiLevel: 0 | 1 = 0;
  let ifcLevel: 0 | 1 = 0;
  let davLevel: 0 | 1 = 0;
  let dioValue = 0;
  const packed = (): number => {
    let value = ((1 - atnLevel) << atn) | ((1 - eoiLevel) << eoi) | ((1 - ifcLevel) << ifc) | ((1 - davLevel) << dav);
    for (let index = 0; index < 8; index++) value |= (1 - ((dioValue >>> index) & 1)) << dio[index]!;
    return value;
  };
  function* write(samples = 1): Iterable<SignalWindow> {
    yield* writer.write(packed(), samples);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write();
      }
      for (const step of data) {
        if (step.kind === 'parallel-state') {
          atnLevel = step.atn;
          eoiLevel = step.eoi;
          ifcLevel = step.ifc;
          dioValue = step.dio;
          yield* write(2);
          continue;
        }
        if (step.kind !== 'parallel-byte') throw new Error('Serial step in a parallel IEEE-488 case');
        atnLevel = step.atn;
        eoiLevel = step.eoi;
        dioValue = step.value;
        yield* write();
        davLevel = 1;
        yield* write(2);
        davLevel = 0;
        yield* write();
      }
      yield* writer.flush();
    },
    *finish() {
      davLevel = 0;
      yield* write();
      yield* writer.finish();
    },
  };
}
