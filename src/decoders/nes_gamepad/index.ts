import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const BUTTONS = ['A', 'B', 'Select', 'Start', 'North', 'South', 'West', 'East'];

export class NesGamepadDecoder extends Decoder {
  static descriptor = descriptor;
  private outAnn = -1;

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || data[0] !== 'WORD' || typeof data[2] !== 'number') return;
    const value = data[2] & 0xff;
    if (value === 0xff) {
      this.put(ss, es, this.outAnn, [1, ['No button is pressed']]);
      return;
    }
    if (value === 0x00) {
      this.put(ss, es, this.outAnn, [2, ['Gamepad is not connected']]);
      return;
    }
    const pressed = BUTTONS.filter((_, index) => ((value >>> (7 - index)) & 1) === 0);
    this.put(ss, es, this.outAnn, [0, [pressed.join(' + ')]]);
  }
}

export default NesGamepadDecoder;
