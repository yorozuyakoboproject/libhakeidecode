import { Decoder, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import type { I2CProtocolPacket } from '../i2c/index.js';
import { descriptor } from './descriptor.js';

interface CachedPacket {
  readonly ss: bigint;
  readonly es: bigint;
  readonly data: I2CProtocolPacket;
}

export class I2cdemuxDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;
  private packets: CachedPacket[] = [];
  private streams = new Map<number, number>();
  private stream: number | null = null;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.packets = [];
    this.streams.clear();
    this.stream = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as I2CProtocolPacket;
    if (!Array.isArray(packet)) return;
    this.packets.push({ ss, es, data: packet });
    if (packet[0] === 'ADDRESS') {
      const address = packet[2],
        known = this.streams.get(address);
      if (known !== undefined) {
        this.stream = known;
        return;
      }
      const output = this.register(OUTPUT_PROTOCOL, 'i2c-0x' + address.toString(16));
      this.streams.set(address, output);
      this.stream = output;
    } else if (packet[0] === 'STOP') {
      if (this.stream === null) throw new Error('Invalid stream!');
      for (const cached of this.packets) this.put(cached.ss, cached.es, this.stream, cached.data);
      this.packets = [];
      this.stream = null;
    }
  }
}

export default I2cdemuxDecoder;
