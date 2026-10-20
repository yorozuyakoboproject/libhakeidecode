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

export interface AcquisitionDescription {
  readonly layout: 'channel-arrays' | 'packed-logic';
  readonly logicSampleBytes: 1 | 2 | 4 | 8;
  readonly analogSampleBytes: 4 | 8;
  readonly chunkSamples: number;
  readonly workingBytes?: number;
  readonly managedBuffers?: boolean;
  readonly worker?: { readonly moduleUrl: string; readonly exportName: string; readonly required?: boolean; readonly initialization?: unknown };
}

export interface PackedLogicChunk {
  readonly format: 'packed-logic';
  readonly startSample: bigint;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly length: number;
  readonly encoding: 'raw8';
  readonly data: Uint8Array;
  readonly h417Transport?: { reads: number; receivedBytes: number; parserMs: number; queuePeak: number; dataFrames: number };
  readonly h417Worker?: { packedCopyMs: number; bufferWaitMs: number; consumerWaitMs: number };
}
export type AcquisitionChunk = import('./index.js').SampleChunkInput | PackedLogicChunk;
export interface SampleSourceContext {
  readonly signal?: AbortSignal;
  readonly chunkSamples?: number;

  readonly acquireBuffer?: () => Promise<ArrayBuffer>;
}
export interface SampleDevice {
  readonly descriptor: DeviceDescriptor;

  readonly connected?: boolean;

  restore?(): Promise<boolean>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  onConnectionChange?: (() => void) | null;

  getCapabilities(configuration: DeviceConfiguration): DeviceCapabilities;
  getAcquisitionDescription?(configuration: DeviceConfiguration): AcquisitionDescription;
  createSource(configuration: DeviceConfiguration, context?: SampleSourceContext): SampleSource;
  createPackedSource?(configuration: DeviceConfiguration, context?: SampleSourceContext): AsyncIterable<PackedLogicChunk>;
}
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
    const valid = option.kind === 'choice' ? typeof value === 'string' && option.values.includes(value)
      : typeof value === 'number' && Number.isFinite(value)
        && (option.min === undefined || value >= option.min) && (option.max === undefined || value <= option.max)
        && (option.step === undefined || Math.abs((value - (option.min ?? 0)) / option.step - Math.round((value - (option.min ?? 0)) / option.step)) < 1e-8);
    if (!valid) throw new RangeError(`Unsupported ${option.id}: ${value}`);
  }
}
