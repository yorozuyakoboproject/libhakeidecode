import { encoderIds, loadSignalEncoder } from '../../generated/encoders.js';
import { createSampleChunk, type SampleChunk } from '../../libhakei/index.js';
import {
  deviceChannelIndices,
  validateDeviceConfiguration,
  validateNumericValue,
  type AnalogStreamChunk,
  type DeviceConfiguration,
  type ManagedSampleSourceContext,
  type MultiRateDevice,
  type PackedLogicChunk,
  type TimelineChunk,
} from '../../libhakei/device.js';
import { minSample, sampleIndex } from '../../libhakei/sample-index.js';
import { materializeLogicWindow } from '../../libhakeidecode/signal.js';
import type { RoundtripCase } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { DEMO_DEVICE_DESCRIPTOR } from './descriptor.js';
import {
  analogValue,
  parseDemoSignals,
  type DemoAnalogSignal,
  type DemoEncoderSignal,
  type DemoSignal,
} from './signal.js';

export { DEMO_DEVICE_DESCRIPTOR } from './descriptor.js';
export {
  DEMO_ANALOG_PATTERNS,
  DEFAULT_DEMO_SIGNALS,
  defaultDemoSignals,
  parseDemoSignals,
  type DemoAnalogPattern,
  type DemoAnalogSignal,
  type DemoEncoderSignal,
  type DemoSignal,
} from './signal.js';

export interface DemoDriverOptions {
  readonly sampleRate: number;
  readonly analogSampleRate: number;
  readonly length: bigint;
  readonly chunkSamples?: number;
  readonly logicChannels: readonly number[];
  readonly analogChannels: readonly number[];
  readonly signals: readonly DemoSignal[];
}

type DemoAcquisitionChunk = SampleChunk | AnalogStreamChunk | TimelineChunk;

const ANALOG_TIMING = {
  direct: true as const,
  clockHz: 1,
  periodTicks: 1n,
  firstTick: 0n,
  uncertaintyTicks: 0,
  bits: 12 as const,
  referenceMv: 4_095,
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function uniqueChannels(values: readonly number[], maximum: number, name: string): readonly number[] {
  if (
    values.some(
      (value, index) =>
        !Number.isInteger(value) || value < 0 || value >= maximum || (index && value <= values[index - 1]!),
    ) ||
    new Set(values).size !== values.length
  )
    throw new RangeError(`Invalid ${name} channel selection`);
  return values;
}

function checkedOptions(options: DemoDriverOptions): Required<DemoDriverOptions> {
  const sampleRate = validateNumericValue(
    DEMO_DEVICE_DESCRIPTOR.capabilities.sampleRate,
    options.sampleRate,
    'sampleRate',
  );
  const analogSampleRate = validateNumericValue(
    DEMO_DEVICE_DESCRIPTOR.capabilities.analogSampleRate,
    options.analogSampleRate,
    'analogSampleRate',
  );
  const length = sampleIndex(options.length, 'length');
  validateNumericValue(DEMO_DEVICE_DESCRIPTOR.capabilities.sampleCount, length, 'length');
  return {
    sampleRate,
    analogSampleRate,
    length,
    chunkSamples: positiveInteger(options.chunkSamples ?? 65_536, 'chunkSamples'),
    logicChannels: uniqueChannels(options.logicChannels, 32, 'logic'),
    analogChannels: uniqueChannels(options.analogChannels, 4, 'analog'),
    signals: options.signals,
  };
}

function encoderConfig(
  source: RoundtripCase<unknown>,
  signal: DemoEncoderSignal,
  sampleRate: number,
): RoundtripCase<unknown> {
  const channels = Object.fromEntries(Object.keys(source.channels).map((key, index) => [key, index]));
  return {
    ...source,
    sampleRate,
    startSample: 0n,
    channels,
    options: { ...source.options, ...signal.options },
    chunkSamples: [65_536],
    minimumPayloadBits: 0,
  };
}

function collectWindows(windows: readonly SignalWindow[], sampleRate: number): number {
  let end = 0;
  for (const window of windows) {
    if (window.sampleRate !== sampleRate) throw new Error('Signal encoder changed the requested sample rate');
    if (window.startSample < 0n || window.endSample < window.startSample)
      throw new Error('Signal encoder returned an invalid sample range');
    end = Math.max(end, Number(window.endSample));
  }
  return end;
}

function copyPattern(target: Uint8Array, pattern: Uint8Array, start: bigint): void {
  const offset = Number(start % BigInt(pattern.length));
  const first = Math.min(target.length, pattern.length - offset);
  target.set(pattern.subarray(offset, offset + first), 0);
  let copied = first;
  while (copied < target.length) {
    const count = Math.min(pattern.length, target.length - copied);
    target.set(pattern.subarray(0, count), copied);
    copied += count;
  }
}

async function encoderPatterns(signal: DemoEncoderSignal, sampleRate: number): Promise<Map<number, Uint8Array>> {
  const module = await loadSignalEncoder(signal.decoder);
  const source = [...module.cases({ minimumPayloadBits: 0 })].find(
    (item) => item.kind === 'boundary' && item.name === signal.caseName,
  );
  if (!source) throw new Error(`Unknown encoder case: ${signal.decoder}/${signal.caseName}`);
  const config = encoderConfig(source, signal, sampleRate);
  const windows: SignalWindow[] = [];
  const encoder = module.createEncoder(config);
  for (const block of source.generate()) windows.push(...encoder.push(block.data));
  windows.push(...encoder.finish());
  const length = collectWindows(windows, sampleRate);
  if (!length) throw new Error(`Encoder case produced no samples: ${signal.decoder}/${signal.caseName}`);
  const patterns = new Map<number, Uint8Array>();
  for (const local of Object.keys(source.channels)) {
    const physical = signal.mapping[local];
    if (physical === undefined) continue;
    const output = new Uint8Array(length);
    for (const window of windows) {
      const channel = window.channel(local);
      if (!channel) continue;
      output.set(materializeLogicWindow(channel), Number(window.startSample));
    }
    patterns.set(physical, output);
  }
  if (!patterns.size) throw new Error(`Encoder case does not drive its mapped channels: ${signal.decoder}`);
  return patterns;
}

function analogSampleCount(length: bigint, analogSampleRate: number, sampleRate: number): bigint {
  return (length * BigInt(analogSampleRate)) / BigInt(sampleRate);
}

export class DemoDevice implements MultiRateDevice {
  readonly layout = 'multi-rate';
  readonly descriptor = DEMO_DEVICE_DESCRIPTOR;
  getCapabilities(_configuration: DeviceConfiguration) {
    return this.descriptor.capabilities;
  }
  getAcquisitionDescription(_configuration: DeviceConfiguration) {
    return {
      layout: 'multi-rate' as const,
      logicSampleBytes: 1 as const,
      analogSampleBytes: 4 as const,
      chunkSamples: 65_536,
    };
  }
  createMultiRateSource(
    configuration: DeviceConfiguration,
    context: ManagedSampleSourceContext,
  ): AsyncIterable<DemoAcquisitionChunk> {
    validateDeviceConfiguration(this, configuration);
    return new DemoDriver(
      {
        sampleRate: configuration.sampleRate,
        analogSampleRate: configuration.analogSampleRate ?? configuration.sampleRate,
        length: sampleIndex(configuration.sampleCount),
        chunkSamples: context.chunkSamples,
        logicChannels: deviceChannelIndices(configuration, 'logic'),
        analogChannels: deviceChannelIndices(configuration, 'analog'),
        signals: parseDemoSignals(
          String(configuration.options.signals ?? '[]'),
          deviceChannelIndices(configuration, 'logic'),
          deviceChannelIndices(configuration, 'analog'),
          encoderIds,
        ),
      },
      context,
    );
  }
  async *createPackedSource(
    configuration: DeviceConfiguration,
    context: ManagedSampleSourceContext,
  ): AsyncGenerator<PackedLogicChunk> {
    const channels = deviceChannelIndices(configuration, 'logic');
    for await (const chunk of this.createMultiRateSource(configuration, context)) {
      if ('format' in chunk) continue;
      const data = new Uint8Array(chunk.length);
      channels.forEach((physical, index) => {
        const values = chunk.channels[`D${physical}`];
        if (!values) return;
        for (let sample = 0; sample < data.length; sample++) data[sample] |= (values[sample] ? 1 : 0) << index;
      });
      yield {
        format: 'packed-logic',
        startSample: chunk.startSample,
        sampleRate: chunk.sampleRate,
        channelCount: channels.length,
        length: chunk.length,
        encoding: 'raw8',
        data,
      };
    }
  }
}

export class DemoDriver implements AsyncIterable<DemoAcquisitionChunk> {
  static readonly descriptor = DEMO_DEVICE_DESCRIPTOR;
  readonly options: Required<DemoDriverOptions>;
  constructor(
    options: DemoDriverOptions,
    private readonly context: ManagedSampleSourceContext,
  ) {
    this.options = checkedOptions(options);
  }
  private async digitalPatterns(): Promise<Map<number, Uint8Array>> {
    const patterns = new Map<number, Uint8Array>();
    for (const signal of this.options.signals) {
      if (signal.kind !== 'encoder') continue;
      for (const [channel, values] of await encoderPatterns(signal, this.options.sampleRate))
        patterns.set(channel, values);
    }
    return patterns;
  }
  private analogSignals(): Map<number, DemoAnalogSignal> {
    return new Map(
      this.options.signals.flatMap((signal) => (signal.kind === 'analog' ? [[signal.channel, signal]] : [])),
    );
  }
  private async *analogChunks(
    startSample: bigint,
    endSample: bigint,
    signals: Map<number, DemoAnalogSignal>,
  ): AsyncGenerator<AnalogStreamChunk> {
    const { analogSampleRate, analogChannels, chunkSamples } = this.options;
    for (let start = startSample; start < endSample; start += BigInt(chunkSamples)) {
      this.context.signal?.throwIfAborted();
      const count = Number(minSample(BigInt(chunkSamples), endSample - start));
      for (const physical of analogChannels) {
        const buffer = await this.context.acquireBuffer();
        const data = new Float32Array(buffer, 0, count);
        const signal = signals.get(physical);
        if (signal) {
          for (let sample = 0; sample < data.length; sample++)
            data[sample] = analogValue(signal, Number(start) + sample, analogSampleRate);
        } else data.fill(0);
        yield {
          format: 'analog',
          channel: physical,
          startSample: start,
          timing: { ...ANALOG_TIMING, clockHz: analogSampleRate },
          data,
        };
      }
    }
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<DemoAcquisitionChunk> {
    const { sampleRate, analogSampleRate, length, chunkSamples, logicChannels, analogChannels } = this.options;
    const patterns = await this.digitalPatterns();
    const analogSignals = this.analogSignals();
    const analogLength = analogSampleCount(length, analogSampleRate, sampleRate);
    if (logicChannels.length) {
      for (let start = 0n; start < length; start += BigInt(chunkSamples)) {
        this.context.signal?.throwIfAborted();
        const count = Number(minSample(BigInt(chunkSamples), length - start));
        const buffer = await this.context.acquireBuffer();
        const channels: Record<string, Uint8Array> = {};
        let offset = 0;
        for (const physical of logicChannels) {
          const values = new Uint8Array(buffer, offset, count);
          offset += count;
          values.fill(0);
          const pattern = patterns.get(physical);
          if (pattern) copyPattern(values, pattern, start);
          channels[`D${physical}`] = values;
        }
        yield createSampleChunk({
          startSample: start,
          sampleRate,
          channels,
          isFinal: start + BigInt(count) === length,
          metadata: { source: 'demo', signals: this.options.signals.length },
        });
        if (analogChannels.length && analogLength > 0n) {
          const end = start + BigInt(count),
            analogStart = analogSampleCount(start, analogSampleRate, sampleRate),
            analogEnd = analogSampleCount(end, analogSampleRate, sampleRate);
          yield* this.analogChunks(analogStart, analogEnd, analogSignals);
        }
      }
    } else if (analogChannels.length && analogLength > 0n) yield* this.analogChunks(0n, analogLength, analogSignals);
    if (!logicChannels.length) yield { format: 'timeline', length };
  }
}

export function createDemoSource(
  options: DemoDriverOptions,
  context: ManagedSampleSourceContext,
): AsyncIterable<DemoAcquisitionChunk> {
  return new DemoDriver(options, context);
}
