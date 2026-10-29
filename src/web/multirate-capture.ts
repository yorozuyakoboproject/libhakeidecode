import type { AcquisitionChunk, DeviceConfiguration, AnalogTiming } from '../libhakei/device.js';
import { deviceChannelIndices } from '../libhakei/device.js';
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
      store: new PendingAnalogStore(config.sampleRate, budget),
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
    if (!('format' in chunk)) throw new Error('Expected independently timed data');
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
    if (!(channel.store instanceof TimedAnalogStore)) {
      channel.store = new TimedAnalogStore(
        new AnalogSampleStore(chunk.timing.clockHz / Number(chunk.timing.periodTicks), this.budget),
        chunk.timing,
        this.config.sampleRate,
        BigInt(this.config.sampleCount),
      );
      const rate = chunk.timing.clockHz / Number(chunk.timing.periodTicks);
      channel.name = `PC${chunk.channel + 1} · ${chunk.timing.bits === 10 ? 'HSADC' : 'ADC1'} · ${rate.toLocaleString(undefined, { maximumFractionDigits: 3 })} S/s · ${chunk.timing.uncertaintyTicks === 0xffffffff ? '同步未验证' : `±${chunk.timing.uncertaintyTicks / chunk.timing.clockHz}s`}`;
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
