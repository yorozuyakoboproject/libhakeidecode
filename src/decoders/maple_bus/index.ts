import { Decoder, OUTPUT_ANN, OUTPUT_BINARY, WaitToken } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pin } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

const FIELD_NAMES = [['Size', 'L'], ['SrcAP', 'S'], ['DstAP', 'D'], ['Cmd', 'C'], ['Data'], ['Cksum', 'K']] as const;

export class MapleBusDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;
  private outAnn = -1;
  private outBinary = -1;
  private ss = 0n;
  private es = 0n;
  private length = 0;
  private expectedLength = 4;
  private checksum = 0;
  private data = 0;
  private pendingBit = 0;
  private pendingBitPosition: bigint | null = null;

  override reset(): void {
    this.ss = 0n;
    this.es = 0n;
    this.length = 0;
    this.expectedLength = 4;
    this.checksum = 0;
    this.data = 0;
    this.pendingBit = 0;
    this.pendingBitPosition = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  private putAnnotation(classIndex: number, texts: readonly string[], ss = this.ss, es = this.es): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private putBinary(classIndex: number): void {
    this.put(this.ss, this.es, this.outBinary, [classIndex, Uint8Array.of(this.data)]);
  }

  private byteAnnotation(classIndex: number): void {
    const texts = FIELD_NAMES[classIndex]!.map(
      (name) => `${name}: ${this.data.toString(16).toUpperCase().padStart(2, '0')}`,
    );
    texts.push(this.data.toString(16).toUpperCase().padStart(2, '0'));
    this.putAnnotation(classIndex + 6, texts);
  }

  private outputPendingBit(): void {
    if (this.pendingBitPosition !== null)
      this.putAnnotation(
        5,
        [`Bit: ${this.pendingBit}`, String(this.pendingBit)],
        this.pendingBitPosition,
        this.pendingBitPosition,
      );
  }

  private gotBit(bit: number): void {
    this.outputPendingBit();
    this.data = (this.data * 2 + bit) >>> 0;
    this.pendingBit = bit;
    this.pendingBitPosition = this.samplenum;
  }

  private gotByte(): void {
    this.outputPendingBit();
    let classIndex = 4;
    if (this.length < 4) {
      if (this.length === 0) this.expectedLength = 4 * (this.data + 1);
      classIndex = this.length;
    } else if (this.length === this.expectedLength) {
      classIndex = 5;
      if (this.data !== this.checksum) this.putAnnotation(13, ['Cksum error', 'K error', 'KE']);
    }
    this.length++;
    this.checksum ^= this.data;
    this.byteAnnotation(classIndex);
    this.putBinary(classIndex);
    this.pendingBitPosition = null;
  }

  private frameError(): void {
    this.putAnnotation(7, ['Frame error', 'F error', 'FE']);
  }

  private gotStartCrc(): void {
    this.putAnnotation(2, ['Start pattern with CRC', 'Start CRC', 'SC']);
  }

  private gotOccupancy(): void {
    this.putAnnotation(3, ['SDCKB occupancy pattern', 'Occupancy', 'O']);
  }

  private gotReset(): void {
    this.putAnnotation(4, ['RESET pattern', 'RESET', 'R']);
  }

  private gotEnd(): void {
    this.putAnnotation(1, ['End pattern', 'End', 'E']);
    if (this.length !== this.expectedLength + 1) this.putAnnotation(14, ['Size error', 'L error', 'LE']);
  }

  *startPattern(): Generator<WaitToken, boolean, Pin[]> {
    let pins = yield this.wait({ sdcka: 'l', sdckb: 'h' });
    this.ss = this.samplenum;
    let count = 0;
    while (true) {
      pins = yield this.wait([{ sdckb: 'f' }, { sdcka: 'r' }]);
      if (this.matched?.[0]) count++;
      if (this.matched?.[1]) {
        this.es = this.samplenum;
        if ((Number(pins[1]) & 1) === 1) {
          if (count === 4) {
            this.putAnnotation(0, ['Start pattern', 'Start', 'S']);
            return true;
          }
          if (count === 6) {
            this.gotStartCrc();
            return true;
          }
          if (count === 8) {
            this.gotOccupancy();
            return false;
          }
          if (count >= 14) {
            this.gotReset();
            return false;
          }
        }
        this.frameError();
        return false;
      }
    }
  }

  *byteOrStop(): Generator<WaitToken, boolean, Pin[]> {
    this.ss = this.samplenum;
    this.pendingBitPosition = null;
    let initial = true;
    let counta = 0;
    let countb = 0;
    this.data = 0;
    while (countb < 4) {
      const pins = yield this.wait([{ sdcka: 'f' }, { sdckb: 'f' }]);
      this.es = this.samplenum;
      if (this.matched?.[0]) {
        if (counta === countb) {
          this.gotBit(Number(pins[1]) & 1);
          counta++;
        } else if (counta === 1 && countb === 0 && this.data === 0 && (Number(pins[1]) & 1) === 0) {
          yield this.wait([{ sdcka: 'h', sdckb: 'h' }, { sdcka: 'f' }, { sdckb: 'f' }]);
          this.es = this.samplenum;
          if (this.matched?.[0]) this.gotEnd();
          else this.frameError();
          return false;
        } else {
          this.frameError();
          return false;
        }
      } else if (this.matched?.[1]) {
        if (counta === countb + 1) {
          this.gotBit(Number(pins[0]) & 1);
          countb++;
        } else if (counta === 0 && countb === 0 && (Number(pins[0]) & 1) === 1 && initial) {
          this.ss = this.samplenum;
          initial = false;
        } else {
          this.frameError();
          return false;
        }
      }
    }
    yield this.wait({ sdcka: 'h' });
    this.es = this.samplenum;
    this.gotByte();
    return true;
  }

  *decode(): LogicGenerator {
    while (true) {
      let found = false;
      while (!found) found = yield* this.startPattern();
      this.length = 0;
      this.expectedLength = 4;
      this.checksum = 0;
      let more = true;
      while (more) more = yield* this.byteOrStop();
    }
  }
}

export default MapleBusDecoder;
