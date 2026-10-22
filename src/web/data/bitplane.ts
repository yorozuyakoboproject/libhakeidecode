import type { MemoryBudget } from '../memory.js';

export const HAS_ONE = 1;
export const HAS_ZERO = 2;
export const HAS_BOTH = 3;

function maskFrom(lo: number): number {
  return -1 << lo;
}

function maskTo(hi: number): number {
  return hi === 32 ? -1 : ~(-1 << hi);
}

export class BitPlane {
  readonly blockBitsLog: number;
  readonly blockBits: number;
  readonly blockMask: number;
  readonly blockWords: number;
  readonly blocks: Uint32Array[] = [];

  bits = 0;

  constructor(
    blockBitsLog: number,
    private readonly budget?: MemoryBudget,
  ) {
    if (blockBitsLog < 5 || blockBitsLog > 30) throw new Error(`bad blockBitsLog ${blockBitsLog}`);
    this.blockBitsLog = blockBitsLog;
    this.blockBits = 1 << blockBitsLog;
    this.blockMask = this.blockBits - 1;
    this.blockWords = this.blockBits >>> 5;
  }

  reserve(n: number): void {
    const need = Math.ceil(n / this.blockBits);
    while (this.blocks.length < need)
      this.blocks.push(
        this.budget
          ? new Uint32Array(this.budget.allocate(this.blockWords * 4, 'digital block'))
          : new Uint32Array(this.blockWords),
      );
  }

  trimBlocks(count: number): void {
    while (this.blocks.length > count) {
      const block = this.blocks.pop()!;
      this.budget?.release(block.buffer);
    }
  }

  extendTo(n: number): void {
    this.reserve(n);
    if (n > this.bits) this.bits = n;
  }

  getBit(i: number): number {
    const b = this.blocks[i >>> this.blockBitsLog];
    if (b === undefined) throw new Error(`bit ${i} out of range (bits=${this.bits})`);
    return (b[(i & this.blockMask) >>> 5]! >>> (i & 31)) & 1;
  }

  setBit(i: number, v: number): void {
    const b = this.blocks[i >>> this.blockBitsLog];
    if (b === undefined) throw new Error(`bit ${i} out of range (bits=${this.bits})`);
    const w = (i & this.blockMask) >>> 5;
    const m = 1 << (i & 31);
    if (v) b[w] |= m;
    else b[w] &= ~m;
  }

  rangeState(a: number, b: number): number {
    if (a >= b) return 0;
    let state = 0;
    const bbl = this.blockBitsLog;
    const bb = this.blockBits;
    let blk = a >>> bbl;
    while (a < b) {
      const arr = this.blocks[blk];
      if (arr === undefined) throw new Error(`rangeState [${a},${b}) past end (bits=${this.bits})`);
      const blockEnd = (blk + 1) * bb;
      const e = b < blockEnd ? b : blockEnd;
      state |= this.rangeStateInBlock(arr, a - blk * bb, e - blk * bb);
      if (state === HAS_BOTH) return HAS_BOTH;
      a = e;
      blk++;
    }
    return state;
  }

  private rangeStateInBlock(arr: Uint32Array, a: number, b: number): number {
    const wa = a >>> 5;
    const wb = (b - 1) >>> 5;
    const loBit = a & 31;
    const hiBit = ((b - 1) & 31) + 1;
    if (wa === wb) {
      const m = maskFrom(loBit) & maskTo(hiBit);
      const v = arr[wa]! & m;
      return (v !== 0 ? HAS_ONE : 0) | (v !== m ? HAS_ZERO : 0);
    }
    let state = 0;
    {
      const m = maskFrom(loBit);
      const v = arr[wa]! & m;
      if (v !== 0) state |= HAS_ONE;
      if (v !== m) state |= HAS_ZERO;
    }
    for (let w = wa + 1; w < wb; w++) {
      if (state === HAS_BOTH) return HAS_BOTH;
      const v = arr[w]! | 0;
      if (v !== 0) state |= HAS_ONE;
      if (v !== -1) state |= HAS_ZERO;
    }
    if (state !== HAS_BOTH) {
      const m = maskTo(hiBit);
      const v = arr[wb]! & m;
      if (v !== 0) state |= HAS_ONE;
      if (v !== m) state |= HAS_ZERO;
    }
    return state;
  }

  anyOne(a: number, b: number): boolean {
    if (a >= b) return false;
    const bbl = this.blockBitsLog;
    const bb = this.blockBits;
    let blk = a >>> bbl;
    while (a < b) {
      const arr = this.blocks[blk];
      if (arr === undefined) throw new Error(`anyOne [${a},${b}) past end (bits=${this.bits})`);
      const blockEnd = (blk + 1) * bb;
      const e = b < blockEnd ? b : blockEnd;
      const ra = a - blk * bb;
      const re = e - blk * bb;
      const wa = ra >>> 5;
      const wb = (re - 1) >>> 5;
      const loBit = ra & 31;
      const hiBit = ((re - 1) & 31) + 1;
      if (wa === wb) {
        if ((arr[wa]! & maskFrom(loBit) & maskTo(hiBit)) !== 0) return true;
      } else {
        if ((arr[wa]! & maskFrom(loBit)) !== 0) return true;
        for (let w = wa + 1; w < wb; w++) if (arr[w] !== 0) return true;
        if ((arr[wb]! & maskTo(hiBit)) !== 0) return true;
      }
      a = e;
      blk++;
    }
    return false;
  }

  byteLength(): number {
    return this.blocks.length * this.blockWords * 4;
  }
}
