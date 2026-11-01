import type { AcquisitionChunk, DeviceConfiguration, AnalogTiming } from '../libhakei/device.js';
import { deviceChannelIndices } from '../libhakei/device.js';
import { createSampleChunk } from '../libhakei/index.js';
import { formatRate } from '../libhakei/units.js';
import { PlanarSampleStore } from './data/planarStore.js';
import { RleSampleStore } from './data/rleStore.js';
import { AnalogSampleStore, type AnalogStore } from './data/analogStore.js';
import { TimedAnalogStore, PendingAnalogStore } from './data/timed-analogStore.js';
import { channelWidthForProbes } from './data/channel-count.js';
import type { MemoryBudget } from './memory.js';

export class MultiRateCapture {
  store: PlanarSampleStore | RleSampleStore;
  readonly labels: string[];
  readonly logicChannelCount: number;
  readonly analogChannels: { name: string; store: AnalogStore }[];
  private readonly selected: readonly number[];
  private padding: Uint8Array | null = null;
  constructor(
    private readonly config: DeviceConfiguration,
    private readonly budget: MemoryBudget,
  ) {
    this.labels = deviceChannelIndices(config, 'logic').map((i) => `D${i}`);
    this.logicChannelCount = this.labels.length;
    this.store = this.labels.length
      ? new PlanarSampleStore({
          channelCount: channelWidthForProbes(this.labels.length),
          samplerate: config.sampleRate,
          budget,
          transpose32: 'js',
          stagePacked: true,
          keepPacked: true,
          deferPyramid: true,
        })
      : this.timeline(0n);
    this.selected = deviceChannelIndices(config, 'analog');
    this.analogChannels = this.selected.map((i) => ({
      name: `PC${i + 1}`,
      store: new PendingAnalogStore(config.analogSampleRate ?? config.sampleRate, budget),
    }));
  }
  private timeline(length: bigint): RleSampleStore {
    return new RleSampleStore({
      channelCount: 4,
      samplerate: this.config.sampleRate,
      length,
      channels: Array.from({ length: 4 }, () => ({ initial: 0 as const, edges: [] })),
    });
  }
  append(chunk: AcquisitionChunk): void {
    if (!('format' in chunk)) {
      const sample = createSampleChunk(chunk);
      if (!(this.store instanceof PlanarSampleStore))
        throw new Error('Digital samples cannot follow a timeline-only stream');
      if (
        sample.sampleRate !== this.config.sampleRate ||
        sample.startSample !== this.store.length ||
        Object.keys(sample.channels).join('\0') !== this.labels.join('\0') ||
        Object.keys(sample.analogChannels).length ||
        sample.endSample > BigInt(this.config.sampleCount)
      )
        throw new Error('Invalid digital stream');
      if (!this.padding || this.padding.length < sample.length) this.padding = new Uint8Array(sample.length);
      const empty = this.padding.subarray(0, sample.length);
      this.store.appendChannels(
        Array.from({ length: this.store.channelCount }, (_, index) =>
          index < this.labels.length ? sample.channels[this.labels[index]!]! : empty,
        ),
      );
      return;
    }
    if (chunk.format === 'timeline') {
      if (chunk.length < this.store.length || chunk.length > BigInt(this.config.sampleCount))
        throw new Error('Invalid acquisition duration');
      if (!this.logicChannelCount) this.store = this.timeline(chunk.length);
      else if (chunk.length !== this.store.length) throw new Error('Incomplete digital stream');
      return;
    }
    if (chunk.format === 'packed-logic') {
      if (
        !(this.store instanceof PlanarSampleStore) ||
        chunk.startSample !== this.store.length ||
        chunk.channelCount !== this.logicChannelCount ||
        chunk.sampleRate !== this.config.sampleRate ||
        this.store.length + BigInt(chunk.length) > BigInt(this.config.sampleCount)
      )
        throw new Error('Invalid digital stream');
      this.store.append(chunk.data.subarray(0, chunk.length));
      return;
    }
    const index = this.selected.indexOf(chunk.channel),
      channel = this.analogChannels[index];
    if (!channel) throw new Error('Unexpected analog channel');
    if (chunk.timing.direct) {
      const store =
        channel.store instanceof AnalogSampleStore && !(channel.store instanceof PendingAnalogStore)
          ? channel.store
          : new AnalogSampleStore(Number(chunk.timing.clockHz), this.budget);
      channel.store = store;
      channel.name = `A${chunk.channel}`;
      if (store.samplerate !== Number(chunk.timing.clockHz) || chunk.startSample !== store.length)
        throw new Error('Direct analog sample rate or continuity changed');
      store.appendValidated(chunk.data);
      return;
    }
    if (!(channel.store instanceof TimedAnalogStore)) {
      channel.store = new TimedAnalogStore(
        new AnalogSampleStore(chunk.timing.clockHz / Number(chunk.timing.periodTicks), this.budget),
        chunk.timing,
        this.config.sampleRate,
        BigInt(this.config.sampleCount),
      );
      const rate = chunk.timing.clockHz / Number(chunk.timing.periodTicks);
      channel.name = `PC${chunk.channel + 1} · ${(chunk.timing.nativeBits ?? chunk.timing.bits) === 10 ? 'HSADC' : 'ADC1'} · ${formatRate(rate)} · ${chunk.timing.bits} bit · ${chunk.timing.uncertaintyTicks === 0xffffffff ? '同步未验证' : `±${chunk.timing.uncertaintyTicks / chunk.timing.clockHz}s`}`;
    }
    const store = channel.store as TimedAnalogStore;
    const fields: (keyof AnalogTiming)[] = [
      'clockHz',
      'periodTicks',
      'firstTick',
      'uncertaintyTicks',
      'bits',
      'referenceMv',
    ];
    if (fields.some((key) => store.timing[key] !== chunk.timing[key]) || chunk.startSample !== store.native.length)
      throw new Error('Analog timing or sample continuity changed');
    store.append(chunk.data, chunk.startSample);
    if (!this.logicChannelCount && store.length > this.store.length) this.store = this.timeline(store.length);
  }
  finalize(): void {
    if (this.store instanceof PlanarSampleStore) this.store.finalizePyramid();
  }
}
