import { DEMO_DEVICE_DESCRIPTOR } from './descriptor.js';
export { DEMO_DEVICE_DESCRIPTOR } from './descriptor.js';
import { sampleIndex, minSample, samplePhase, type SampleInput } from '../../libhakei/sample-index.js';
import { createSampleChunk, type SampleChunk, type SampleChunkInput, type SampleSource } from '../../libhakei/index.js';
import { validateDeviceConfiguration, validateNumericValue, type DeviceConfiguration, type ChannelArrayDevice, type ManagedSampleSourceContext, type SampleSourceContext } from '../../libhakei/device.js';

export type DemoPattern = 'sine' | 'square' | 'triangle' | 'sawtooth' | 'random' | 'constant' |
  'clock' | 'incremental' | 'walking-one' | 'walking-zero';

export interface DemoChannelConfig {
  readonly id: string;
  readonly kind: 'logic' | 'analog';
  readonly pattern: DemoPattern;
  readonly frequencyHz?: number;
  readonly amplitude?: number;
  readonly offset?: number;
  readonly phase?: number;
  readonly seed?: number;
  readonly value?: number;
}

export interface DemoDriverOptions {
  readonly sampleRate: number;
  readonly length: SampleInput;
  readonly chunkSamples?: number;
  readonly channels: readonly DemoChannelConfig[];
}

const PATTERNS = new Set<DemoPattern>([
  'sine', 'square', 'triangle', 'sawtooth', 'random', 'constant', 'clock',
  'incremental', 'walking-one', 'walking-zero',
]);



export class DemoDevice implements ChannelArrayDevice {
  readonly layout = 'channel-arrays';
  readonly descriptor = DEMO_DEVICE_DESCRIPTOR;
  getCapabilities(_configuration: DeviceConfiguration) { return this.descriptor.capabilities; }
  getAcquisitionDescription(_configuration: DeviceConfiguration) {
    return { layout: 'channel-arrays' as const, logicSampleBytes: 1 as const, analogSampleBytes: 4 as const,
      chunkSamples: 65_536, workingBytes: 0 };
  }
  createSource(configuration: DeviceConfiguration, context: ManagedSampleSourceContext): SampleSource {
    validateDeviceConfiguration(this, configuration);
    const { sampleRate, sampleCount, logicChannels, analogChannels, options } = configuration;
    return new DemoDriver({ sampleRate, length: sampleCount, channels: [
      ...Array.from({ length: logicChannels }, (_, i): DemoChannelConfig => ({
        id: `D${i}`, kind: 'logic', pattern: options.logicPattern as DemoPattern,
        frequencyHz: options.frequencyHz as number, seed: (options.seed as number) + i, offset: 0,
      })),
      ...Array.from({ length: analogChannels }, (_, i): DemoChannelConfig => ({
        id: `A${i}`, kind: 'analog', pattern: options.analogPattern as DemoPattern,
        frequencyHz: options.frequencyHz as number, amplitude: options.amplitude as number,
        offset: options.offset as number, seed: (options.seed as number) + i,
      })),
    ], chunkSamples: context?.chunkSamples }, context);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

function hashSeed(seed: number): number {
  let value = seed >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15; value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function randomAt(seed: number, sample: number): number {
  let value = hashSeed(seed ^ sample);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

function waveValue(channel: DemoChannelConfig, sample: number, sampleRate: number): number {
  const frequency = channel.frequencyHz ?? 1_000;
  const amplitude = channel.amplitude ?? 1;
  const offset = channel.offset ?? 0;
  const phase = channel.phase ?? 0;
  const cycles = sample * frequency / sampleRate + phase / (2 * Math.PI);
  const fraction = cycles - Math.floor(cycles);
  switch (channel.pattern) {
    case 'sine': return offset + amplitude * .5 * (Math.sin(cycles * 2 * Math.PI) + 1);
    case 'square':
    case 'clock': return fraction < .5 ? offset + amplitude : offset;
    case 'triangle': return offset + amplitude * (1 - Math.abs(2 * fraction - 1));
    case 'sawtooth': return offset + amplitude * fraction;
    case 'random': return offset + amplitude * randomAt(channel.seed ?? 1, sample);
    case 'constant': return channel.value ?? offset;
    case 'incremental': return ((sample + (channel.seed ?? 0)) % 32) / 31;
    case 'walking-one': return ((sample + (channel.seed ?? 0)) % 32) === 0 ? 1 : 0;
    case 'walking-zero': return ((sample + (channel.seed ?? 0)) % 32) === 0 ? 0 : 1;
  }
}

function logicValue(channel: DemoChannelConfig, value: number, sample: number, channelIndex: number, channelCount: number): number {
  if (channel.pattern === 'walking-one') return sample % channelCount === channelIndex ? 1 : 0;
  if (channel.pattern === 'walking-zero') return sample % channelCount === channelIndex ? 0 : 1;
  if (channel.pattern === 'incremental') return Math.floor(sample / 2 ** channelIndex) % 2;
  return value >= (channel.offset ?? .5) + (channel.amplitude ?? 1) * .5 ? 1 : 0;
}

function validate(options: DemoDriverOptions): {sampleRate: number; length: bigint; chunkSamples: number} & { channels: readonly DemoChannelConfig[] } {
  const sampleRate = validateNumericValue(DEMO_DEVICE_DESCRIPTOR.capabilities.sampleRate, options.sampleRate, 'sampleRate');
  const length = sampleIndex(options.length, 'length');
  validateNumericValue(DEMO_DEVICE_DESCRIPTOR.capabilities.sampleCount, length, 'length');
  const chunkSamples = positiveInteger(options.chunkSamples ?? 65_536, 'chunkSamples');
  if (!options.channels.length) throw new RangeError('at least one demo channel is required');
  const ids = new Set<string>();
  const channels = options.channels.map((channel, index) => {
    if (!channel.id || ids.has(channel.id)) throw new RangeError(`channel id must be unique: ${channel.id}`);
    ids.add(channel.id);
    if (!PATTERNS.has(channel.pattern)) throw new RangeError(`unsupported demo pattern: ${channel.pattern}`);
    if (channel.frequencyHz !== undefined && (!(channel.frequencyHz > 0) || !Number.isFinite(channel.frequencyHz))) throw new RangeError(`frequencyHz must be positive: ${index}`);
    for (const [name, value] of [['amplitude', channel.amplitude], ['offset', channel.offset], ['phase', channel.phase], ['value', channel.value]] as const) {
      if (value !== undefined) finite(value, name);
    }
    if (channel.seed !== undefined && !Number.isSafeInteger(channel.seed)) throw new RangeError(`seed must be a safe integer: ${index}`);
    return { ...channel };
  });
  return { sampleRate, length, chunkSamples, channels };
}

function fillLogic(values: Uint8Array, channel: DemoChannelConfig, startSample: bigint, sampleRate: number, index: number, channels: number): void {
  const start = channel.pattern === 'incremental' ? Number(startSample % (1n << BigInt(index + 1)))
    : channel.pattern.startsWith('walking-') ? Number(startSample % BigInt(channels))
    : channel.pattern === 'random' ? Number(startSample & 0xffffffffn)
    : samplePhase(startSample, channel.frequencyHz ?? 1000, sampleRate) * sampleRate / (channel.frequencyHz ?? 1000);
  const offset = channel.offset ?? 0, amplitude = channel.amplitude ?? 1;
  const threshold = (channel.offset ?? .5) + amplitude * .5;
  switch (channel.pattern) {
    case 'walking-one': for (let i = 0; i < values.length; i++) values[i] = (start + i) % channels === index ? 1 : 0; return;
    case 'walking-zero': for (let i = 0; i < values.length; i++) values[i] = (start + i) % channels === index ? 0 : 1; return;
    case 'incremental': for (let i = 0; i < values.length; i++) values[i] = Math.floor((start + i) / 2 ** index) % 2; return;
    case 'random': {
      const seed = channel.seed ?? 1;
      for (let i = 0; i < values.length; i++) values[i] = offset + amplitude * randomAt(seed, start + i) >= threshold ? 1 : 0;
      return;
    }
    default: for (let i = 0; i < values.length; i++) values[i] = logicValue(channel, waveValue(channel, start + i, sampleRate), start + i, index, channels);
  }
}
function repeatKey(channel: DemoChannelConfig): string | null {
  if (!['square', 'clock', 'sine', 'triangle', 'sawtooth', 'constant'].includes(channel.pattern)) return null;
  return [channel.kind, channel.pattern, channel.frequencyHz, channel.amplitude, channel.offset, channel.phase, channel.value].join('/');
}

export class DemoDriver implements SampleSource {
  static readonly descriptor = DEMO_DEVICE_DESCRIPTOR;
  readonly options: ReturnType<typeof validate>;
  constructor(options: DemoDriverOptions, private readonly context?: SampleSourceContext) { this.options = validate(options); }

  async *[Symbol.asyncIterator](): AsyncGenerator<SampleChunk> {
    const { sampleRate, length, chunkSamples, channels } = this.options;
    const logicCount = channels.filter(channel => channel.kind === 'logic').length;
    for (let start = 0n; start < length; start += BigInt(chunkSamples)) {
      this.context?.signal?.throwIfAborted();
      const count = Number(minSample(BigInt(chunkSamples), length - start));
      const managed = await this.context?.acquireBuffer?.();
      let byteOffset = 0;
      const logic: Record<string, Uint8Array> = {};
      const analog: Record<string, Float32Array> = {};
      let logicIndex = 0;
      const repeated = new Map<string, Uint8Array | Float32Array>();
      channels.forEach(channel => {
        if (channel.kind === 'logic') {
          const index = logicIndex++;
          const key = repeatKey(channel), previous = key ? repeated.get(key) : undefined;
          const values = previous instanceof Uint8Array ? previous : managed ? new Uint8Array(managed, byteOffset, count) : new Uint8Array(count);
          byteOffset += count;
          if (!previous) fillLogic(values, channel, start, sampleRate, index, logicCount);
          if (key) repeated.set(key, values);
          logic[channel.id] = values;
        } else {
          byteOffset = Math.ceil(byteOffset / 4) * 4;
          const key = repeatKey(channel), previous = key ? repeated.get(key) : undefined;
          const values = previous instanceof Float32Array ? previous : managed ? new Float32Array(managed, byteOffset, count) : new Float32Array(count);
          byteOffset += count * 4;
          if (!previous) {
            const localStart = channel.pattern === 'random' ? Number(start & 0xffffffffn) : samplePhase(start, channel.frequencyHz ?? 1000, sampleRate) * sampleRate / (channel.frequencyHz ?? 1000);
            for (let i = 0; i < count; i++) values[i] = waveValue(channel, localStart + i, sampleRate);
          }
          if (key) repeated.set(key, values);
          analog[channel.id] = values;
        }
      });
      const input: SampleChunkInput = { startSample: start, sampleRate, channels: logic, analogChannels: analog, isFinal: start + BigInt(count) === length,
        metadata: { source: 'demo', patternCount: channels.length } };
      yield managed ? Object.freeze({ ...input, startSample: start, length: count, endSample: start + BigInt(count), isFinal: start + BigInt(count) === length,
        channels: Object.freeze(logic), analogChannels: Object.freeze(analog), metadata: Object.freeze(input.metadata!) }) : createSampleChunk(input);
    }
  }
}

export function createDemoSource(options: DemoDriverOptions): SampleSource {
  return new DemoDriver(options);
}
