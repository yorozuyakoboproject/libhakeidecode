import { Decoder, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { I2CDirection, I2CProtocolPacket } from '../i2c/index.js';
import { descriptor } from './descriptor.js';

export interface I2CFilterOptions {
  address: number;
  direction: 'read' | 'write' | 'both';
}

interface CachedPacket {
  readonly ss: bigint;
  readonly es: bigint;
  readonly data: I2CProtocolPacket;
}

export class I2cfilterDecoder extends Decoder<I2CFilterOptions> {
  static descriptor = descriptor;
  private seen: CachedPacket[] = [];
  private doForward: boolean | null = null;
  private outProtocol = -1;
  private wantedAddress: number | null = null;
  private wantedDirection: I2CDirection | null = null;

  constructor(options: Partial<I2CFilterOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.seen = [];
    this.doForward = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'i2c');
    if (!Number.isInteger(this.options.address) || this.options.address < 0 || this.options.address > 127)
      throw new Error('Invalid slave (must be 0..127).');
    this.wantedAddress = this.options.address === 0 ? null : this.options.address;
    this.wantedDirection = this.options.direction === 'both' ? null : this.options.direction;
  }

  private needsForward(address: number, direction: I2CDirection): boolean {
    if (this.wantedAddress !== null && address !== this.wantedAddress) return false;
    return this.wantedDirection === null || direction === this.wantedDirection;
  }

  private forward(): void {
    if (!this.doForward) return;
    for (const packet of this.seen) this.put(packet.ss, packet.es, this.outProtocol, packet.data);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as I2CProtocolPacket;
    if (!Array.isArray(packet)) return;
    this.seen.push({ ss, es, data: packet });
    if (packet[0] === 'ADDRESS') {
      this.doForward = this.needsForward(packet[2] >>> 1, packet[1]);
      return;
    }
    if (packet[0] === 'STOP' || (packet[0] === 'START' && packet[1])) {
      this.forward();
      this.seen = [];
      this.doForward = null;
    }
  }
}

export default I2cfilterDecoder;
