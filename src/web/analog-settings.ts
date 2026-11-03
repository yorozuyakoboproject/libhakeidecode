import type { AnalogRange } from './data/analogStore.js';

export interface AnalogSettings {
  color: string;
  positiveDivs: number;
  negativeDivs: number;
  divHeight: number;
  resolution: number;
  autorange: boolean;
  conversion: 'none' | 'threshold' | 'schmitt';
  threshold: string;
  traces: 'analog' | 'converted' | 'both';
}

export const thresholdPresets = [
  ['average', 'analog.average'],
  ['0.9', '0.9 V (1.8 V CMOS)'],
  ['1.8', '1.8 V (3.3 V CMOS)'],
  ['2.5', '2.5 V (5.0 V CMOS)'],
  ['1.5', '1.5 V (TTL)'],
  ['0', '0 V'],
] as const;
export const schmittPresets = [
  ['average', 'analog.averageHysteresis'],
  ['0.3/1.2', '0.3 / 1.2 V (1.8 V CMOS)'],
  ['0.7/2.5', '0.7 / 2.5 V (3.3 V CMOS)'],
  ['1.3/3.7', '1.3 / 3.7 V (5.0 V CMOS)'],
  ['0.8/2.0', '0.8 / 2.0 V (TTL)'],
  ['0/0', '0 / 0 V'],
] as const;

function fullColor(color: string): string {
  return color.replace(
    /^#([\da-f])([\da-f])([\da-f])$/i,
    (_, r: string, g: string, b: string) => `#${r}${r}${g}${g}${b}${b}`,
  );
}

export function defaultAnalogSettings(color = '#70d7a1'): AnalogSettings {
  return {
    color: fullColor(color),
    positiveDivs: 1,
    negativeDivs: 0,
    divHeight: 44,
    resolution: 1,
    autorange: true,
    conversion: 'none',
    threshold: 'average',
    traces: 'both',
  };
}
export function roundAnalogResolution(value: number, rounding: 'nearest' | 'up' = 'nearest'): number {
  if (!Number.isFinite(value)) throw new Error('Invalid analog resolution');
  if (value >= Number.MAX_SAFE_INTEGER / 1000) return value;
  const steps = Math.max(1, value * 1000),
    epsilon = Number.EPSILON * Math.max(1, Math.abs(steps));
  return (rounding === 'up' ? Math.ceil(steps - epsilon) : Math.round(steps + epsilon)) / 1000;
}
export function parseAnalogSettings(value: unknown): AnalogSettings {
  const s = value as AnalogSettings;
  if (
    !s ||
    !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(s.color) ||
    !Number.isInteger(s.positiveDivs) ||
    s.positiveDivs < 0 ||
    s.positiveDivs > 8 ||
    !Number.isInteger(s.negativeDivs) ||
    s.negativeDivs < 0 ||
    s.negativeDivs > 8 ||
    s.positiveDivs + s.negativeDivs < 1 ||
    !Number.isInteger(s.divHeight) ||
    s.divHeight < 12 ||
    s.divHeight > 250 ||
    !Number.isFinite(s.resolution) ||
    s.resolution <= 0 ||
    !Number.isFinite((s.positiveDivs + s.negativeDivs) * s.resolution) ||
    typeof s.autorange !== 'boolean' ||
    !['none', 'threshold', 'schmitt'].includes(s.conversion) ||
    !['analog', 'converted', 'both'].includes(s.traces) ||
    !(s.conversion === 'schmitt' ? schmittPresets : thresholdPresets).some(([key]) => key === s.threshold)
  )
    throw new Error('Invalid analog channel settings');
  return {
    color: fullColor(s.color),
    positiveDivs: s.positiveDivs,
    negativeDivs: s.negativeDivs,
    divHeight: s.divHeight,
    resolution: roundAnalogResolution(s.resolution),
    autorange: s.autorange,
    conversion: s.conversion,
    threshold: s.threshold,
    traces: s.traces,
  };
}
export function analogAxis(
  range: AnalogRange,
  settings: AnalogSettings,
): {
  minimum: number;
  maximum: number;
  perDivision: number;
} {
  let perDivision = roundAnalogResolution(settings.resolution);
  if (settings.autorange) {
    const padding = range.max > range.min ? (range.max - range.min) * 0.05 : Math.max(Math.abs(range.min) * 0.05, 1);
    perDivision = roundAnalogResolution(
      Math.max(
        settings.positiveDivs ? Math.max(0, range.max + padding) / settings.positiveDivs : 0,
        settings.negativeDivs ? Math.max(0, padding - range.min) / settings.negativeDivs : 0,
      ),
      'up',
    );
  }
  return {
    minimum: settings.negativeDivs ? -Number((settings.negativeDivs * perDivision).toFixed(3)) : 0,
    maximum: Number((settings.positiveDivs * perDivision).toFixed(3)),
    perDivision,
  };
}
export function analogHeight(settings: AnalogSettings): number {
  return (
    (settings.positiveDivs + settings.negativeDivs) * settings.divHeight +
    10 +
    (settings.conversion !== 'none' && settings.traces === 'both' ? 24 : 0)
  );
}
