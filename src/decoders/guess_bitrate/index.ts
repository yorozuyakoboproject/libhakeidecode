import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export class GuessBitrateDecoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;
  private outAnn = -1;
  private samplerate = 0;

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    yield this.wait({ data: 'e' });
    let edge = this.samplenum;
    let bitwidth: bigint | null = null;

    while (true) {
      yield this.wait({ data: 'e' });
      const width = this.samplenum - edge;
      if (bitwidth === null || width < bitwidth) {
        bitwidth = width;
        const bitrate = Math.trunc(this.samplerate / Number(width));
        this.put(edge, this.samplenum, this.outAnn, [0, [String(bitrate)]]);
      }
      edge = this.samplenum;
    }
  }
}

export default GuessBitrateDecoder;
