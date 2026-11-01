export function formatRate(value: number, unit: 'S/s' | 'Hz' = 'S/s'): string {
  if (!Number.isFinite(value)) return '—';
  const prefixes = ['', 'k', 'M', 'G', 'T', 'P', 'E'];
  let index = 0;
  while (index < prefixes.length - 1 && Number((Math.abs(value) / 1000 ** index).toFixed(3)) >= 1000) index++;
  return `${(value / 1000 ** index).toLocaleString(undefined, { maximumFractionDigits: 3, useGrouping: false })} ${prefixes[index]}${unit}`;
}
