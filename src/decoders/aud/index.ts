import { Decoder } from '../../libhakeidecode/index.js';
import { OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export class AudDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private nibbleCount = 0;
  private nibbleMaximum = 0;
  private address = 0n;
  private lastAddress = 0n;
  private blockStart = 0n;

  override reset(): void {
    this.nibbleCount = 0;
    this.nibbleMaximum = 0;
    this.address = 0n;
    this.lastAddress = 0n;
    this.blockStart = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  *decode(): LogicGenerator {
    while (true) {
      const pins = yield this.wait({ audck: 'r' });
      const sync = Number(pins[1]);
      const nibble = (Number(pins[2]) << 3) | (Number(pins[3]) << 2) | (Number(pins[4]) << 1) | Number(pins[5]);

      if (sync === 1) {
        if (this.nibbleCount === this.nibbleMaximum && this.nibbleMaximum !== 0) {
          this.put(this.blockStart, this.samplenum, this.outAnn, [
            0,
            [`0x${this.address.toString(16).toUpperCase().padStart(8, '0')}`],
          ]);
          this.lastAddress = this.address;
        }
        this.nibbleCount = 0;
        this.address = this.lastAddress;
        this.blockStart = this.samplenum;
        this.nibbleMaximum = nibble === 0x08 ? 1 : nibble === 0x09 ? 2 : nibble === 0x0a ? 4 : nibble === 0x0b ? 8 : 0;
      } else if (this.nibbleMaximum > 0) {
        const shift = BigInt(this.nibbleCount * 4);
        this.address = (this.address & ~(0xfn << shift)) | (BigInt(nibble) << shift);
        this.nibbleCount++;
      }
    }
  }
}

export default AudDecoder;
