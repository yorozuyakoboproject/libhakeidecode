const PAGE_BYTES = 65_536;
type TimePage = { ends: BigUint64Array; bytes: Uint32Array };
type BinaryPages = {
  pages: Uint8Array[];
  length: number;
  head: number;
  times: TimePage[];
  timeHead: number;
  timeCount: number;
};

export class BinaryStore {
  private readonly outputs = new Map<string, BinaryPages>();
  private bytes = 0;

  get reservedBytes(): number {
    return this.bytes;
  }

  append(key: string, input: Uint8Array, endSample?: bigint): void {
    let output = this.outputs.get(key);
    if (!output) {
      output = { pages: [], length: 0, head: 0, times: [], timeHead: 0, timeCount: 0 };
      this.outputs.set(key, output);
    }
    if (endSample !== undefined && input.length) {
      const slot = output.timeCount % 4096;
      if (!slot) {
        output.times.push({ ends: new BigUint64Array(4096), bytes: new Uint32Array(4096) });
        this.bytes += 4096 * 12;
      }
      const page = output.times.at(-1)!;
      page.ends[slot] = endSample;
      page.bytes[slot] = input.length;
      output.timeCount++;
    }
    for (let offset = 0; offset < input.length;) {
      const used = (output.head + output.length) % PAGE_BYTES;
      if (!used) {
        output.pages.push(new Uint8Array(PAGE_BYTES));
        this.bytes += PAGE_BYTES;
      }
      const count = Math.min(PAGE_BYTES - used, input.length - offset);
      output.pages.at(-1)!.set(input.subarray(offset, offset + count), used);
      output.length += count;
      offset += count;
    }
  }

  finish(): Record<string, Uint8Array> {
    const binaries: Record<string, Uint8Array> = {};
    for (const [key, output] of this.outputs) {
      const data = new Uint8Array(output.length);
      let offset = 0;
      for (const [index, page] of output.pages.entries()) {
        const start = index === 0 ? output.head : 0;
        const count = Math.min(page.length - start, data.length - offset);
        data.set(page.subarray(start, start + count), offset);
        offset += count;
      }
      Object.defineProperty(binaries, key, { value: data, enumerable: true, configurable: true, writable: true });
    }
    this.outputs.clear();
    this.bytes = 0;
    return binaries;
  }
  discardPrefix(key: string, count: number): void {
    const output = this.outputs.get(key);
    if (!output || count < 0 || count > output.length) throw new RangeError('Invalid binary retention count');
    output.head += count;
    output.length -= count;
    while (output.head >= PAGE_BYTES) {
      output.pages.shift();
      output.head -= PAGE_BYTES;
      this.bytes -= PAGE_BYTES;
    }
    if (!output.length) {
      this.bytes -= output.pages.length * PAGE_BYTES;
      output.pages.length = 0;
      output.head = 0;
    }
  }
  discardBefore(startSample: bigint): void {
    for (const [key, output] of this.outputs) {
      let bytes = 0;
      while (output.timeHead < output.timeCount) {
        const page = output.times[Math.floor(output.timeHead / 4096)]!,
          slot = output.timeHead % 4096;
        if (page.ends[slot]! > startSample) break;
        bytes += page.bytes[slot]!;
        output.timeHead++;
      }
      if (bytes) this.discardPrefix(key, bytes);
      while (output.timeHead >= 4096) {
        output.times.shift();
        output.timeHead -= 4096;
        output.timeCount -= 4096;
        this.bytes -= 4096 * 12;
      }
      if (output.timeHead === output.timeCount) {
        this.bytes -= output.times.length * 4096 * 12;
        output.times.length = 0;
        output.timeHead = output.timeCount = 0;
      }
    }
  }
}
