const MAX_OFFSET = (1n << 64n) - 1n;

export class SampleColumn {
  private readonly low: Uint32Array;
  private high: Uint32Array | null = null;
  private readonly wide = new Map<number, bigint>();
  private wideBytes = 0;

  constructor(
    private readonly base: bigint,
    private readonly capacity: number,
  ) {
    this.low = new Uint32Array(capacity);
  }

  get reservedBytes(): number {
    return this.low.byteLength + (this.high?.byteLength ?? 0) + this.wideBytes;
  }

  set(index: number, value: bigint): void {
    const relative = value - this.base;
    if (relative < 0n || relative > MAX_OFFSET) {
      this.wide.set(index, value);
      this.wideBytes += 4 + Math.ceil(value.toString(16).length / 2);
      return;
    }
    this.low[index] = Number(relative & 0xffff_ffffn);
    if (relative > 0xffff_ffffn) {
      this.high ??= new Uint32Array(this.capacity);
      this.high[index] = Number(relative >> 32n);
    }
  }

  get(index: number): bigint {
    const wide = this.wide.get(index);
    if (wide !== undefined) return wide;
    const high = this.high?.[index] ?? 0;
    return this.base + (high ? (BigInt(high) << 32n) | BigInt(this.low[index]!) : BigInt(this.low[index]!));
  }
}
