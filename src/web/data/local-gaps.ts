import type { GapSpan } from './local-types.js';

export function isSampleIndex(v: number): boolean {
  return Number.isFinite(v) && (v | 0) === v;
}

export function assertGapBounds(startSample: number, endSample: number, length: number): void {
  if (!isSampleIndex(startSample) || !isSampleIndex(endSample)) {
    throw new Error(`gap must have integer bounds, got [${startSample}, ${endSample})`);
  }
  if (!(endSample > startSample)) {
    throw new Error(`gap must be non-empty, got [${startSample}, ${endSample})`);
  }
  if (startSample < 0 || endSample > length) {
    throw new Error(`gap [${startSample}, ${endSample}) outside 0 <= start < end <= ${length}`);
  }
}

export function mergeGap(list: readonly GapSpan[], start: number, end: number): GapSpan[] {
  const out: GapSpan[] = [];
  let lo = start, hi = end;
  let placed = false;
  for (const g of list) {
    if (!placed && g.startSample > hi) {
      out.push({ startSample: lo, endSample: hi });
      placed = true;
    }
    if (placed || g.endSample < lo) {
      out.push(g);
      continue;
    }
    lo = Math.min(lo, g.startSample);
    hi = Math.max(hi, g.endSample);
  }
  if (!placed) out.push({ startSample: lo, endSample: hi });
  return out;
}

export function splitAroundGaps(
  gaps: readonly GapSpan[], s: number, e: number,
): Array<[number, number]> {
  if (gaps.length === 0) return [[s, e]];
  const out: Array<[number, number]> = [];
  let a = s;
  for (const g of gaps) {
    if (g.endSample <= a) continue;
    if (g.startSample >= e) break;
    if (g.startSample > a) out.push([a, g.startSample]);
    a = g.endSample;
    if (a >= e) return out;
  }
  if (a < e) out.push([a, e]);
  return out;
}
