import { Decoder } from '../../libhakeidecode/index.js';
import { OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { clamp } from '../common.js';
import { descriptor } from './descriptor.js';

interface TdmOptions {
  bps: number;
  channels: number;
  edge: 'rising' | 'falling';
}

export class TdmAudioDecoder extends Decoder<TdmOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private channels = 8;
  private channel = 0;
  private bitdepth = 16;
  private edge: 'r' | 'f' = 'r';
  private bitcount = 0;
  private lastframe = 0;
  private data = 0;
  private blockStart: bigint | null = null;

  override reset(): void {
    this.channels = 8;
    this.channel = 0;
    this.bitdepth = 16;
    this.edge = 'r';
    this.bitcount = 0;
    this.lastframe = 0;
    this.data = 0;
    this.blockStart = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.bitdepth = clamp(Math.trunc(Number(this.options.bps)), 1, 32);
    this.channels = clamp(Math.trunc(Number(this.options.channels)), 1, 8);
    this.edge = this.options.edge === 'falling' ? 'f' : 'r';
  }

  *decode(): LogicGenerator {
    while (true) {
      const pins = yield this.wait({ clock: this.edge });
      const frame = Number(pins[1]);
      this.data = this.data * 2 + Number(pins[2]);
      this.bitcount++;

      if (this.blockStart !== null && this.bitcount >= this.bitdepth) {
        this.bitcount = 0;
        this.channel++;
        const channelClass = this.channel < this.channels ? this.channel : 0;
        const width = this.bitdepth <= 8 ? 2 : this.bitdepth <= 16 ? 4 : 8;
        const value = this.data.toString(16).padStart(width, '0');
        this.put(this.blockStart, this.samplenum, this.outAnn, [
          channelClass,
          [`Channel ${this.channel}: ${value}`, `C${this.channel}: ${value}`, `${this.channel}: ${value}`],
        ]);
        this.data = 0;
        this.blockStart = this.samplenum;
      }

      if (frame !== this.lastframe && frame === 1) {
        this.channel = 0;
        this.bitcount = 0;
        this.data = 0;
        if (this.blockStart === null) this.blockStart = 0n;
      }
      this.lastframe = frame;
    }
  }
}

export default TdmAudioDecoder;
