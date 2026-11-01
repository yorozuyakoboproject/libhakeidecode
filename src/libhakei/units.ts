function scaledLabel(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '—';
  const prefixes = ['', 'k', 'M', 'G', 'T', 'P', 'E'];
  let index = 0;
  while (index < prefixes.length - 1 && Number((Math.abs(value) / 1000 ** index).toFixed(3)) >= 1000) index++;
  return `${(value / 1000 ** index).toLocaleString(undefined, { maximumFractionDigits: 3, useGrouping: false })} ${prefixes[index]}${unit}`.trimEnd();
}
export function formatRate(value: number, unit: 'S/s' | 'Hz' = 'S/s'): string {
  return scaledLabel(value, unit);
}
export function formatSampleCount(value: number | bigint): string {
  return scaledLabel(Number(value), '');
}
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const units = [
    [60, 'min'],
    [1, 's'],
    [1e-3, 'ms'],
    [1e-6, 'µs'],
    [1e-9, 'ns'],
  ] as const;
  const [scale, unit] = units.find(([scale]) => Math.abs(seconds) >= scale) ?? (seconds ? units[4] : units[1]);
  return `${(seconds / scale).toLocaleString(undefined, { maximumFractionDigits: 3, useGrouping: false })} ${unit}`;
}
