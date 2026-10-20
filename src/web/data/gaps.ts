import { minSample, maxSample } from '../../libhakei/sample-index.js';

import type { GapSpan, SampleStore } from './types.js';

export function isSampleIndex(v: unknown): boolean {
  return typeof v === 'bigint' || (typeof v === 'number' && Number.isSafeInteger(v));
}

export function assertGapBounds(startSample: bigint, endSample: bigint, length: bigint): void {
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

export function mergeGap(list: readonly GapSpan[], start: bigint, end: bigint): GapSpan[] {
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
    lo = minSample(lo, g.startSample);
    hi = maxSample(hi, g.endSample);
  }
  if (!placed) out.push({ startSample: lo, endSample: hi });
  return out;
}

export function splitAroundGaps(
  gaps: readonly GapSpan[], s: bigint, e: bigint,
): Array<[bigint, bigint]> {
  if (gaps.length === 0) return [[s, e]];
  const out: Array<[bigint, bigint]> = [];
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

export function channelAcrossGaps(
  store: SampleStore, channel: number,
): { initial: 0 | 1; edges: bigint[] } {
  const len = store.length;
  if (len === 0n) return { initial: 0, edges: [] };

  const levelAt = (p: bigint): 0 | 1 => (store.query(channel, p, p + 1n, 1).high[0] ? 1 : 0);
  const initial = levelAt(0n);
  const src = store.edges(channel, 0n, len);
  const gaps = store.gaps();
  if (gaps.length === 0) return { initial, edges: src };
  const extra: bigint[] = [];
  let i = 0;
  let count = 0;
  for (const g of gaps) {
    if (g.endSample >= len) continue;
    while (i < src.length && src[i]! <= g.endSample) { i++; count++; }
    const have = (initial ^ ((count + extra.length) & 1)) as 0 | 1;
    if (have !== levelAt(g.endSample)) extra.push(g.endSample - 1n);
  }
  if (extra.length === 0) return { initial, edges: src };
  const out = new Array<bigint>(src.length + extra.length);
  let a = 0, b = 0, w = 0;
  while (a < src.length || b < extra.length) {
    if (b >= extra.length || (a < src.length && src[a]! <= extra[b]!)) out[w++] = src[a++]!;
    else out[w++] = extra[b++]!;
  }
  return { initial, edges: out };
}
