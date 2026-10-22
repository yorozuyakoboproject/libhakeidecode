export type ThemeMode = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): Theme {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}
export function validTheme(value: string | null): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}
const paletteKeys = [
  'bg',
  'grid',
  'axis',
  'label-bg',
  'label',
  'divider',
  'cursor',
  'hover',
  'annotation-rx',
  'annotation-tx',
  'annotation-error',
  'annotation-frequency',
  'annotation-text',
  'overview-bg',
  'overview-line',
  'overview-selection',
  'overview-border',
] as const;
export type Palette = Record<(typeof paletteKeys)[number], string> & { channels: string[] };
export function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  return {
    ...Object.fromEntries(paletteKeys.map((key) => [key, style.getPropertyValue('--wave-' + key).trim()])),
    channels: Array.from({ length: 8 }, (_, i) => style.getPropertyValue('--channel-' + i).trim()),
  } as Palette;
}
