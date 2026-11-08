import { SampleRing } from './sample-ring.js';
import { RollingWaveformReader } from './rolling-waveform.js';
import type { DigitalViewRequest, DigitalViewResult } from './digital-view.js';
import {
  deviceChannelIndices,
  packedLogicSampleBytes,
  type AcquisitionChunk,
  type AnalogTiming,
  type DeviceConfiguration,
  type PackedLogicChunk,
} from '../libhakei/device.js';
import { createSampleChunk } from '../libhakei/index.js';
import { minSample, maxSample, sampleIndex, type SampleInput } from '../libhakei/sample-index.js';
import { channelWidthForProbes } from './data/channel-count.js';
import { AnalogSampleStore, type AnalogStore, type AnalogColumnView } from './data/analogStore.js';
import { TimedAnalogStore } from './data/timed-analogStore.js';
import type { ColumnView, GapSpan, MemoryReport, SampleStore } from './data/types.js';
import type { MemoryBudget } from './memory.js';
import type { StoreCaptureSource } from './worker-store-server.js';

const ceilDiv = (value: bigint, divisor: bigint): bigint =>
  value < 0n ? value / divisor : (value + divisor - 1n) / divisor;

export class RollingSampleStore implements SampleStore {
  readonly channelCount: number;
  private readonly ring: SampleRing;
  private waveform?: RollingWaveformReader;
  private timeline = 0n;
  constructor(
    readonly capacity: bigint,
    readonly logicChannelCount: number,
    readonly samplerate: number,
    private readonly budget: MemoryBudget,
  ) {
    this.channelCount = channelWidthForProbes(Math.max(1, logicChannelCount));
    this.ring = new SampleRing(Number(capacity), true, budget);
  }
  get length(): bigint {
    return minSample(this.capacity, this.timeline);
  }
  prepareDigitalView(request: DigitalViewRequest): Promise<DigitalViewResult> {
    this.waveform ??= new RollingWaveformReader(this.ring, this.logicChannelCount, this.samplerate);
    return this.waveform.read(request);
  }
  queryDiagnostics(): Record<string, number> {
    const metrics = this.waveform?.diagnostics;
    return {
      waveformQueries: metrics?.queries ?? 0,
      waveformTotalMs: metrics?.totalMs ?? 0,
      waveformMaxMs: metrics?.maxMs ?? 0,
      waveformAborted: metrics?.aborted ?? 0,
      ...this.ring.viewMetrics,
    };
  }
  get sampleOffset(): bigint {
    return this.timeline - this.length;
  }
  get totalSamples(): bigint {
    return this.timeline;
  }
  advance(length: bigint): void {
    if (length < this.timeline) throw new Error('Rolling timeline moved backwards');
    this.timeline = length;
  }
  append(chunk: Uint8Array): void {
    const width = Math.ceil(this.channelCount / 8);
    if (chunk.byteLength % width) throw new Error('Incomplete rolling digital sample');
    this.appendPacked({
      format: 'packed-logic',
      startSample: this.timeline,
      sampleRate: this.samplerate,
      channelCount: this.logicChannelCount,
      length: chunk.byteLength / width,
      encoding: width === 4 ? 'raw32' : width === 2 ? 'raw16' : 'raw8',
      data: chunk,
    });
  }
  appendPacked(chunk: PackedLogicChunk): void {
    const width = packedLogicSampleBytes(chunk),
      view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.length * width);
    if (width === 1) this.ring.append(chunk.data.subarray(0, chunk.length));
    else if (width === 2 && chunk.data.byteOffset % 2 === 0)
      this.ring.append(new Uint16Array(chunk.data.buffer, chunk.data.byteOffset, chunk.length));
    else if (width === 4 && chunk.data.byteOffset % 4 === 0)
      this.ring.append(new Uint32Array(chunk.data.buffer, chunk.data.byteOffset, chunk.length));
    else {
      const words = new Uint32Array(chunk.length);
      for (let i = 0; i < words.length; i++)
        words[i] =
          width === 2
            ? view.getUint16(i * width, true)
            : width === 4
              ? view.getUint32(i * width, true)
              : view.getUint16(i * width, true) | (view.getUint8(i * width + 2) << 16);
      this.ring.append(words);
    }
    this.timeline = this.ring.total;
  }
  appendChannels(channels: readonly ArrayLike<number>[]): void {
    const values = new Uint32Array(channels[0]?.length ?? 0);
    for (let channel = 0; channel < channels.length; channel++)
      for (let i = 0; i < values.length; i++) values[i] |= channels[channel]![i]! << channel;
    this.ring.append(values);
    this.timeline = this.ring.total;
  }
  sampleAt(channel: number, index: SampleInput): number {
    return this.logicChannelCount ? (this.ring.at(Number(sampleIndex(index))) >>> channel) & 1 : 0;
  }
  channelRange(channel: number, start: bigint, end: bigint): Uint8Array {
    return this.ring.channelRange(channel, Number(start), Number(end));
  }
  decodeEdges(channel: number, start: bigint, end: bigint, limit: number): bigint[] | null {
    return this.ring.channelEdges(channel, Number(start), Number(end), limit);
  }
  packRange(start: bigint, end: bigint, channels: number): Uint8Array {
    const width = Math.ceil(channels / 8),
      output = new Uint8Array(Number(end - start) * width);
    for (let i = 0; i < Number(end - start); i++) {
      const value = this.ring.at(Number(start) + i);
      for (let byte = 0; byte < width; byte++) output[i * width + byte] = value >>> (byte * 8);
    }
    return output;
  }
  query(channel: number, startInput: SampleInput, endInput: SampleInput, bins: number): ColumnView {
    const start = maxSample(0n, sampleIndex(startInput)),
      end = minSample(this.length, sampleIndex(endInput));
    return this.ring.query(channel, Number(start), Number(end), bins, this.logicChannelCount > 0);
  }
  edges(channel: number, start: SampleInput, end: SampleInput): bigint[] {
    const edges: bigint[] = [],
      last = Number(minSample(this.length, sampleIndex(end)));
    for (let i = Number(maxSample(1n, sampleIndex(start))); i < last; i++)
      if (((this.ring.at(i) ^ this.ring.at(i - 1)) >>> channel) & 1) edges.push(BigInt(i));
    return edges;
  }
  noteGap(_start: SampleInput, _end: SampleInput): void {
    throw new Error('Rolling samples must be contiguous');
  }
  gaps(): GapSpan[] {
    return [];
  }
  memory(): MemoryReport {
    const baseBytes = this.ring.memory(),
      pyramidBytes = 0;
    return { baseBytes, pyramidBytes, totalBytes: baseBytes + pyramidBytes, overhead: 0, slackBytes: 0 };
  }
  snapshot(): RollingSampleStore {
    const store = new RollingSampleStore(
      maxSample(1n, this.length),
      this.logicChannelCount,
      this.samplerate,
      this.budget,
    );
    try {
      if (this.logicChannelCount) store.ring.append(this.ring.copy());
      store.timeline = this.length;
      return store;
    } catch (error) {
      store.dispose();
      throw error;
    }
  }
  dispose(): void {
    this.waveform?.dispose();
    this.waveform = undefined;
    this.ring.dispose();
  }
}

class RollingAnalogStore implements AnalogStore {
  readonly ring: SampleRing;
  constructor(
    readonly samplerate: number,
    capacity: number,
    budget: MemoryBudget,
    private readonly bounds: () => [bigint, bigint],
  ) {
    this.ring = new SampleRing(capacity, false, budget);
  }
  get start(): bigint {
    return maxSample(this.ring.offset, minSample(this.ring.total, this.bounds()[0]));
  }
  get length(): bigint {
    return maxSample(0n, minSample(this.ring.total, this.bounds()[1]) - this.start);
  }
  private aggregate(start = 0n, end = this.length): [number, number, number] {
    const offset = this.start - this.ring.offset;
    return this.ring.aggregate(Number(offset + start), Number(offset + end));
  }
  get range() {
    const [min, max] = this.length ? this.aggregate() : [0, 0];
    return this.length ? { min: min!, max: max! } : null;
  }
  get mean(): number | null {
    return this.length ? this.aggregate()[2] / Number(this.length) : null;
  }
  append(values: ArrayLike<number>): void {
    this.ring.append(values);
  }
  sampleAt(index: SampleInput): number {
    return this.ring.at(Number(this.start - this.ring.offset + sampleIndex(index)));
  }
  query(startInput: SampleInput, endInput: SampleInput, bins: number): AnalogColumnView {
    const start = sampleIndex(startInput),
      end = minSample(this.length, sampleIndex(endInput)),
      low = new Float32Array(bins),
      high = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      const a = start + ((end - start) * BigInt(i)) / BigInt(bins),
        b = minSample(end, maxSample(a + 1n, start + ((end - start) * BigInt(i + 1)) / BigInt(bins)));
      const stats = this.aggregate(a, b);
      low[i] = stats[0];
      high[i] = stats[1];
    }
    return { startSample: start, endSample: end, bins, low, high };
  }
  copyRange(start = 0n, end = this.length): Float32Array {
    return this.ring.copy(
      Number(this.start - this.ring.offset + start),
      Number(this.start - this.ring.offset + end),
    ) as Float32Array;
  }
  memory(): { totalBytes: number } {
    return { totalBytes: this.ring.memory() };
  }
  dispose(): void {
    this.ring.dispose();
  }
}

type AnalogStream = {
  native: RollingAnalogStore;
  timing: AnalogTiming;
  adjusted: { firstTick: bigint };
  firstTick: bigint;
  store: AnalogStore;
};

export class RollingCapture {
  readonly store: RollingSampleStore;
  readonly labels: readonly string[];
  readonly logicChannelCount: number;
  readonly analogChannels: { name: string; store: AnalogStore }[];
  private readonly streams = new Map<number, AnalogStream>();
  private sourceOffset = 0n;
  constructor(
    private readonly config: DeviceConfiguration,
    private readonly budget: MemoryBudget,
    private readonly sourceLimit: bigint,
    private readonly channelArrays: boolean,
  ) {
    this.logicChannelCount = config.logicChannels;
    this.labels = deviceChannelIndices(config, 'logic').map((index) => `D${index}`);
    this.store = new RollingSampleStore(BigInt(config.sampleCount), config.logicChannels, config.sampleRate, budget);
    this.analogChannels = deviceChannelIndices(config, 'analog').map((index) => ({
      name: `A${index}`,
      store: new AnalogSampleStore(config.sampleRate, budget),
    }));
  }
  nextSource(): void {
    if (this.store.totalSamples === this.sourceOffset) throw new Error('Device returned no samples');
    this.sourceOffset = this.store.totalSamples;
    for (const stream of this.streams.values()) stream.native.dispose();
    this.streams.clear();
    for (const channel of this.analogChannels)
      channel.store = new AnalogSampleStore(this.config.sampleRate, this.budget);
  }
  append(input: AcquisitionChunk): void {
    if (!('format' in input)) {
      const sample = createSampleChunk(input);
      if (
        sample.sampleRate !== this.config.sampleRate ||
        sample.startSample + this.sourceOffset !== this.store.totalSamples ||
        Object.keys(sample.channels).join('\0') !== this.labels.join('\0')
      )
        throw new Error('Rolling digital stream changed');
      if (this.logicChannelCount) this.store.appendChannels(this.labels.map((id) => sample.channels[id]!));
      else this.store.advance(this.sourceOffset + sample.endSample);
      const analogIds = deviceChannelIndices(this.config, 'analog');
      const analogIdsInChunk = Object.keys(sample.analogChannels);
      if (
        (this.channelArrays || analogIdsInChunk.length) &&
        analogIdsInChunk.join('\0') !== analogIds.map((index) => `A${index}`).join('\0')
      )
        throw new Error('Rolling analog layout changed');
      for (const channel of analogIdsInChunk.length ? analogIds : [])
        this.appendAnalog(channel, sample.startSample, sample.analogChannels[`A${channel}`]!, {
          direct: true,
          clockHz: sample.sampleRate,
          periodTicks: 1n,
          firstTick: 0n,
          uncertaintyTicks: 0,
          bits: 12,
          referenceMv: 0,
        });
      return;
    }
    if (input.format === 'packed-logic') {
      if (
        input.channelCount !== this.logicChannelCount ||
        input.sampleRate !== this.config.sampleRate ||
        input.startSample + this.sourceOffset !== this.store.totalSamples ||
        input.data.length < input.length * packedLogicSampleBytes(input)
      )
        throw new Error('Rolling digital stream changed');
      this.store.appendPacked(input);
      return;
    }
    if (input.format === 'timeline') {
      if (this.logicChannelCount && input.length + this.sourceOffset !== this.store.totalSamples)
        throw new Error('Incomplete rolling digital stream');
      this.store.advance(maxSample(this.store.totalSamples, this.sourceOffset + input.length));
      return;
    }
    this.appendAnalog(input.channel, input.startSample, input.data, input.timing);
  }
  private appendAnalog(channel: number, start: bigint, values: ArrayLike<number>, timing: AnalogTiming): void {
    const index = deviceChannelIndices(this.config, 'analog').indexOf(channel);
    if (index < 0) throw new Error('Unexpected rolling analog channel');
    let stream = this.streams.get(channel);
    if (!stream) {
      const clock = BigInt(timing.clockHz),
        rate = BigInt(this.config.sampleRate),
        period = timing.periodTicks,
        firstTick = timing.firstTick + (this.sourceOffset * clock) / rate,
        adjusted = { ...timing },
        capacity = Number(ceilDiv(BigInt(this.config.sampleCount) * clock, rate * period) + 2n);
      const native = new RollingAnalogStore(timing.clockHz / Number(period), capacity, this.budget, () => {
        const begin = (this.store.sampleOffset * clock) / rate - firstTick,
          end = ((this.store.sampleOffset + this.store.length) * clock) / rate - firstTick;
        return [maxSample(0n, ceilDiv(begin, period)), maxSample(0n, ceilDiv(end, period))];
      });
      const store = timing.direct
        ? native
        : new TimedAnalogStore(native, adjusted, this.config.sampleRate, BigInt(this.config.sampleCount));
      stream = { native, timing: { ...timing }, adjusted, firstTick, store };
      this.streams.set(channel, stream);
      this.analogChannels[index]!.store = store;
    }
    if (
      start !== stream.native.ring.total ||
      Object.entries(timing).some(([key, value]) => stream!.timing[key as keyof AnalogTiming] !== value)
    )
      throw new Error('Rolling analog timing or continuity changed');
    stream.native.append(values);
    if (!this.logicChannelCount) {
      const end = stream.firstTick + stream.native.ring.total * timing.periodTicks;
      this.store.advance(
        maxSample(
          this.store.totalSamples,
          minSample(
            this.sourceOffset + this.sourceLimit,
            ceilDiv(end * BigInt(this.config.sampleRate), BigInt(timing.clockHz)),
          ),
        ),
      );
    }
  }
  source(): StoreCaptureSource {
    for (const stream of this.streams.values())
      stream.adjusted.firstTick =
        stream.firstTick +
        stream.native.start * stream.timing.periodTicks -
        (this.store.sampleOffset * BigInt(stream.timing.clockHz)) / BigInt(this.config.sampleRate);
    return {
      store: this.store,
      labels: this.labels,
      logicChannelCount: this.logicChannelCount,
      analogChannels: this.analogChannels,
      sampleOffset: this.store.sampleOffset,
      snapshot: (analog) => this.snapshot(analog),
    };
  }
  private snapshot(analog = false): StoreCaptureSource {
    const store = this.store.snapshot(),
      channels: { name: string; store: AnalogStore }[] = [],
      releases: (() => void)[] = [() => store.dispose()];
    try {
      if (analog)
        for (const [index, channel] of deviceChannelIndices(this.config, 'analog').entries()) {
          const stream = this.streams.get(channel);
          if (!stream) continue;
          const native = new AnalogSampleStore(stream.native.samplerate, this.budget);
          releases.push(() => native.dispose());
          native.append(stream.native.copyRange());
          channels.push({
            name: this.analogChannels[index]!.name,
            store: stream.timing.direct
              ? native
              : new TimedAnalogStore(
                  native,
                  { ...stream.timing, firstTick: stream.adjusted.firstTick },
                  this.config.sampleRate,
                  store.length,
                ),
          });
        }
      return {
        store,
        labels: this.labels,
        logicChannelCount: this.logicChannelCount,
        analogChannels: channels,
        dispose: () => {
          for (const release of releases) release();
        },
      };
    } catch (error) {
      for (const release of releases) release();
      throw error;
    }
  }
}
