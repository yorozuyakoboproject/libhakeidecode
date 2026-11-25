import { sampleIndex, samplePosition } from './sample-index.js';
import type { SampleSource } from './index.js';

export type NumericCapability<T extends number | bigint = number> =
  | { readonly kind: 'list'; readonly values: readonly T[]; readonly default: T }
  | { readonly kind: 'range'; readonly min: T; readonly max: T; readonly step: T; readonly default: T };
export interface DeviceCapabilities {
  readonly timebaseOnly?: boolean;
  readonly analogTiming?: readonly {
    readonly channel: number;
    readonly sampleRate: number;
    readonly outputBits: number;
  }[];
  readonly sampleRate: NumericCapability;
  readonly analogSampleRate?: NumericCapability;
  readonly sampleCount: NumericCapability<number | bigint>;
  readonly logicChannels: NumericCapability;
  readonly analogChannels: NumericCapability;
}
type DeviceOptionBase = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly hidden?: boolean;
};
export type DeviceOption = DeviceOptionBase &
  (
    | {
        readonly kind: 'choice';
        readonly values: readonly string[];
        readonly labels?: Readonly<Record<string, string>>;
        readonly default: string;
      }
    | {
        readonly kind: 'number';
        readonly min?: number;
        readonly max?: number;
        readonly step?: number;
        readonly default: number;
      }
    | {
        readonly kind: 'text';
        readonly default: string;
      }
  );
export interface DeviceDescriptor {
  readonly transport?: {
    readonly selected: string;
    readonly active?: string;
    readonly choices: readonly string[];
    readonly port?: number;
    readonly defaultPort?: number;
  };
  readonly logicInputs?: readonly { readonly index: number; readonly name: string }[];
  readonly analogInputs?: readonly { readonly index: number; readonly name: string }[];
  readonly id: string;
  readonly name: string;
  readonly capabilities: DeviceCapabilities;
  readonly options: readonly DeviceOption[];
}
export interface DeviceConfiguration {
  readonly sampleRate: number;
  readonly analogSampleRate?: number;
  readonly sampleCount: number | bigint;
  readonly logicChannels: number;
  readonly analogChannels: number;
  readonly logicChannelIndices?: readonly number[];
  readonly analogChannelIndices?: readonly number[];
  readonly options: Readonly<Record<string, string | number>>;
}

export type CaptureMode = 'single' | 'continuous';

export function deviceChannelIndices(configuration: DeviceConfiguration, kind: 'logic' | 'analog'): readonly number[] {
  return (
    configuration[`${kind}ChannelIndices`] ?? Array.from({ length: configuration[`${kind}Channels`] }, (_, i) => i)
  );
}

export interface DeviceConfigurationState {
  readonly configuration: DeviceConfiguration;
  readonly capabilities: DeviceCapabilities;
}
interface AcquisitionBuffers {
  readonly logicSampleBytes: 1 | 2 | 3 | 4 | 8;
  readonly analogSampleBytes: 4 | 8;
  readonly chunkSamples: number;
  readonly workingBytes?: number;
}
export interface ChannelArrayAcquisitionDescription extends AcquisitionBuffers {
  readonly layout: 'channel-arrays';
}
export interface PackedLogicAcquisitionDescription extends AcquisitionBuffers {
  readonly layout: 'packed-logic';
  readonly logicSampleBytes: 1 | 2 | 3 | 4;
}
export interface MultiRateAcquisitionDescription extends AcquisitionBuffers {
  readonly layout: 'multi-rate';
}
export type AcquisitionDescription =
  | ChannelArrayAcquisitionDescription
  | PackedLogicAcquisitionDescription
  | MultiRateAcquisitionDescription;
export type DriverDiagnostics = Readonly<Record<string, number>>;
export interface TransferProgress {
  readonly receivedBytes: number;
  readonly elapsedMs: number;
  readonly bytesPerSecond: number;
  readonly averageBytesPerSecond: number;
  readonly complete: boolean;
}

export interface PackedLogicChunk {
  readonly format: 'packed-logic';
  readonly startSample: bigint;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly length: number;
  readonly encoding: 'raw8' | 'raw16' | 'raw24' | 'raw32';
  readonly data: Uint8Array;
}
export function packedLogicSampleBytes(chunk: Pick<PackedLogicChunk, 'encoding'>): 1 | 2 | 3 | 4 {
  return chunk.encoding === 'raw16' ? 2 : chunk.encoding === 'raw24' ? 3 : chunk.encoding === 'raw32' ? 4 : 1;
}
export interface AnalogTiming {
  readonly direct?: true;
  readonly clockHz: number;
  readonly periodTicks: bigint;
  readonly firstTick: bigint;
  readonly uncertaintyTicks: number;
  readonly bits: 8 | 9 | 10 | 11 | 12;
  readonly nativeBits?: 10 | 12;
  readonly conversionTicks?: bigint;
  readonly decimation?: number;
  readonly referenceMv: number;
}
export interface AnalogStreamChunk {
  readonly format: 'analog';
  readonly channel: number;
  readonly startSample: bigint;
  readonly timing: AnalogTiming;
  readonly data: Float32Array;
}
export interface TimelineChunk {
  readonly format: 'timeline';
  readonly length: bigint;
}
export type AcquisitionChunk =
  | import('./index.js').SampleChunkInput
  | PackedLogicChunk
  | AnalogStreamChunk
  | TimelineChunk;
export interface SampleSourceContext {
  readonly signal?: AbortSignal;
  readonly mode?: CaptureMode;
  readonly chunkSamples?: number;

  readonly acquireBuffer?: () => Promise<ArrayBuffer>;
  readonly reportDiagnostics?: (diagnostics: DriverDiagnostics) => void;
  readonly reportTransferProgress?: (progress: TransferProgress) => void;
}
export interface ManagedSampleSourceContext extends SampleSourceContext {
  readonly acquireBuffer: () => Promise<ArrayBuffer>;
}
interface DeviceBase {
  readonly descriptor: DeviceDescriptor;

  readonly connected?: boolean;

  restore?(initialization?: unknown): Promise<boolean>;
  connect?(initialization?: unknown): Promise<void>;
  disconnect?(): Promise<void>;
  setTransport?(mode: string, port?: number): Promise<void>;
  refreshTransport?(): Promise<void>;
  onConnectionChange?: (() => void) | null;

  readonly initialization?: unknown;

  getCapabilities(configuration: DeviceConfiguration): DeviceCapabilities;
}
export interface ChannelArrayDevice extends DeviceBase {
  readonly layout: 'channel-arrays';
  getAcquisitionDescription(configuration: DeviceConfiguration): ChannelArrayAcquisitionDescription;
  createSource(configuration: DeviceConfiguration, context: ManagedSampleSourceContext): SampleSource;
}
export interface PackedLogicDevice extends DeviceBase {
  readonly layout: 'packed-logic';
  getAcquisitionDescription(configuration: DeviceConfiguration): PackedLogicAcquisitionDescription;
  createPackedSource(
    configuration: DeviceConfiguration,
    context: ManagedSampleSourceContext,
  ): AsyncIterable<PackedLogicChunk>;
}
export interface MultiRateDevice extends DeviceBase {
  readonly layout: 'multi-rate';
  getAcquisitionDescription(
    configuration: DeviceConfiguration,
  ): MultiRateAcquisitionDescription | PackedLogicAcquisitionDescription;
  createMultiRateSource(
    configuration: DeviceConfiguration,
    context: ManagedSampleSourceContext,
  ): AsyncIterable<AcquisitionChunk>;
  createPackedSource(
    configuration: DeviceConfiguration,
    context: ManagedSampleSourceContext,
  ): AsyncIterable<PackedLogicChunk>;
}
export type SampleDevice = ChannelArrayDevice | PackedLogicDevice | MultiRateDevice;
export function supportsNumericValue(capability: NumericCapability<number | bigint>, value: number | bigint): boolean {
  try {
    const n = sampleIndex(value);
    return capability.kind === 'list'
      ? capability.values.some((v) => sampleIndex(v) === n)
      : n >= sampleIndex(capability.min) &&
          n <= sampleIndex(capability.max) &&
          (n - sampleIndex(capability.min)) % sampleIndex(capability.step) === 0n;
  } catch {
    return false;
  }
}
export function validateNumericValue<T extends number | bigint>(
  capability: NumericCapability<T>,
  value: T,
  name: string,
): T {
  if (!supportsNumericValue(capability, value)) throw new RangeError(`Unsupported ${name}: ${value}`);
  return value;
}

export function numericChoices<T extends number | bigint>(capability: NumericCapability<T>): T[] {
  if (capability.kind === 'list') return [...capability.values];
  const choices = new Map<string, T>();
  for (const value of [capability.min, capability.max, capability.default]) choices.set(String(value), value);
  for (let magnitude = 1n; magnitude <= sampleIndex(capability.max); magnitude *= 10n) {
    for (const multiplier of [1n, 2n, 5n]) {
      const n = magnitude * multiplier,
        value = (typeof capability.min === 'bigint' ? n : Number(n)) as T;
      if (supportsNumericValue(capability, value)) choices.set(String(value), value);
    }
  }
  return [...choices.values()]
    .filter((value) => supportsNumericValue(capability, value))
    .sort((a, b) => (samplePosition(a) < samplePosition(b) ? -1 : samplePosition(a) > samplePosition(b) ? 1 : 0));
}
export function defaultDeviceConfiguration(descriptor: DeviceDescriptor): DeviceConfiguration {
  const caps = descriptor.capabilities;
  const logicInputs = descriptor.logicInputs?.map((input) => input.index);
  return {
    sampleRate: caps.sampleRate.default,
    ...(caps.analogSampleRate ? { analogSampleRate: Number(caps.analogSampleRate.default) } : {}),
    sampleCount: caps.sampleCount.default,
    logicChannels: logicInputs?.length ?? caps.logicChannels.default,
    analogChannels: caps.analogChannels.default,
    ...(logicInputs ? { logicChannelIndices: logicInputs } : {}),
    options: Object.fromEntries(descriptor.options.map((option) => [option.id, option.default])),
  };
}
function validDeviceOption(option: DeviceOption, value: unknown): boolean {
  if (option.kind === 'text') return typeof value === 'string';
  if (option.kind === 'choice') return typeof value === 'string' && option.values.includes(value);
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (option.min === undefined || value >= option.min) &&
    (option.max === undefined || value <= option.max) &&
    (option.step === undefined ||
      Math.abs((value - (option.min ?? 0)) / option.step - Math.round((value - (option.min ?? 0)) / option.step)) <
        1e-8)
  );
}
export function resolveDeviceConfiguration(
  device: SampleDevice,
  requested: DeviceConfiguration,
): DeviceConfigurationState {
  let configuration = {
    ...requested,
    options: Object.fromEntries(
      device.descriptor.options.map((option) => [
        option.id,
        validDeviceOption(option, requested.options[option.id]) ? requested.options[option.id]! : option.default,
      ]),
    ),
  };
  for (let attempt = 0; attempt < 16; attempt++) {
    const capabilities = device.getCapabilities(configuration);
    const adjusted = { ...configuration };
    adjusted.sampleRate = supportsNumericValue(capabilities.sampleRate, configuration.sampleRate)
      ? configuration.sampleRate
      : capabilities.sampleRate.default;
    adjusted.analogSampleRate = capabilities.analogSampleRate
      ? supportsNumericValue(
          capabilities.analogSampleRate,
          configuration.analogSampleRate ?? capabilities.analogSampleRate.default,
        )
        ? Number(configuration.analogSampleRate ?? capabilities.analogSampleRate.default)
        : Number(capabilities.analogSampleRate.default)
      : undefined;
    adjusted.sampleCount = supportsNumericValue(capabilities.sampleCount, configuration.sampleCount)
      ? configuration.sampleCount
      : capabilities.sampleCount.default;
    adjusted.logicChannels = configuration.logicChannelIndices
      ? configuration.logicChannelIndices.length
      : supportsNumericValue(capabilities.logicChannels, configuration.logicChannels)
        ? configuration.logicChannels
        : capabilities.logicChannels.default;
    adjusted.analogChannels = configuration.analogChannelIndices
      ? configuration.analogChannelIndices.length
      : supportsNumericValue(capabilities.analogChannels, configuration.analogChannels)
        ? configuration.analogChannels
        : capabilities.analogChannels.default;
    if (
      adjusted.sampleRate === configuration.sampleRate &&
      adjusted.analogSampleRate === configuration.analogSampleRate &&
      adjusted.sampleCount === configuration.sampleCount &&
      adjusted.logicChannels === configuration.logicChannels &&
      adjusted.analogChannels === configuration.analogChannels
    ) {
      validateDeviceConfiguration(device, adjusted);
      return { configuration: adjusted, capabilities };
    }
    configuration = adjusted;
  }
  throw new Error('Device configuration dependencies do not converge');
}
export function validateDeviceConfiguration(device: SampleDevice, configuration: DeviceConfiguration): void {
  const caps = device.getCapabilities(configuration);
  if (configuration.logicChannels + configuration.analogChannels === 0)
    throw new RangeError('Select at least one channel');
  for (const kind of ['logic', 'analog'] as const) {
    const indices = deviceChannelIndices(configuration, kind),
      capability = caps[`${kind}Channels`],
      inputs = kind === 'analog' ? device.descriptor.analogInputs : device.descriptor.logicInputs;
    const maximum = inputs
      ? inputs.reduce((value, input) => Math.max(value, input.index + 1), 0)
      : capability.kind === 'list'
        ? Math.max(...capability.values)
        : capability.max;
    if (inputs && indices.some((index) => !inputs.some((input) => input.index === index)))
      throw new RangeError(`${kind === 'analog' ? 'Analog' : 'Logic'} input is not initialized`);
    if (kind === 'logic' && inputs) {
      const positions = indices.map((index) => inputs.findIndex((input) => input.index === index));
      if (positions.some((position, offset) => position !== offset))
        throw new RangeError('Logic channels must be a contiguous prefix');
    }
    if (
      indices.length !== configuration[`${kind}Channels`] ||
      new Set(indices).size !== indices.length ||
      indices.some(
        (index, offset) =>
          !Number.isInteger(index) || index < 0 || index >= maximum || (offset > 0 && index <= indices[offset - 1]!),
      )
    )
      throw new RangeError(`Invalid ${kind} channel selection`);
  }
  for (const key of ['sampleRate', 'sampleCount', 'logicChannels', 'analogChannels'] as const) {
    validateNumericValue(caps[key], configuration[key], key);
  }
  if (caps.analogSampleRate && configuration.analogSampleRate !== undefined)
    validateNumericValue(caps.analogSampleRate, configuration.analogSampleRate, 'analogSampleRate');
  for (const key of Object.keys(configuration.options)) {
    if (!device.descriptor.options.some((option) => option.id === key))
      throw new RangeError(`Unknown device option: ${key}`);
  }
  for (const option of device.descriptor.options) {
    const value = configuration.options[option.id];
    if (!validDeviceOption(option, value)) throw new RangeError(`Unsupported ${option.id}: ${value}`);
  }
}
