import type { OptionValue } from '../../libhakeidecode/types.js';

export type DemoAnalogPattern = 'sine' | 'square' | 'triangle' | 'sawtooth' | 'random' | 'constant';

export interface DemoSignalBase {
  id: string;
  name: string;
  kind: 'encoder' | 'analog';
}

export interface DemoEncoderSignal extends DemoSignalBase {
  kind: 'encoder';
  decoder: string;
  caseName: string;
  options: Record<string, OptionValue>;
  mapping: Record<string, number>;
}

export interface DemoAnalogSignal extends DemoSignalBase {
  kind: 'analog';
  channel: number;
  pattern: DemoAnalogPattern;
  frequencyHz: number;
  amplitude: number;
  offset: number;
  seed: number;
}

export type DemoSignal = DemoEncoderSignal | DemoAnalogSignal;

export const DEMO_ANALOG_PATTERNS: readonly DemoAnalogPattern[] = [
  'sine',
  'square',
  'triangle',
  'sawtooth',
  'random',
  'constant',
];

export function defaultDemoSignals(): DemoSignal[] {
  return [
    {
      id: 'demo-pwm',
      name: 'PWM',
      kind: 'encoder',
      decoder: 'pwm',
      caseName: 'active-high-fixed-1khz-50-duty',
      options: { polarity: 'active-high' },
      mapping: { data: 0 },
    },
    {
      id: 'demo-sine',
      name: 'Sine A0',
      kind: 'analog',
      channel: 0,
      pattern: 'sine',
      frequencyHz: 1_000,
      amplitude: 1,
      offset: 0,
      seed: 1,
    },
  ];
}

export const DEFAULT_DEMO_SIGNALS = JSON.stringify(defaultDemoSignals());

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid demo signal ' + name);
  return value;
}

function channel(value: unknown, selected: readonly number[], name: string): number {
  if (!Number.isSafeInteger(value) || !selected.includes(Number(value)))
    throw new Error('Unselected demo signal channel: ' + name);
  return Number(value);
}

function optionValue(value: unknown): value is OptionValue {
  return (
    typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
  );
}

export function parseDemoSignals(
  raw: string,
  logicChannels: readonly number[],
  analogChannels: readonly number[],
  encoders: readonly string[],
): DemoSignal[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid demo signal configuration');
  }
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid demo signal list');
  const ids = new Set<string>(),
    digital = new Set<number>(),
    analog = new Set<number>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid demo signal');
    const signal = item as Partial<DemoSignal>;
    if (
      typeof signal.id !== 'string' ||
      !signal.id ||
      signal.id.length > 80 ||
      ids.has(signal.id) ||
      typeof signal.name !== 'string' ||
      !signal.name.trim() ||
      signal.name.length > 80
    )
      throw new Error('Invalid demo signal identity');
    ids.add(signal.id);
    if (signal.kind === 'encoder') {
      const mapping = signal.mapping;
      if (
        typeof signal.decoder !== 'string' ||
        !encoders.includes(signal.decoder) ||
        typeof signal.caseName !== 'string' ||
        !signal.caseName ||
        !mapping ||
        typeof mapping !== 'object' ||
        Array.isArray(mapping)
      )
        throw new Error('Invalid demo encoder signal');
      const entries = Object.entries(mapping);
      if (!entries.length) throw new Error('Demo encoder signal requires a channel mapping');
      const mapped: Record<string, number> = {};
      for (const [key, target] of entries) {
        if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error('Invalid demo encoder mapping');
        const channelIndex = channel(target, logicChannels, key);
        if (digital.has(channelIndex)) throw new Error('Demo digital channel is mapped more than once');
        digital.add(channelIndex);
        mapped[key] = channelIndex;
      }
      const options = signal.options;
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.entries(options).some(([key, option]) => !/^[a-z_]+$/.test(key) || !optionValue(option))
      )
        throw new Error('Invalid demo encoder options');
      return {
        id: signal.id,
        name: signal.name.trim(),
        kind: 'encoder',
        decoder: signal.decoder,
        caseName: signal.caseName,
        options: { ...options },
        mapping: mapped,
      };
    }
    if (signal.kind !== 'analog') throw new Error('Unknown demo signal kind');
    const channelIndex = channel(signal.channel, analogChannels, String(index));
    if (analog.has(channelIndex)) throw new Error('Demo analog channel is configured more than once');
    analog.add(channelIndex);
    const frequency = finite(signal.frequencyHz, 'frequency'),
      seed = signal.seed;
    if (
      typeof signal.pattern !== 'string' ||
      !DEMO_ANALOG_PATTERNS.includes(signal.pattern as DemoAnalogPattern) ||
      !(frequency > 0) ||
      !Number.isSafeInteger(seed)
    )
      throw new Error('Invalid demo analog signal');
    return {
      id: signal.id,
      name: signal.name.trim(),
      kind: 'analog',
      channel: channelIndex,
      pattern: signal.pattern as DemoAnalogPattern,
      frequencyHz: frequency,
      amplitude: finite(signal.amplitude, 'amplitude'),
      offset: finite(signal.offset, 'offset'),
      seed: seed!,
    };
  });
}

function hashSeed(seed: number): number {
  let value = seed >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function randomAt(seed: number, sample: number): number {
  let value = hashSeed(seed ^ sample);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

export function analogValue(signal: DemoAnalogSignal, sample: number, sampleRate: number): number {
  const cycles = (sample * signal.frequencyHz) / sampleRate,
    fraction = cycles - Math.floor(cycles);
  switch (signal.pattern) {
    case 'sine':
      return signal.offset + signal.amplitude * 0.5 * (Math.sin(cycles * 2 * Math.PI) + 1);
    case 'square':
      return signal.offset + (fraction < 0.5 ? signal.amplitude : 0);
    case 'triangle':
      return signal.offset + signal.amplitude * (1 - Math.abs(2 * fraction - 1));
    case 'sawtooth':
      return signal.offset + signal.amplitude * fraction;
    case 'random':
      return signal.offset + signal.amplitude * randomAt(signal.seed, sample);
    case 'constant':
      return signal.offset;
  }
}
