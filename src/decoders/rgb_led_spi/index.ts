import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

function packetBytes(data: unknown): number[] | null {
  if (!Array.isArray(data)) return null;
  let value: unknown;
  if (data[0] === 'WORD' || data[0] === 'DATA') value = data[1];
  else return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  const width = Math.max(1, Math.ceil(Math.log2(value + 1) / 8));
  return Array.from({ length: width }, (_, index) => Math.floor(value / 256 ** (width - index - 1)) & 0xff);
}

export class RgbLedSpiDecoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;
  private outAnn = -1;
  private commandStart: bigint | null = null;
  private mosiBytes: number[] = [];

  constructor(options: Record<string, never> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.commandStart = null;
    this.mosiBytes = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const bytes = packetBytes(data);
    if (!bytes) return;
    for (const value of bytes) {
      if (!this.mosiBytes.length) this.commandStart = ss;
      this.mosiBytes.push(value);
      if (this.mosiBytes.length < 3) continue;
      const [red, green, blue] = this.mosiBytes as [number, number, number];
      const rgb = (red << 16) | (green << 8) | blue;
      this.put(this.commandStart ?? ss, es, this.outAnn, [0, [`#${rgb.toString(16).toLowerCase().padStart(6, '0')}`]]);
      this.mosiBytes = [];
      this.commandStart = null;
    }
  }
}

export default RgbLedSpiDecoder;
