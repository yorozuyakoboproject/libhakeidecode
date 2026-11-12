import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface ArmTpiuOptions {
  stream: number;
  sync_offset: number;
}

type TpiuByte = readonly [ss: bigint, es: bigint, value: number];
type UartData = readonly ['DATA', 0 | 1, readonly [value: number, bits: unknown]];

export class ArmTpiuDecoder extends Decoder<ArmTpiuOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private outProtocol = -1;
  private buffer: TpiuByte[] = [];
  private syncBuffer: number[] = [];
  private previousSample = 0n;
  private currentStream = 0;
  private streamStart: bigint | null = null;
  private byteCount = 0;
  private byteLength = 0n;

  constructor(options: Partial<ArmTpiuOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.buffer = [];
    this.syncBuffer = [];
    this.previousSample = 0n;
    this.currentStream = 0;
    this.streamStart = null;
    this.byteCount = 0;
    this.byteLength = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'uart');
  }

  private streamChanged(ss: bigint, stream: number): void {
    if (this.currentStream === stream) return;
    if (this.currentStream !== 0)
      this.put(this.streamStart ?? ss, ss, this.outAnn, [
        0,
        [`Stream ${this.currentStream}`, `S${this.currentStream}`],
      ]);
    this.currentStream = stream;
    this.streamStart = ss;
  }

  private emitByte(ss: bigint, es: bigint, value: number): void {
    if (this.currentStream !== this.options.stream) return;
    this.put(ss, es, this.outAnn, [1, [`0x${value.toString(16).padStart(2, '0')}`]]);
    this.put(ss, es, this.outProtocol, ['DATA', 0, [value, []]]);
  }

  private processFrame(frame: readonly TpiuByte[]): void {
    const lowBits = frame[15]![2];
    for (let index = 0; index < 15; index += 2) {
      const control = frame[index]!;
      let delayedStream: number | null = null;
      const lowBit = (lowBits >> (index / 2)) & 1;
      if ((control[2] & 1) !== 0) {
        if (lowBit) delayedStream = control[2] >> 1;
        else this.streamChanged(control[0], control[2] >> 1);
      } else {
        this.emitByte(control[0], control[1], control[2] | lowBit);
      }
      if (index < 14) {
        const data = frame[index + 1]!;
        this.emitByte(data[0], data[1], data[2]);
      }
      if (delayedStream !== null) this.streamChanged(frame[index + 1]![1], delayedStream);
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const [packetType, , payload] = data as UartData;
    if (packetType !== 'DATA') return;
    const value = payload[0];
    this.byteLength = es - ss;
    if (ss - this.previousSample > this.byteLength) this.buffer = [];
    this.previousSample = es;
    this.buffer.push([ss, es, value]);
    this.byteCount++;
    if (this.byteCount < this.options.sync_offset) {
      this.buffer = [];
      return;
    }
    this.syncBuffer = [...this.syncBuffer.slice(-3), value];
    if (this.syncBuffer.join(',') === '255,255,255,127') {
      this.buffer = [];
      this.syncBuffer = [];
      return;
    }
    if (this.buffer.length === 16) {
      this.processFrame(this.buffer);
      this.buffer = [];
    }
  }
}

export default ArmTpiuDecoder;
