import { sampleIndex, samplePosition } from './sample-index.js';
import type { SampleSource } from './index.js';

export type NumericCapability<T extends number | bigint = number> =
  | { readonly kind: 'list'; readonly values: readonly T[]; readonly default: T }
  | { readonly kind: 'range'; readonly min: T; readonly max: T; readonly step: T; readonly default: T };
export interface DeviceCapabilities {
  readonly sampleRate: NumericCapability;
  readonly sampleCount: NumericCapability<number | bigint>;
  readonly logicChannels: NumericCapability;
  readonly analogChannels: NumericCapability;
}
export type DeviceOption = {
  readonly id: string;
  readonly name: string;
} & (
  | { readonly kind: 'choice'; readonly values: readonly string[]; readonly default: string }
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly step?: number; readonly default: number }
);
export interface DeviceDescriptor {
  readonly id: string;
  readonly name: string;
  readonly capabilities: DeviceCapabilities;
  readonly options: readonly DeviceOption[];
}
export interface DeviceConfiguration {
  readonly sampleRate: number;
  readonly sampleCount: number | bigint;
  readonly logicChannels: number;
  readonly analogChannels: number;
  readonly options: Readonly<Record<string, string | number>>;
}

export interface DeviceConfigurationState {
  readonly configuration: DeviceConfiguration;
  readonly capabilities: DeviceCapabilities;
}
interface AcquisitionBuffers {
  readonly logicSampleBytes: 1 | 2 | 4 | 8;
  readonly analogSampleBytes: 4 | 8;
  readonly chunkSamples: number;
  readonly workingBytes?: number;
}
export interface ChannelArrayAcquisitionDescription extends AcquisitionBuffers { readonly layout: 'channel-arrays' }
export interface PackedLogicAcquisitionDescription extends AcquisitionBuffers { readonly layout: 'packed-logic'; readonly logicSampleBytes: 1 }
export type AcquisitionDescription = ChannelArrayAcquisitionDescription | PackedLogicAcquisitionDescription;
export type DriverDiagnostics = Readonly<Record<string, number>>;

export interface PackedLogicChunk {
  readonly format: 'packed-logic';
  readonly startSample: bigint;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly length: number;
  readonly encoding: 'raw8';
  readonly data: Uint8Array;
}
export type AcquisitionChunk = import('./index.js').SampleChunkInput | PackedLogicChunk;
export interface SampleSourceContext {
  readonly signal?: AbortSignal;
  readonly chunkSamples?: number;

  readonly acquireBuffer?: () => Promise<ArrayBuffer>;
  readonly reportDiagnostics?: (diagnostics: DriverDiagnostics) => void;
}
export interface ManagedSampleSourceContext extends SampleSourceContext { readonly acquireBuffer: () => Promise<ArrayBuffer> }
interface DeviceBase {
  readonly descriptor: DeviceDescriptor;

  readonly connected?: boolean;

  restore?(initialization?: unknown): Promise<boolean>;
  connect?(initialization?: unknown): Promise<void>;
  disconnect?(): Promise<void>;
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
  createPackedSource(configuration: DeviceConfiguration, context: ManagedSampleSourceContext): AsyncIterable<PackedLogicChunk>;
}
export type SampleDevice = ChannelArrayDevice | PackedLogicDevice;
export function supportsNumericValue(capability: NumericCapability<number | bigint>, value: number | bigint): boolean {
  try {
    const n = sampleIndex(value);
    return capability.kind === 'list' ? capability.values.some(v => sampleIndex(v) === n)
      : n >= sampleIndex(capability.min) && n <= sampleIndex(capability.max) && (n - sampleIndex(capability.min)) % sampleIndex(capability.step) === 0n;
  } catch { return false; }
}
export function validateNumericValue<T extends number | bigint>(capability: NumericCapability<T>, value: T, name: string): T {
  if (!supportsNumericValue(capability, value)) throw new RangeError(`Unsupported ${name}: ${value}`);
  return value;
}

export function numericChoices<T extends number | bigint>(capability: NumericCapability<T>): T[] {
  if (capability.kind === 'list') return [...capability.values];
  const choices = new Map<string, T>();
  for (const value of [capability.min, capability.max, capability.default]) choices.set(String(value), value);
  for (let magnitude = 1n; magnitude <= sampleIndex(capability.max); magnitude *= 10n) {
    for (const multiplier of [1n, 2n, 5n]) {
      const n = magnitude * multiplier, value = (typeof capability.min === 'bigint' ? n : Number(n)) as T;
      if (supportsNumericValue(capability, value)) choices.set(String(value), value);
    }
  }
  return [...choices.values()].filter(value => supportsNumericValue(capability, value)).sort((a, b) => samplePosition(a) < samplePosition(b) ? -1 : samplePosition(a) > samplePosition(b) ? 1 : 0);
}
export function defaultDeviceConfiguration(descriptor: DeviceDescriptor): DeviceConfiguration {
  const caps = descriptor.capabilities;
  return { sampleRate: caps.sampleRate.default, sampleCount: caps.sampleCount.default,
    logicChannels: caps.logicChannels.default, analogChannels: caps.analogChannels.default,
    options: Object.fromEntries(descriptor.options.map(option => [option.id, option.default])) };
}
function validDeviceOption(option: DeviceOption, value: unknown): boolean {
  return option.kind === 'choice' ? typeof value === 'string' && option.values.includes(value)
    : typeof value === 'number' && Number.isFinite(value)
      && (option.min === undefined || value >= option.min) && (option.max === undefined || value <= option.max)
      && (option.step === undefined || Math.abs((value - (option.min ?? 0)) / option.step - Math.round((value - (option.min ?? 0)) / option.step)) < 1e-8);
}
export function resolveDeviceConfiguration(device: SampleDevice, requested: DeviceConfiguration): DeviceConfigurationState {
  let configuration = { ...requested, options: Object.fromEntries(device.descriptor.options.map(option =>
    [option.id, validDeviceOption(option, requested.options[option.id]) ? requested.options[option.id]! : option.default])) };
  for (let attempt = 0; attempt < 16; attempt++) {
    const capabilities = device.getCapabilities(configuration);
    const adjusted = { ...configuration };
    adjusted.sampleRate = supportsNumericValue(capabilities.sampleRate, configuration.sampleRate) ? configuration.sampleRate : capabilities.sampleRate.default;
    adjusted.sampleCount = supportsNumericValue(capabilities.sampleCount, configuration.sampleCount) ? configuration.sampleCount : capabilities.sampleCount.default;
    adjusted.logicChannels = supportsNumericValue(capabilities.logicChannels, configuration.logicChannels) ? configuration.logicChannels : capabilities.logicChannels.default;
    adjusted.analogChannels = supportsNumericValue(capabilities.analogChannels, configuration.analogChannels) ? configuration.analogChannels : capabilities.analogChannels.default;
    if (adjusted.sampleRate === configuration.sampleRate && adjusted.sampleCount === configuration.sampleCount
      && adjusted.logicChannels === configuration.logicChannels && adjusted.analogChannels === configuration.analogChannels) {
      validateDeviceConfiguration(device, adjusted);
      return { configuration: adjusted, capabilities };
    }
    configuration = adjusted;
  }
  throw new Error('Device configuration dependencies do not converge');
}
export function validateDeviceConfiguration(device: SampleDevice, configuration: DeviceConfiguration): void {
  const caps = device.getCapabilities(configuration);
  for (const key of ['sampleRate', 'sampleCount', 'logicChannels', 'analogChannels'] as const) {
    validateNumericValue(caps[key], configuration[key], key);
  }
  for (const key of Object.keys(configuration.options)) {
    if (!device.descriptor.options.some(option => option.id === key)) throw new RangeError(`Unknown device option: ${key}`);
  }
  for (const option of device.descriptor.options) {
    const value = configuration.options[option.id];
    if (!validDeviceOption(option, value)) throw new RangeError(`Unsupported ${option.id}: ${value}`);
  }
}
