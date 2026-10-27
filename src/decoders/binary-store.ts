const PAGE_BYTES = 65_536;
type BinaryPages = { pages: Uint8Array[]; length: number };

export class BinaryStore {
  private readonly outputs = new Map<string, BinaryPages>();
  private bytes = 0;

  get reservedBytes(): number {
    return this.bytes;
  }

  append(key: string, input: Uint8Array): void {
    let output = this.outputs.get(key);
    if (!output) {
      output = { pages: [], length: 0 };
      this.outputs.set(key, output);
    }
    for (let offset = 0; offset < input.length;) {
      const used = output.length % PAGE_BYTES;
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
      for (const page of output.pages) {
        const count = Math.min(page.length, data.length - offset);
        data.set(page.subarray(0, count), offset);
        offset += count;
      }
      Object.defineProperty(binaries, key, { value: data, enumerable: true, configurable: true, writable: true });
    }
    this.outputs.clear();
    this.bytes = 0;
    return binaries;
  }
}
