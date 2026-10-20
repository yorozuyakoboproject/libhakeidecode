import { Decoder, OUTPUT_PROTOCOL } from '../libhakeidecode/index.js';
import type { DecoderContext, DecoderDescriptor } from '../libhakeidecode/index.js';

export class FrameToTextDecoder extends Decoder {
  out!: number;
  static descriptor: DecoderDescriptor = { apiVersion: 3, id: 'frame-to-text', name: 'Frame to text', inputs: ['uart'], outputs: ['text'] };
  start(ctx: DecoderContext): void { super.start(ctx); this.out = this.register(OUTPUT_PROTOCOL, 'text'); }
  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    const [kind, direction, payload] = data;
    if (kind !== 'FRAME' || !Array.isArray(payload)) return;
    const [value, valid] = payload;
    this.put(ss, es, this.out, { type: 'text-frame', direction, value, valid, text: String.fromCharCode(value) });
  }
}
