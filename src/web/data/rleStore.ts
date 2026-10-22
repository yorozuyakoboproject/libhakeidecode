import {
  sampleIndex,
  sampleFloor,
  sampleCeil,
  minSample,
  maxSample,
  numberFraction,
  type SampleInput,
} from '../../libhakei/sample-index.js';

import { assertGapBounds, channelAcrossGaps, isSampleIndex, mergeGap, splitAroundGaps } from './gaps.js';
import type { ColumnView, GapSpan, MemoryReport, SampleStore } from './types.js';
import { GAP_BIT } from './types.js';
import { isChannelCount, type ChannelCount } from './channel-count.js';

export interface RleChannelData {
  initial: 0 | 1;

  edges: bigint[];
}

export interface RleStoreOptions {
  channelCount: ChannelCount;
  samplerate: number;

  length: SampleInput;
  channels: { initial: 0 | 1; edges: ArrayLike<SampleInput> }[];
  gaps?: GapSpan[];
}

export interface RleTransitionSource {
  initial: number;

  transitions: Float64Array;
}

export class RleSampleStore implements SampleStore {
  readonly channelCount: ChannelCount;
  readonly samplerate: number;
  readonly length: bigint;

  private readonly channels: Array<{
    initial: 0 | 1;
    edges: bigint[];
  }> = [];
  private gapList: GapSpan[] = [];

  private scratchBins = 0;
  private scratchLow = new Uint8Array(0);
  private scratchHigh = new Uint8Array(0);
  private scratchEdge = new Uint8Array(0);
  private scratchPacked = new Uint8Array(0);

  constructor(opts: RleStoreOptions) {
    const { channelCount, samplerate, channels } = opts;
    const length = sampleIndex(opts.length, 'length');
    if (!isChannelCount(channelCount)) {
      throw new Error(`channelCount must be one of 4, 8, 16, 32, 64 or 128, got ${channelCount}`);
    }
    if (!(samplerate > 0)) throw new Error(`samplerate must be positive, got ${samplerate}`);
    if (!isSampleIndex(length) || length < 0) {
      throw new Error(`length must be a non-negative integer, got ${length}`);
    }
    if (channels.length !== channelCount) {
      throw new Error(`got ${channels.length} channels for channelCount ${channelCount}`);
    }
    this.channelCount = channelCount;
    this.samplerate = samplerate;
    this.length = length;

    for (let c = 0; c < channelCount; c++) {
      const src = channels[c]!;
      if (src.initial !== 0 && src.initial !== 1) {
        throw new Error(`channel ${c}: initial must be 0 or 1, got ${src.initial}`);
      }
      const edges = Array.from(src.edges, (p) => sampleIndex(p));
      for (let i = 0; i < edges.length; i++) {
        const p = edges[i]!;
        if (!isSampleIndex(p) || p < 1 || p >= length) {
          throw new Error(`channel ${c}: edge ${i} = ${p} outside [1, ${length})`);
        }
        if (i > 0 && !(p > edges[i - 1]!)) {
          throw new Error(`channel ${c}: edges are not strictly increasing at index ${i}`);
        }
      }
      this.channels[c] = { initial: src.initial, edges };
    }

    if (opts.gaps) for (const g of opts.gaps) this.noteGap(g.startSample, g.endSample);
  }

  static fromTransitions(
    channelCount: ChannelCount,
    samplerate: number,
    length: SampleInput,
    sources: RleTransitionSource[],
  ): RleSampleStore {
    if (!(samplerate > 0)) throw new Error(`samplerate must be positive, got ${samplerate}`);
    if (sources.length !== channelCount) {
      throw new Error(`got ${sources.length} sources for channelCount ${channelCount}`);
    }
    const channels: RleChannelData[] = sources.map((src, c) => {
      if (src.initial !== 0 && src.initial !== 1) {
        throw new Error(`channel ${c}: initial must be 0 or 1, got ${src.initial}`);
      }
      const t = src.transitions;
      let initial = src.initial;
      const out: bigint[] = [];
      let pending: bigint | null = null;
      let pendingCount = 0;
      const flush = (): void => {
        if ((pendingCount & 1) === 1) {
          if (pending === 0n) initial ^= 1;
          else if (pending !== null && pending < sampleIndex(length)) out.push(pending);
        }
      };
      for (let i = 0; i < t.length; i++) {
        const x = t[i]!;
        if (!Number.isFinite(x)) throw new Error(`channel ${c}: transition ${i} is ${x}`);
        if (i > 0 && !(x > t[i - 1]!)) {
          throw new Error(`channel ${c}: transitions are not strictly ascending at index ${i}`);
        }
        if (x < 0) throw new Error('transition time must be non-negative');
        const rounded = Math.ceil(x * samplerate);
        let p: bigint;
        if (Number.isSafeInteger(rounded)) p = sampleIndex(rounded);
        else {
          const [numerator, denominator] = numberFraction(x);
          p = (numerator * BigInt(samplerate) + denominator - 1n) / denominator;
        }
        if (p !== pending) {
          flush();
          pending = p;
          pendingCount = 1;
        } else {
          pendingCount++;
        }
      }
      flush();
      return { initial: initial as 0 | 1, edges: out };
    });
    return new RleSampleStore({ channelCount, samplerate, length, channels });
  }

  static fromStore(store: SampleStore): RleSampleStore {
    const channels: RleChannelData[] = [];
    for (let c = 0; c < store.channelCount; c++) {
      const { initial, edges } = channelAcrossGaps(store, c);
      channels.push({ initial, edges });
    }
    return new RleSampleStore({
      channelCount: store.channelCount as ChannelCount,
      samplerate: store.samplerate,
      length: store.length,
      channels,
      gaps: store.gaps(),
    });
  }

  append(_chunk: Uint8Array): void {
    throw new Error('RleSampleStore is immutable - it exists for imported captures, not live append');
  }

  noteGap(startSample: SampleInput, endSample: SampleInput): void {
    startSample = sampleIndex(startSample);
    endSample = sampleIndex(endSample);
    assertGapBounds(startSample, endSample, this.length);
    this.gapList = mergeGap(this.gapList, startSample, endSample);
  }

  gaps(): GapSpan[] {
    return this.gapList.map((g) => ({ ...g }));
  }

  query(channel: number, startSample: SampleInput, endSample: SampleInput, bins: number): ColumnView {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) {
      throw new Error(`channel ${channel} out of range 0..${this.channelCount - 1}`);
    }
    if (!(bins > 0) || (bins | 0) !== bins) throw new Error(`bins must be a positive integer, got ${bins}`);
    if (!isSampleIndex(sampleFloor(startSample)) || !isSampleIndex(sampleCeil(endSample))) {
      throw new Error(`query range must be finite, got [${startSample}, ${endSample})`);
    }
    if (this.length === 0n) throw new Error('query on an empty store');
    const s = maxSample(0n, sampleFloor(startSample));
    const e = minSample(this.length, sampleCeil(endSample));
    if (s >= e) throw new Error(`empty range [${startSample}, ${endSample}) against length ${this.length}`);

    const width = e - s;
    if (bins !== this.scratchBins) {
      this.scratchBins = bins;
      this.scratchLow = new Uint8Array(bins);
      this.scratchHigh = new Uint8Array(bins);
      this.scratchEdge = new Uint8Array(bins);
      this.scratchPacked = new Uint8Array(bins);
    }
    const low = this.scratchLow,
      high = this.scratchHigh;
    const edge = this.scratchEdge,
      packed = this.scratchPacked;

    const { initial, edges } = this.channels[channel]!;
    const gaps = this.gapList;
    let gp = 0;
    for (let i = 0; i < bins; i++) {
      const c0 = s + (BigInt(i) * width) / BigInt(bins);
      let c1 = s + (BigInt(i + 1) * width) / BigInt(bins);
      if (c1 <= c0) c1 = c0 + 1n;
      if (c1 > e) c1 = e;

      const lo = lowerBound(edges, c0);
      const hi = lowerBound(edges, c1);
      const n = hi - lo;
      const edgeAtC0 = n > 0 && edges[lo]! === c0;

      let lv: number, hv: number;
      if (n - (edgeAtC0 ? 1 : 0) > 0) {
        lv = 0;
        hv = 1;
      } else {
        let levelC0 = initial ^ (lo & 1);
        if (edgeAtC0) levelC0 ^= 1;
        lv = levelC0;
        hv = levelC0;
      }
      const ev = n > 0 ? 1 : 0;

      while (gp < gaps.length && gaps[gp]!.endSample <= c0) gp++;
      const gapHit = gp < gaps.length && gaps[gp]!.startSample < c1;

      high[i] = hv;
      low[i] = lv;
      edge[i] = ev;
      packed[i] = hv | (lv << 1) | (ev << 2) | (gapHit ? GAP_BIT : 0);
    }

    return {
      channel,
      startSample: s,
      endSample: e,
      bins,
      low,
      high,
      edge,
      packed,
    };
  }

  edges(channel: number, startSample: SampleInput, endSample: SampleInput): bigint[] {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return [];
    const { edges } = this.channels[channel]!;
    let total = 0;
    for (const [a, b] of segs) total += lowerBound(edges, b) - lowerBound(edges, a);
    if (total === 0) return [];
    const out = new Array<bigint>(total);
    let w = 0;
    for (const [a, b] of segs) {
      let i = lowerBound(edges, a);
      const end = lowerBound(edges, b);
      while (i < end) out[w++] = edges[i++]!;
    }
    if (w !== total) throw new Error(`edge count changed mid-query: ${total} then ${w}`);
    return out;
  }

  edgeCount(channel: number, startSample: SampleInput, endSample: SampleInput): number {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return 0;
    const { edges } = this.channels[channel]!;
    let total = 0;
    for (const [a, b] of segs) total += lowerBound(edges, b) - lowerBound(edges, a);
    return total;
  }

  private edgeSegments(
    channel: number,
    startSample: SampleInput,
    endSample: SampleInput,
  ): Array<[bigint, bigint]> | null {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) {
      throw new Error(`channel ${channel} out of range 0..${this.channelCount - 1}`);
    }
    if (!isSampleIndex(sampleFloor(startSample)) || !isSampleIndex(sampleCeil(endSample))) {
      throw new Error(`edges range must be finite, got [${startSample}, ${endSample})`);
    }
    const s = maxSample(1n, sampleFloor(startSample));
    const e = minSample(this.length, sampleCeil(endSample));
    if (s >= e) return null;
    return splitAroundGaps(this.gapList, s, e);
  }

  memory(): MemoryReport {
    let baseBytes = 0;
    let pyramidBytes = 0;
    for (const ch of this.channels) {
      baseBytes += ch.edges.length * 24;
    }
    return {
      baseBytes,
      pyramidBytes,
      totalBytes:
        baseBytes +
        pyramidBytes +
        this.scratchLow.byteLength +
        this.scratchHigh.byteLength +
        this.scratchEdge.byteLength +
        this.scratchPacked.byteLength,
      overhead: baseBytes === 0 ? 0 : pyramidBytes / baseBytes,
      slackBytes: 0,
    };
  }

  sampleAt(channel: number, input: SampleInput): number {
    const index = sampleIndex(input);
    if (!isSampleIndex(index) || index < 0 || index >= this.length) throw new Error(`sample ${index} out of range`);
    const { initial, edges } = this.channels[channel]!;
    const below = lowerBound(edges, index + 1n);
    return initial ^ (below & 1);
  }
}

function lowerBound(edges: readonly bigint[], pos: bigint): number {
  let lo = 0,
    hi = edges.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (edges[mid]! < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
