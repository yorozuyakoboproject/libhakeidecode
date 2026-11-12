import { Decoder, OUTPUT_ANN, OUTPUT_BINARY } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export class Mcs48Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;
  private outAnn = -1;
  private outBinary = -1;
  private address = 0;
  private addressStart = 0n;
  private dataStart = 0n;
  private started = false;

  override reset(): void {
    this.address = 0;
    this.addressStart = 0n;
    this.dataStart = 0n;
    this.started = false;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  *decode(): LogicGenerator {
    const hasBank = this.hasChannel('a12');
    while (true) {
      const pins = yield this.wait([{ ale: 'f' }, { psen: 'r' }]);
      let address = 0;
      for (let bit = 0; bit < 4; bit++) address |= (Number(pins[10 + bit]) & 1) << bit;
      if (hasBank) address |= (Number(pins[14]) & 1) << 4;
      let data = 0;
      for (let bit = 0; bit < 8; bit++) data |= (Number(pins[2 + bit]) & 1) << bit;
      if (this.matched?.[0]) {
        this.address = (address << 8) | data;
        this.addressStart = this.samplenum;
        this.started = true;
      }
      if (this.matched?.[1] && this.started) {
        this.dataStart = this.samplenum;
        const text = `${this.address.toString(16).toUpperCase().padStart(4, '0')}:${data
          .toString(16)
          .toUpperCase()
          .padStart(2, '0')}`;
        this.put(this.addressStart, this.dataStart, this.outAnn, [0, [text]]);
        this.put(this.addressStart, this.dataStart, this.outBinary, [
          0,
          Uint8Array.of((this.address >>> 8) & 0xff, this.address & 0xff, data),
        ]);
      }
    }
  }
}

export default Mcs48Decoder;
