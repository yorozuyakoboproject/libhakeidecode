import { SEGMENT_SAMPLES } from './segment.js';
import type { MemoryBudget } from '../memory.js';

import { createTranspose32, type Transpose32Backend, type ActiveTranspose32Backend } from './transpose32-wasm.js';
import { BitPlane, HAS_ONE, HAS_ZERO, HAS_BOTH } from './bitplane.js';
import { assertGapBounds, mergeGap, splitAroundGaps } from './local-gaps.js';
import { GAP_BIT } from './local-types.js';
import { bytesPerSampleForChannels, isChannelCount, type ChannelCount } from './channel-count.js';
import type { ColumnView, GapSpan, MemoryReport, SampleStore } from './local-types.js';

export const BASE_BLOCK_BITS_LOG = 20;

const LEVEL_LOG = 4;

const MAX_LEVEL = 6;

const DEFAULT_CORE_BINS = 32;

const BYTE_TO_NIBBLES = new Uint32Array(256);
for (let value = 0; value < BYTE_TO_NIBBLES.length; value++) {
  let expanded = 0;
  for (let channel = 0; channel < 8; channel++) {
    if (value & (1 << channel)) expanded |= 1 << (channel * 4);
  }
  BYTE_TO_NIBBLES[value] = expanded;
}

const binSizeOf = (level: number): number => Math.pow(2, LEVEL_LOG * level);

function levelBlockBitsLog(level: number): number {
  return Math.max(12, BASE_BLOCK_BITS_LOG - LEVEL_LOG * level);
}

export function estimateLocalPlanarBytes(
  samples: number,
  channels: number,
): { baseBytes: number; pyramidBytes: number; totalBytes: number } {
  const baseBytes = Math.ceil(samples / 2 ** BASE_BLOCK_BITS_LOG) * 2 ** (BASE_BLOCK_BITS_LOG - 3) * channels;
  let pyramidBytes = 0;
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const bins = Math.floor(samples / binSizeOf(level)),
      blockLog = levelBlockBitsLog(level);
    pyramidBytes += Math.ceil(bins / 2 ** blockLog) * 2 ** (blockLog - 3) * channels * 2;
  }
  return { baseBytes, pyramidBytes, totalBytes: baseBytes + pyramidBytes };
}

export interface PlanarStoreOptions {
  budget?: MemoryBudget;
  channelCount: ChannelCount;
  samplerate: number;

  deferPyramid?: boolean;

  stagePacked?: boolean;

  keepPacked?: boolean;

  snapColumns?: boolean;
  coreBins?: number;

  transpose32?: Transpose32Backend;
}

export class LocalPlanarSampleStore implements SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  length = 0;

  readonly transpose32Backend: ActiveTranspose32Backend;
  readonly transposeScratchBytes: number;
  private readonly transpose32: ReturnType<typeof createTranspose32>;
  private readonly bytesPerSample: number;
  private preparedTo = 0;
  private deferPyramid: boolean;

  snapColumns: boolean;
  coreBins: number;

  private readonly base: BitPlane[] = [];

  private readonly hi: BitPlane[][] = [];
  private readonly lo: BitPlane[][] = [];

  private readonly validBins: number[] = [];
  private readonly binSize: number[] = [];

  private gapList: GapSpan[] = [];

  private scratchBins = 0;
  private scratchLow = new Uint8Array(0);
  private scratchHigh = new Uint8Array(0);
  private scratchEdge = new Uint8Array(0);
  private scratchPacked = new Uint8Array(0);

  constructor(opts: PlanarStoreOptions) {
    const { channelCount, samplerate } = opts;
    if (!isChannelCount(channelCount)) {
      throw new Error(`channelCount must be one of 4, 8, 16, 32, 64 or 128, got ${channelCount}`);
    }
    if (!(samplerate > 0)) throw new Error(`samplerate must be positive, got ${samplerate}`);
    this.channelCount = channelCount;
    this.samplerate = samplerate;
    this.bytesPerSample = bytesPerSampleForChannels(channelCount);
    this.deferPyramid = opts.deferPyramid === true;
    this.transpose32 = createTranspose32(channelCount === 32 ? opts.transpose32 : 'js');
    this.transpose32Backend = this.transpose32.backend;
    this.transposeScratchBytes = this.transpose32.scratchBytes;
    this.snapColumns = opts.snapColumns === true;
    this.coreBins = opts.coreBins ?? DEFAULT_CORE_BINS;

    for (let c = 0; c < channelCount; c++) this.base.push(new BitPlane(BASE_BLOCK_BITS_LOG, opts.budget));
    this.binSize[0] = 1;
    this.validBins[0] = 0;
    for (let k = 1; k <= MAX_LEVEL; k++) {
      const bbl = levelBlockBitsLog(k);
      const h: BitPlane[] = [];
      const l: BitPlane[] = [];
      for (let c = 0; c < channelCount; c++) {
        h.push(new BitPlane(bbl, opts.budget));
        l.push(new BitPlane(bbl, opts.budget));
      }
      this.hi[k] = h;
      this.lo[k] = l;
      this.binSize[k] = binSizeOf(k);
      this.validBins[k] = 0;
    }
  }

  prepareAppend(count: number): () => void {
    const to = this.length + count;
    if (!Number.isSafeInteger(count) || count < 0 || to > SEGMENT_SAMPLES)
      throw new RangeError('append exceeds local segment capacity');
    if (to <= this.preparedTo) return () => {};
    const previousPrepared = this.preparedTo;
    const planes = [...this.base, ...this.hi.slice(1).flat(), ...this.lo.slice(1).flat()];
    const sizes = planes.map((plane) => plane.blocks.length);
    const rollback = () => {
      this.preparedTo = previousPrepared;
      planes.forEach((plane, index) => plane.trimBlocks(sizes[index]!));
    };
    try {
      for (const plane of this.base) plane.reserve(to);
      for (let level = 1; level <= MAX_LEVEL; level++) {
        const bins = Math.floor(to / this.binSize[level]!);
        for (const plane of this.hi[level]!) plane.reserve(bins);
        for (const plane of this.lo[level]!) plane.reserve(bins);
      }
    } catch (error) {
      rollback();
      throw error;
    }
    this.preparedTo = to;
    return rollback;
  }

  appendChannels(channels: readonly ArrayLike<number>[]): void {
    if (channels.length !== this.channelCount || channels.some((channel) => channel.length !== channels[0]!.length))
      throw new Error('Logic layout mismatch');
    const count = channels[0]!.length,
      from = this.length,
      to = from + count;
    this.prepareAppend(count);
    const packed = new Map<ArrayLike<number>, BitPlane>();
    for (let channel = 0; channel < this.channelCount; channel++) {
      const values = channels[channel]!,
        plane = this.base[channel]!;
      const previous = packed.get(values);
      if (previous) {
        this.copyPlaneRange(previous, plane, from, to);
        plane.bits = to;
        continue;
      }
      let index = 0;
      for (; index < count && (from + index) & 31; index++) plane.setBit(from + index, values[index]!);
      for (; index + 32 <= count; index += 32) {
        let word = 0;
        for (let bit = 0; bit < 32; bit++) word |= values[index + bit]! << bit;
        const sample = from + index;
        plane.blocks[sample >>> BASE_BLOCK_BITS_LOG]![(sample & (2 ** BASE_BLOCK_BITS_LOG - 1)) >>> 5] = word;
      }
      for (; index < count; index++) plane.setBit(from + index, values[index]!);
      plane.bits = to;
      packed.set(values, plane);
    }
    this.length = to;
    this.validBins[0] = to;
    if (!this.deferPyramid) this.updatePyramid(from, to);
  }

  private copyPlaneRange(source: BitPlane, target: BitPlane, from: number, to: number): void {
    let sample = from;
    for (; sample < to && sample & 31; sample++) target.setBit(sample, source.getBit(sample));
    const bodyEnd = to - (to % 32);
    while (sample < bodyEnd) {
      const block = sample >>> BASE_BLOCK_BITS_LOG,
        offset = (sample & (2 ** BASE_BLOCK_BITS_LOG - 1)) >>> 5;
      const words = Math.min((bodyEnd - sample) >>> 5, 2 ** (BASE_BLOCK_BITS_LOG - 5) - offset);
      target.blocks[block]!.set(source.blocks[block]!.subarray(offset, offset + words), offset);
      sample += words * 32;
    }
    for (; sample < to; sample++) target.setBit(sample, source.getBit(sample));
  }

  dispose(): void {
    for (const plane of [...this.base, ...this.hi.slice(1).flat(), ...this.lo.slice(1).flat()]) plane.trimBlocks(0);
    this.length = 0;
    this.preparedTo = 0;
    this.validBins.fill(0);
  }

  append(chunk: Uint8Array): void {
    const bps = this.bytesPerSample;
    if (chunk.byteLength % bps !== 0) {
      throw new Error(`chunk of ${chunk.byteLength} bytes is not a whole number of ${bps}-byte samples`);
    }
    const n = chunk.byteLength / bps;
    if (n === 0) return;
    const from = this.length;
    const to = from + n;
    if (to > SEGMENT_SAMPLES) throw new Error(`append exceeds local segment capacity (${to})`);

    this.prepareAppend(n);
    for (let c = 0; c < this.channelCount; c++) this.base[c]!.extendTo(to);
    if (bps === 1) this.writeBase8(chunk, n, from);
    else if (bps === 2) this.writeBase16(chunk, n, from);
    else if (bps === 4) this.writeBase32(chunk, n, from);
    else this.writeBaseWide(chunk, n, from);

    this.length = to;
    this.validBins[0] = to;
    if (!this.deferPyramid) this.updatePyramid(from, to);
  }

  appendTransposed32(planes: readonly Uint32Array[]): void {
    if (this.channelCount !== 32) throw new Error('appendTransposed32 requires 32 channels');
    if ((this.length & 31) !== 0) throw new Error('appendTransposed32 requires a word-aligned capture');
    if (planes.length !== 32) throw new Error('appendTransposed32 requires 32 channel planes');
    const words = planes[0]!.length;
    for (const plane of planes) {
      if (!(plane instanceof Uint32Array) || plane.length !== words) {
        throw new Error('appendTransposed32 requires equally sized Uint32Array planes');
      }
    }
    if (words === 0) return;
    const from = this.length,
      to = from + words * 32;
    if (to > SEGMENT_SAMPLES) throw new Error(`append exceeds local segment capacity (${to})`);
    this.prepareAppend(words * 32);
    for (const plane of this.base) plane.extendTo(to);
    for (let done = 0; done < words;) {
      const sample = from + done * 32;
      const block = sample >>> BASE_BLOCK_BITS_LOG;
      const offset = (sample & ((1 << BASE_BLOCK_BITS_LOG) - 1)) >>> 5;
      const count = Math.min(words - done, (1 << (BASE_BLOCK_BITS_LOG - 5)) - offset);
      for (let ch = 0; ch < 32; ch++) {
        this.base[ch]!.blocks[block]!.set(planes[ch]!.subarray(done, done + count), offset);
      }
      done += count;
    }
    this.length = to;
    this.validBins[0] = to;
    if (!this.deferPyramid) this.updatePyramid(from, to);
  }

  refreshPyramid(): void {
    if (this.deferPyramid) this.updatePyramid(0, this.length);
  }

  finalizePyramid(): void {
    if (!this.deferPyramid) return;
    this.refreshPyramid();
    this.deferPyramid = false;
  }

  noteGap(startSample: number, endSample: number): void {
    assertGapBounds(startSample, endSample, this.length);
    this.gapList = mergeGap(this.gapList, startSample, endSample);
  }

  gaps(): GapSpan[] {
    return this.gapList.map((g) => ({ ...g }));
  }

  private writeBase16(chunk: Uint8Array, n: number, dstBit: number): void {
    let src: Uint16Array;
    if ((chunk.byteOffset & 1) === 0) {
      src = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    } else {
      src = new Uint16Array(n);
      new Uint8Array(src.buffer).set(chunk);
    }

    let si = 0;
    const head = Math.min(n, (32 - (dstBit & 31)) & 31);
    for (; si < head; si++) this.writeSample16(src[si]!, dstBit + si);

    const bodyEnd = si + (((n - si) >>> 5) << 5);
    if (bodyEnd > si) this.writeBody16(src, si, bodyEnd, dstBit + si);
    si = bodyEnd;

    for (; si < n; si++) this.writeSample16(src[si]!, dstBit + si);
  }

  private writeBody16(src: Uint16Array, si: number, siEnd: number, dstBit: number): void {
    const imul = Math.imul;
    const M = 0x01010101;
    const G = 0x10204080;
    const planes = this.base;
    const bbl = BASE_BLOCK_BITS_LOG;
    const blockMask = (1 << bbl) - 1;

    while (si < siEnd) {
      const blk = dstBit >>> bbl;
      const wordInBlock = (dstBit & blockMask) >>> 5;
      const wordsLeftInBlock = (1 << (bbl - 5)) - wordInBlock;
      const wordsWanted = (siEnd - si) >>> 5;
      const words = Math.min(wordsLeftInBlock, wordsWanted);

      const b0 = planes[0]!.blocks[blk]!,
        b1 = planes[1]!.blocks[blk]!;
      const b2 = planes[2]!.blocks[blk]!,
        b3 = planes[3]!.blocks[blk]!;
      const b4 = planes[4]!.blocks[blk]!,
        b5 = planes[5]!.blocks[blk]!;
      const b6 = planes[6]!.blocks[blk]!,
        b7 = planes[7]!.blocks[blk]!;
      const b8 = planes[8]!.blocks[blk]!,
        b9 = planes[9]!.blocks[blk]!;
      const ba = planes[10]!.blocks[blk]!,
        bb = planes[11]!.blocks[blk]!;
      const bc = planes[12]!.blocks[blk]!,
        bd = planes[13]!.blocks[blk]!;
      const be = planes[14]!.blocks[blk]!,
        bf = planes[15]!.blocks[blk]!;

      for (let w = 0; w < words; w++) {
        let a0 = 0,
          a1 = 0,
          a2 = 0,
          a3 = 0,
          a4 = 0,
          a5 = 0,
          a6 = 0,
          a7 = 0;
        let a8 = 0,
          a9 = 0,
          aa = 0,
          ab = 0,
          ac = 0,
          ad = 0,
          ae = 0,
          af = 0;
        const base = si + (w << 5);
        for (let g = 0; g < 8; g++) {
          const j = base + (g << 2);
          const s0 = src[j]!,
            s1 = src[j + 1]!,
            s2 = src[j + 2]!,
            s3 = src[j + 3]!;
          const L = (s0 & 0xff) | ((s1 & 0xff) << 8) | ((s2 & 0xff) << 16) | ((s3 & 0xff) << 24);
          const H = (s0 >>> 8) | ((s1 >>> 8) << 8) | ((s2 >>> 8) << 16) | ((s3 >>> 8) << 24);
          const sh = g << 2;
          a0 |= (imul(L & M, G) >>> 28) << sh;
          a1 |= (imul((L >>> 1) & M, G) >>> 28) << sh;
          a2 |= (imul((L >>> 2) & M, G) >>> 28) << sh;
          a3 |= (imul((L >>> 3) & M, G) >>> 28) << sh;
          a4 |= (imul((L >>> 4) & M, G) >>> 28) << sh;
          a5 |= (imul((L >>> 5) & M, G) >>> 28) << sh;
          a6 |= (imul((L >>> 6) & M, G) >>> 28) << sh;
          a7 |= (imul((L >>> 7) & M, G) >>> 28) << sh;
          a8 |= (imul(H & M, G) >>> 28) << sh;
          a9 |= (imul((H >>> 1) & M, G) >>> 28) << sh;
          aa |= (imul((H >>> 2) & M, G) >>> 28) << sh;
          ab |= (imul((H >>> 3) & M, G) >>> 28) << sh;
          ac |= (imul((H >>> 4) & M, G) >>> 28) << sh;
          ad |= (imul((H >>> 5) & M, G) >>> 28) << sh;
          ae |= (imul((H >>> 6) & M, G) >>> 28) << sh;
          af |= (imul((H >>> 7) & M, G) >>> 28) << sh;
        }
        const o = wordInBlock + w;
        b0[o] = a0;
        b1[o] = a1;
        b2[o] = a2;
        b3[o] = a3;
        b4[o] = a4;
        b5[o] = a5;
        b6[o] = a6;
        b7[o] = a7;
        b8[o] = a8;
        b9[o] = a9;
        ba[o] = aa;
        bb[o] = ab;
        bc[o] = ac;
        bd[o] = ad;
        be[o] = ae;
        bf[o] = af;
      }
      si += words << 5;
      dstBit += words << 5;
    }
  }

  private writeBase8(chunk: Uint8Array, n: number, dstBit: number): void {
    const nch = this.channelCount;
    const bbl = BASE_BLOCK_BITS_LOG;
    const blockMask = (1 << bbl) - 1;

    let si = 0;
    const head = Math.min(n, (32 - (dstBit & 31)) & 31);
    for (; si < head; si++) this.writeSampleN(chunk[si]!, dstBit + si);
    dstBit += head;

    const bodyEnd = si + (((n - si) >>> 5) << 5);
    while (si < bodyEnd) {
      let i = si;
      let a7 =
        BYTE_TO_NIBBLES[chunk[i]!] |
        (BYTE_TO_NIBBLES[chunk[i + 1]!] << 1) |
        (BYTE_TO_NIBBLES[chunk[i + 2]!] << 2) |
        (BYTE_TO_NIBBLES[chunk[i + 3]!] << 3);
      i += 4;
      let a6 =
        BYTE_TO_NIBBLES[chunk[i]!] |
        (BYTE_TO_NIBBLES[chunk[i + 1]!] << 1) |
        (BYTE_TO_NIBBLES[chunk[i + 2]!] << 2) |
        (BYTE_TO_NIBBLES[chunk[i + 3]!] << 3);
      i += 4;
      let a5 =
        BYTE_TO_NIBBLES[chunk[i]!] |
        (BYTE_TO_NIBBLES[chunk[i + 1]!] << 1) |
        (BYTE_TO_NIBBLES[chunk[i + 2]!] << 2) |
        (BYTE_TO_NIBBLES[chunk[i + 3]!] << 3);
      i += 4;
      let a4 =
        BYTE_TO_NIBBLES[chunk[i]!] |
        (BYTE_TO_NIBBLES[chunk[i + 1]!] << 1) |
        (BYTE_TO_NIBBLES[chunk[i + 2]!] << 2) |
        (BYTE_TO_NIBBLES[chunk[i + 3]!] << 3);
      i += 4;
      let a3 =
        BYTE_TO_NIBBLES[chunk[i]!] |
        (BYTE_TO_NIBBLES[chunk[i + 1]!] << 1) |
        (BYTE_TO_NIBBLES[chunk[i + 2]!] << 2) |
        (BYTE_TO_NIBBLES[chunk[i + 3]!] << 3);
      i += 4;
      let a2 =
        BYTE_TO_NIBBLES[chunk[i]!] |
        (BYTE_TO_NIBBLES[chunk[i + 1]!] << 1) |
        (BYTE_TO_NIBBLES[chunk[i + 2]!] << 2) |
        (BYTE_TO_NIBBLES[chunk[i + 3]!] << 3);
      i += 4;
      let a1 =
        BYTE_TO_NIBBLES[chunk[i]!] |
        (BYTE_TO_NIBBLES[chunk[i + 1]!] << 1) |
        (BYTE_TO_NIBBLES[chunk[i + 2]!] << 2) |
        (BYTE_TO_NIBBLES[chunk[i + 3]!] << 3);
      i += 4;
      let a0 =
        BYTE_TO_NIBBLES[chunk[i]!] |
        (BYTE_TO_NIBBLES[chunk[i + 1]!] << 1) |
        (BYTE_TO_NIBBLES[chunk[i + 2]!] << 2) |
        (BYTE_TO_NIBBLES[chunk[i + 3]!] << 3);
      let t;
      t = (a0 ^ (a4 >>> 16)) & 0x0000ffff;
      a0 ^= t;
      a4 ^= t << 16;
      t = (a1 ^ (a5 >>> 16)) & 0x0000ffff;
      a1 ^= t;
      a5 ^= t << 16;
      t = (a2 ^ (a6 >>> 16)) & 0x0000ffff;
      a2 ^= t;
      a6 ^= t << 16;
      t = (a3 ^ (a7 >>> 16)) & 0x0000ffff;
      a3 ^= t;
      a7 ^= t << 16;
      t = (a0 ^ (a2 >>> 8)) & 0x00ff00ff;
      a0 ^= t;
      a2 ^= t << 8;
      t = (a1 ^ (a3 >>> 8)) & 0x00ff00ff;
      a1 ^= t;
      a3 ^= t << 8;
      t = (a4 ^ (a6 >>> 8)) & 0x00ff00ff;
      a4 ^= t;
      a6 ^= t << 8;
      t = (a5 ^ (a7 >>> 8)) & 0x00ff00ff;
      a5 ^= t;
      a7 ^= t << 8;
      t = (a0 ^ (a1 >>> 4)) & 0x0f0f0f0f;
      a0 ^= t;
      a1 ^= t << 4;
      t = (a2 ^ (a3 >>> 4)) & 0x0f0f0f0f;
      a2 ^= t;
      a3 ^= t << 4;
      t = (a4 ^ (a5 >>> 4)) & 0x0f0f0f0f;
      a4 ^= t;
      a5 ^= t << 4;
      t = (a6 ^ (a7 >>> 4)) & 0x0f0f0f0f;
      a6 ^= t;
      a7 ^= t << 4;
      const blk = dstBit >>> bbl;
      const off = (dstBit & blockMask) >>> 5;
      if (nch >= 1) this.base[0]!.blocks[blk]![off] = a7;
      if (nch >= 2) this.base[1]!.blocks[blk]![off] = a6;
      if (nch >= 3) this.base[2]!.blocks[blk]![off] = a5;
      if (nch >= 4) this.base[3]!.blocks[blk]![off] = a4;
      if (nch >= 5) this.base[4]!.blocks[blk]![off] = a3;
      if (nch >= 6) this.base[5]!.blocks[blk]![off] = a2;
      if (nch >= 7) this.base[6]!.blocks[blk]![off] = a1;
      if (nch >= 8) this.base[7]!.blocks[blk]![off] = a0;
      si += 32;
      dstBit += 32;
    }
    for (; si < n; si++) this.writeSampleN(chunk[si]!, dstBit + (si - bodyEnd));
  }

  private writeSample16(v: number, bit: number): void {
    const planes = this.base;
    for (let c = 0; c < 16; c++) planes[c]!.setBit(bit, (v >>> c) & 1);
  }

  private writeSampleN(v: number, bit: number): void {
    const planes = this.base;
    for (let c = 0; c < this.channelCount; c++) planes[c]!.setBit(bit, (v >>> c) & 1);
  }

  private writeBase32(chunk: Uint8Array, n: number, dstBit: number): void {
    let src: Uint32Array;
    if ((chunk.byteOffset & 3) === 0) src = new Uint32Array(chunk.buffer, chunk.byteOffset, n);
    else {
      src = new Uint32Array(n);
      new Uint8Array(src.buffer).set(chunk);
    }
    let si = 0;
    const head = Math.min(n, (32 - (dstBit & 31)) & 31);
    for (; si < head; si++) this.writeSampleN(src[si]!, dstBit + si);
    const bodyEnd = si + (((n - si) >>> 5) << 5);
    if (bodyEnd > si) this.writeBody32(src, si, bodyEnd, dstBit + si);
    si = bodyEnd;
    for (; si < n; si++) this.writeSampleN(src[si]!, dstBit + si);
  }

  private writeBody32(src: Uint32Array, si: number, siEnd: number, dstBit: number): void {
    const blockMask = (1 << BASE_BLOCK_BITS_LOG) - 1;
    while (si < siEnd) {
      const blk = dstBit >>> BASE_BLOCK_BITS_LOG;
      const wordInBlock = (dstBit & blockMask) >>> 5;
      const words = Math.min((1 << (BASE_BLOCK_BITS_LOG - 5)) - wordInBlock, (siEnd - si) >>> 5);
      this.transpose32.transpose(
        src,
        si,
        words,
        this.base.map((plane) => plane.blocks[blk]!),
        wordInBlock,
      );
      si += words << 5;
      dstBit += words << 5;
    }
  }

  private writeBaseWide(chunk: Uint8Array, n: number, dstBit: number): void {
    const bps = this.bytesPerSample;
    for (let i = 0; i < n; i++) {
      const o = i * bps;
      const bit = dstBit + i;
      for (let c = 0; c < this.channelCount; c++) {
        this.base[c]!.setBit(bit, (chunk[o + (c >>> 3)]! >>> (c & 7)) & 1);
      }
    }
  }

  private updatePyramid(from: number, to: number): void {
    for (let k = 1; k <= MAX_LEVEL; k++) {
      const B = this.binSize[k]!;
      const b0 = this.validBins[k]!;
      const b1 = Math.floor(to / B);
      if (b1 <= b0) break;
      for (let c = 0; c < this.channelCount; c++) this.reduceRange(k, c, b0, b1);
      this.validBins[k] = b1;
    }
    void from;
  }

  private reduceRange(level: number, ch: number, b0: number, b1: number): void {
    const dstHi = this.hi[level]![ch]!;
    const dstLo = this.lo[level]![ch]!;
    dstHi.extendTo(b1);
    dstLo.extendTo(b1);
    const fromBase = level === 1;
    const srcHi = fromBase ? this.base[ch]! : this.hi[level - 1]![ch]!;
    const srcLo = fromBase ? this.base[ch]! : this.lo[level - 1]![ch]!;

    let i = b0;
    const headEnd = Math.min(b1, (b0 + 31) & ~31);
    for (; i < headEnd; i++) this.reduceOne(dstHi, dstLo, srcHi, srcLo, i, fromBase);
    const tailStart = Math.max(headEnd, b1 & ~31);
    for (; i < tailStart; i += 32) {
      if (fromBase) this.reduceGroupFromBase(dstHi, dstLo, srcHi, i);
      else this.reduceGroup(dstHi, dstLo, srcHi, srcLo, i);
    }
    for (; i < b1; i++) this.reduceOne(dstHi, dstLo, srcHi, srcLo, i, fromBase);
  }

  private reduceOne(
    dstHi: BitPlane,
    dstLo: BitPlane,
    srcHi: BitPlane,
    srcLo: BitPlane,
    i: number,
    fromBase: boolean,
  ): void {
    const sBit = i * 16;
    const bh = srcHi.blocks[sBit >>> srcHi.blockBitsLog]!;
    const oh = (sBit & srcHi.blockMask) >>> 5;
    const sh = bh[oh]! | 0;
    const hv = (sBit & 16) !== 0 ? sh >>> 16 : sh & 0xffff;
    dstHi.setBit(i, hv !== 0 ? 1 : 0);
    if (fromBase) {
      dstLo.setBit(i, hv !== 0xffff ? 1 : 0);
    } else {
      const bl = srcLo.blocks[sBit >>> srcLo.blockBitsLog]!;
      const ol = (sBit & srcLo.blockMask) >>> 5;
      const sl = bl[ol]! | 0;
      const lv = (sBit & 16) !== 0 ? sl >>> 16 : sl & 0xffff;
      dstLo.setBit(i, lv !== 0 ? 1 : 0);
    }
  }

  private reduceGroupFromBase(dstHi: BitPlane, dstLo: BitPlane, src: BitPlane, i: number): void {
    const sBit = i * 16;
    const sArr = src.blocks[sBit >>> src.blockBitsLog]!;
    const sOff = (sBit & src.blockMask) >>> 5;
    let h = 0,
      l = 0;
    for (let j = 0; j < 16; j++) {
      const s = sArr[sOff + j]! | 0;
      const loHalf = s & 0xffff;
      const hiHalf = s >>> 16;
      const b = j << 1;
      if (loHalf !== 0) h |= 1 << b;
      if (hiHalf !== 0) h |= 2 << b;
      if (loHalf !== 0xffff) l |= 1 << b;
      if (hiHalf !== 0xffff) l |= 2 << b;
    }
    dstHi.blocks[i >>> dstHi.blockBitsLog]![(i & dstHi.blockMask) >>> 5] = h;
    dstLo.blocks[i >>> dstLo.blockBitsLog]![(i & dstLo.blockMask) >>> 5] = l;
  }

  private reduceGroup(dstHi: BitPlane, dstLo: BitPlane, srcHi: BitPlane, srcLo: BitPlane, i: number): void {
    const sBit = i * 16;
    const ah = srcHi.blocks[sBit >>> srcHi.blockBitsLog]!;
    const al = srcLo.blocks[sBit >>> srcLo.blockBitsLog]!;
    const oh = (sBit & srcHi.blockMask) >>> 5;
    const ol = (sBit & srcLo.blockMask) >>> 5;
    let h = 0,
      l = 0;
    for (let j = 0; j < 16; j++) {
      const sh = ah[oh + j]! | 0;
      const sl = al[ol + j]! | 0;
      const b = j << 1;
      if ((sh & 0xffff) !== 0) h |= 1 << b;
      if (sh >>> 16 !== 0) h |= 2 << b;
      if ((sl & 0xffff) !== 0) l |= 1 << b;
      if (sl >>> 16 !== 0) l |= 2 << b;
    }
    dstHi.blocks[i >>> dstHi.blockBitsLog]![(i & dstHi.blockMask) >>> 5] = h;
    dstLo.blocks[i >>> dstLo.blockBitsLog]![(i & dstLo.blockMask) >>> 5] = l;
  }

  private rangeState(ch: number, s0: number, s1: number, level: number): number {
    while (level > 0) {
      const B = this.binSize[level]!;
      let a = Math.ceil(s0 / B);
      let b = Math.floor(s1 / B);
      const vb = this.validBins[level]!;
      if (b > vb) b = vb;
      if (a >= b) {
        level--;
        continue;
      }

      const coreStart = a * B;
      const coreEnd = b * B;
      let st = 0;
      if (this.hi[level]![ch]!.anyOne(a, b)) st |= HAS_ONE;
      if (this.lo[level]![ch]!.anyOne(a, b)) st |= HAS_ZERO;
      if (st !== HAS_BOTH && s0 < coreStart) st |= this.rangeState(ch, s0, coreStart, level - 1);
      if (st !== HAS_BOTH && coreEnd < s1) st |= this.rangeState(ch, coreEnd, s1, level - 1);
      return st;
    }
    return this.base[ch]!.rangeState(s0, s1);
  }

  private pickLevel(samplesPerBin: number): number {
    const want = this.coreBins;
    let k = 0;
    while (k < MAX_LEVEL && this.binSize[k + 1]! * want <= samplesPerBin) k++;
    return k;
  }

  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) {
      throw new Error(`channel ${channel} out of range 0..${this.channelCount - 1}`);
    }
    if (!(bins > 0) || (bins | 0) !== bins) throw new Error(`bins must be a positive integer, got ${bins}`);
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`query range must be finite, got [${startSample}, ${endSample})`);
    }
    if (this.length === 0) throw new Error('query on an empty store');
    const s = Math.max(0, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) throw new Error(`empty range [${startSample}, ${endSample}) against length ${this.length}`);

    const width = e - s;
    const level = this.pickLevel(width / bins);
    const base = this.base[channel]!;

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

    const B = this.binSize[level]!;
    const snap = this.snapColumns && level > 0;
    const gaps = this.gapList;
    let gp = 0;
    for (let i = 0; i < bins; i++) {
      let c0 = s + Math.floor((i * width) / bins);
      let c1 = s + Math.floor(((i + 1) * width) / bins);
      if (snap) {
        if (i !== 0) c0 = Math.min(e - 1, Math.round(c0 / B) * B);
        if (i !== bins - 1) c1 = Math.min(e, Math.round(c1 / B) * B);
      }
      if (c1 <= c0) c1 = c0 + 1;
      if (c1 > e) c1 = e;

      let st = this.rangeState(channel, c0, c1, level);
      const hv = (st & HAS_ONE) !== 0 ? 1 : 0;
      const lv = (st & HAS_ZERO) !== 0 ? 0 : 1;
      if (c0 > 0) st |= base.getBit(c0 - 1) !== 0 ? HAS_ONE : HAS_ZERO;
      const ev = st === HAS_BOTH ? 1 : 0;

      high[i] = hv;
      low[i] = lv;
      edge[i] = ev;
      while (gp < gaps.length && gaps[gp]!.endSample <= c0) gp++;
      const gapHit = gp < gaps.length && gaps[gp]!.startSample < c1;
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

  edges(channel: number, startSample: number, endSample: number): Int32Array {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return new Int32Array(0);
    let n = 0;
    for (const [a, b] of segs) n += this.scanEdgesRange(channel, a, b, null, 0);
    if (n === 0) return new Int32Array(0);
    const out = new Int32Array(n);
    let w = 0;
    for (const [a, b] of segs) w += this.scanEdgesRange(channel, a, b, out, w);
    if (w !== n) throw new Error(`edge count changed between passes: ${n} then ${w}`);
    return out;
  }

  edgeCount(channel: number, startSample: number, endSample: number): number {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return 0;
    let n = 0;
    for (const [a, b] of segs) n += this.scanEdgesRange(channel, a, b, null, 0);
    return n;
  }

  private edgeSegments(channel: number, startSample: number, endSample: number): Array<[number, number]> | null {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) {
      throw new Error(`channel ${channel} out of range 0..${this.channelCount - 1}`);
    }
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`edges range must be finite, got [${startSample}, ${endSample})`);
    }
    const s = Math.max(1, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) return null;
    return splitAroundGaps(this.gapList, s, e);
  }

  private scanEdgesRange(channel: number, s: number, e: number, out: Int32Array | null, outOff: number): number {
    const plane = this.base[channel]!;
    const blockWords = plane.blockWords;
    let n = outOff;

    const wStart = s >>> 5;
    const wEnd = (e - 1) >>> 5;
    const firstMask = -1 << (s & 31);
    const lastHi = ((e - 1) & 31) + 1;
    const lastMask = lastHi === 32 ? -1 : ~(-1 << lastHi);
    let carry = wStart === 0 ? 0 : plane.getBit(wStart * 32 - 1);

    let w = wStart;
    while (w <= wEnd) {
      const blk = Math.floor((w * 32) / plane.blockBits);
      const arr = plane.blocks[blk]!;
      const wordBase = (blk * plane.blockBits) / 32;
      const stop = Math.min(wEnd, wordBase + blockWords - 1);
      for (; w <= stop; w++) {
        const v = arr[w - wordBase]! | 0;
        let x = v ^ ((v << 1) | carry);
        carry = (v >>> 31) & 1;
        if (x === 0) continue;
        if (w === wStart) x &= firstMask;
        if (w === wEnd) x &= lastMask;
        if (w === 0) x &= ~1;
        if (out === null) {
          let y = x - ((x >> 1) & 0x55555555);
          y = (y & 0x33333333) + ((y >> 2) & 0x33333333);
          y = (y + (y >> 4)) & 0x0f0f0f0f;
          n += Math.imul(y, 0x01010101) >> 24;
        } else {
          const bitBase = w * 32;
          while (x !== 0) {
            const t = x & -x;
            out[n++] = bitBase + (31 - Math.clz32(t));
            x ^= t;
          }
        }
      }
    }
    return n - outOff;
  }

  memory(): MemoryReport {
    let baseBytes = 0;
    for (const p of this.base) baseBytes += p.byteLength();
    let pyramidBytes = 0;
    for (let k = 1; k <= MAX_LEVEL; k++) {
      for (const p of this.hi[k]!) pyramidBytes += p.byteLength();
      for (const p of this.lo[k]!) pyramidBytes += p.byteLength();
    }
    const usedBase = Math.ceil(this.length / 8) * this.channelCount;
    let usedPyramid = 0;
    for (let level = 1; level <= MAX_LEVEL; level++)
      usedPyramid += Math.ceil(this.validBins[level]! / 8) * this.channelCount * 2;
    return {
      baseBytes,
      pyramidBytes,
      totalBytes:
        baseBytes +
        pyramidBytes +
        this.transposeScratchBytes +
        this.scratchLow.byteLength +
        this.scratchHigh.byteLength +
        this.scratchEdge.byteLength +
        this.scratchPacked.byteLength,
      overhead: baseBytes === 0 ? 0 : pyramidBytes / baseBytes,
      slackBytes: baseBytes - usedBase + pyramidBytes - usedPyramid,
    };
  }

  sampleAt(channel: number, index: number): number {
    if (index < 0 || index >= this.length) throw new Error(`sample ${index} out of range`);
    return this.base[channel]!.getBit(index);
  }

  packRange(startSample: number, endSample: number, channels = this.channelCount): Uint8Array {
    if (
      !Number.isInteger(startSample) ||
      !Number.isInteger(endSample) ||
      startSample < 0 ||
      endSample < startSample ||
      endSample > this.length
    ) {
      throw new RangeError('invalid packed sample range');
    }
    if (!Number.isInteger(channels) || channels < 1 || channels > this.channelCount)
      throw new RangeError('invalid packed channel count');
    const unit = Math.ceil(channels / 8),
      out = new Uint8Array((endSample - startSample) * unit);
    if (!out.length) return out;
    if (channels === 32) {
      const source = new Uint32Array(32),
        words = Array.from({ length: 32 }, () => new Uint32Array(1));
      const firstAligned = startSample + ((32 - (startSample & 31)) & 31);
      const fillSample = (sample: number): void => {
        let value = 0;
        for (let channel = 0; channel < channels; channel++) value |= this.base[channel]!.getBit(sample) << channel;
        const offset = (sample - startSample) * unit;
        out[offset] = value & 0xff;
        out[offset + 1] = (value >>> 8) & 0xff;
        out[offset + 2] = (value >>> 16) & 0xff;
        out[offset + 3] = value >>> 24;
      };
      for (let sample = startSample; sample < Math.min(firstAligned, endSample); sample++) fillSample(sample);
      let sample = firstAligned;
      for (; sample + 32 <= endSample; sample += 32) {
        const word = sample >>> 5;
        for (let channel = 0; channel < 32; channel++) {
          const plane = this.base[channel]!,
            block = plane.blocks[word >>> (BASE_BLOCK_BITS_LOG - 5)]!;
          source[channel] = block[word & ((1 << (BASE_BLOCK_BITS_LOG - 5)) - 1)]!;
        }
        this.transpose32.transpose(source, 0, 1, words, 0);
        for (let row = 0; row < 32; row++) {
          const value = words[row]![0]!,
            offset = (sample + row - startSample) * 4;
          out[offset] = value & 0xff;
          out[offset + 1] = (value >>> 8) & 0xff;
          out[offset + 2] = (value >>> 16) & 0xff;
          out[offset + 3] = value >>> 24;
        }
      }
      for (; sample < endSample; sample++) fillSample(sample);
      return out;
    }
    let packedEnd = startSample;
    if (unit === 1 && (startSample & 31) === 0) {
      const words = new Uint32Array(out.buffer, 0, Math.floor(out.length / 4)),
        spread = Uint32Array.from(
          { length: 16 },
          (_, bits) => (bits & 1) | ((bits & 2) << 7) | ((bits & 4) << 14) | ((bits & 8) << 21),
        );
      for (; packedEnd + 32 <= endSample; packedEnd += 32) {
        const word = packedEnd >>> 5,
          target = (packedEnd - startSample) >>> 2;
        for (let channel = 0; channel < channels; channel++) {
          const plane = this.base[channel]!,
            block = plane.blocks[word >>> (BASE_BLOCK_BITS_LOG - 5)]!,
            bits = block[word & ((1 << (BASE_BLOCK_BITS_LOG - 5)) - 1)]!;
          for (let group = 0; group < 8; group++)
            words[target + group] |= spread[(bits >>> (group * 4)) & 15]! << channel;
        }
      }
    }
    for (let sample = packedEnd; sample < endSample; sample++) {
      const valueOffset = (sample - startSample) * unit;
      for (let channel = 0; channel < channels; channel++)
        if (this.base[channel]!.getBit(sample)) out[valueOffset + (channel >>> 3)] |= 1 << (channel & 7);
    }
    return out;
  }
}
