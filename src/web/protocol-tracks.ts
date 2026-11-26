import type { DecoderDefinition, DecoderRowDefinition } from '../decoders/definition.js';
import type { ProtocolSettings } from './workspace.js';

export interface VisibleProtocolRow {
  readonly id: string;
  readonly rowIndex: number;
  readonly row: DecoderRowDefinition;
}

export interface TrackColorStyle {
  readonly fill: string;
  readonly border: string;
  readonly text: string;
}

export function protocolRowId(row: DecoderRowDefinition, index: number): string {
  return row.id || `row-${index}`;
}

export function normalizeHiddenRows(
  definition: DecoderDefinition,
  hiddenRows: readonly string[] | undefined,
): string[] {
  if (!hiddenRows?.length) return [];
  const valid = new Set(definition.ui.rows.map((row, index) => protocolRowId(row, index)));
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of hiddenRows) {
    if (typeof id !== 'string' || !valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function visibleProtocolRows(
  definition: DecoderDefinition,
  protocol: Pick<ProtocolSettings, 'hiddenRows' | 'collapsed'>,
): VisibleProtocolRow[] {
  if (protocol.collapsed) return [];
  const hidden = new Set(protocol.hiddenRows ?? []);
  const result: VisibleProtocolRow[] = [];
  definition.ui.rows.forEach((row, rowIndex) => {
    const id = protocolRowId(row, rowIndex);
    if (!hidden.has(id)) result.push({ id, rowIndex, row });
  });
  return result;
}

function parseRgb(color: string): readonly [number, number, number] {
  const clean = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(clean)) {
    return [
      Number.parseInt(clean.slice(1, 3), 16) / 255,
      Number.parseInt(clean.slice(3, 5), 16) / 255,
      Number.parseInt(clean.slice(5, 7), 16) / 255,
    ];
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(clean);
  if (rgbMatch) {
    return [Number(rgbMatch[1]) / 255, Number(rgbMatch[2]) / 255, Number(rgbMatch[3]) / 255];
  }
  return [0x70 / 255, 0xd7 / 255, 0xa1 / 255];
}

export function isDarkColor(color: string): boolean {
  const [r, g, b] = parseRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.52;
}

export function hexToHsl(hexColor: string): { h: number; s: number; l: number } {
  const [r, g, b] = parseRgb(hexColor);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = (((g - b) / d) % 6) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h: (h + 360) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function contrastTextForHex(hexColor: string): string {
  return isDarkColor(hexColor) ? '#f8fafc' : '#0f172a';
}

export function protocolTrackHue(baseColor: string, rowIndex: number, classOffset = 0): number {
  const { h } = hexToHsl(baseColor);
  return Math.round((h + 24 * rowIndex + 40 * classOffset) % 360);
}

export function protocolTrackColor(
  baseColor: string,
  rowIndex: number,
  classOffset: number,
  darkTheme: boolean,
): TrackColorStyle {
  const hue = protocolTrackHue(baseColor, rowIndex, classOffset);
  if (darkTheme) {
    return {
      fill: `hsl(${hue} 62% 38%)`,
      border: `hsl(${hue} 74% 58%)`,
      text: '#f8fafc',
    };
  }
  return {
    fill: `hsl(${hue} 72% 72%)`,
    border: `hsl(${hue} 58% 40%)`,
    text: '#0f172a',
  };
}
