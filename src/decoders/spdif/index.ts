import { Decoder } from '../../libhakeidecode/index.js';
import { OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

type SpdifState = 'GET_FIRST' | 'GET_SECOND' | 'GET_THIRD' | 'DECODE_STREAM' | 'DECODE_PREAMBLE';

interface SubframeBit {
  readonly value: number;
  readonly ss: bigint;
  es: bigint;
}

export class SpdifDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private samplerate = 0;
  private state: SpdifState = 'GET_FIRST';
  private ssEdge: bigint | null = null;
  private previousEdge = 0n;
  private pulseWidth = 0;
  private clocks: number[] = [];
  private range1 = 0;
  private range2 = 0;
  private preamble: number[] = [];
  private preambleState = 0;
  private seenPreamble = false;
  private bitrateMessageStart = 0n;
  private bitrateMessageEnd = 0n;
  private frameCounter = 0;
  private frameStart = 0n;
  private frameLength = 0;
  private firstOne = true;
  private subframe: SubframeBit[] = [];
  private bitcount = 0;

  override reset(): void {
    this.samplerate = 0;
    this.state = 'GET_FIRST';
    this.ssEdge = null;
    this.previousEdge = 0n;
    this.pulseWidth = 0;
    this.clocks = [];
    this.range1 = 0;
    this.range2 = 0;
    this.preamble = [];
    this.preambleState = 0;
    this.seenPreamble = false;
    this.bitrateMessageStart = 0n;
    this.bitrateMessageEnd = 0n;
    this.frameCounter = 0;
    this.frameStart = 0n;
    this.frameLength = 0;
    this.firstOne = true;
    this.subframe = [];
    this.bitcount = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private pulseType(): number {
    if (this.pulseWidth >= this.range2) return 2;
    if (this.pulseWidth >= this.range1) return 0;
    return 1;
  }

  private putEdge(classIndex: number, texts: readonly string[]): void {
    this.put(this.ssEdge ?? 0n, this.samplenum, this.outAnn, [classIndex, texts]);
  }

  private putAt(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private finishSubframe(): void {
    const aux = this.subframe.slice(0, 4);
    const sample = this.subframe.slice(4, 24);
    const validity = this.subframe[24]!;
    const subcode = this.subframe[25]!;
    const channel = this.subframe[26]!;
    const parity = this.subframe[27]!;
    let value = 0;
    let reversed = 0;
    for (let index = 0; index < 24; index++) {
      const bit = this.subframe[index]!.value;
      value = value * 2 + bit;
      reversed += bit * 2 ** index;
    }
    const hex = value.toString(16);
    const reversedHex = reversed.toString(16);
    this.putAt(aux[0]!.ss, aux[3]!.es, 3, [`Aux 0x${hex}`, `0x${hex}`]);
    this.putAt(sample[0]!.ss, sample[19]!.es, 3, [`Sample 0x${hex}`, `0x${hex}`]);
    this.putAt(aux[0]!.ss, sample[19]!.es, 4, [`Audio 0x${reversedHex}`, `0x${reversedHex}`]);
    this.putAt(validity.ss, validity.es, 5, [validity.value === 0 ? 'V' : 'E']);
    this.putAt(subcode.ss, subcode.es, 6, [`S: ${subcode.value}`]);
    this.putAt(channel.ss, channel.es, 7, [`C: ${channel.value}`]);
    this.putAt(parity.ss, parity.es, 8, [`P: ${parity.value}`]);
    this.subframe = [];
    this.seenPreamble = false;
    this.bitcount = 0;
  }

  private decodeStream(pulse: number): void {
    if (!this.seenPreamble) {
      if (pulse === 2) {
        this.preamble.push(pulse);
        this.state = 'DECODE_PREAMBLE';
        this.ssEdge = this.samplenum - BigInt(this.pulseWidth);
        if (this.frameCounter === 0) {
          this.frameStart = this.samplenum;
          this.bitrateMessageEnd = this.ssEdge;
        } else if (this.frameCounter === 10) {
          this.frameLength = Number(this.samplenum - this.frameStart);
          if (this.samplerate) {
            const audioRate = (this.samplerate / 200 / this.frameLength).toFixed(2).padStart(6, ' ');
            const bitRate = (((this.samplerate / 200) * 64) / 1000 / this.frameLength).toFixed(3).padStart(6, ' ');
            this.putAt(this.bitrateMessageStart, this.bitrateMessageEnd, 0, [
              `Audio samplingrate: ${audioRate} kHz; Bit rate: ${bitRate} MBit/s`,
            ]);
          } else {
            this.putAt(this.bitrateMessageStart, this.bitrateMessageEnd, 0, ['No sample rate given']);
          }
        }
        this.frameCounter++;
      }
      return;
    }

    if (pulse === 1 && this.firstOne) {
      this.firstOne = false;
      this.subframe.push({
        value: pulse,
        ss: this.samplenum - BigInt(this.pulseWidth),
        es: this.samplenum,
      });
    } else if (pulse === 1) {
      const last = this.subframe.at(-1);
      if (!last) return;
      last.es = this.samplenum;
      this.putAt(last.ss, this.samplenum, 2, ['1']);
      this.bitcount++;
      this.firstOne = true;
    } else {
      this.subframe.push({
        value: pulse,
        ss: this.samplenum - BigInt(this.pulseWidth),
        es: this.samplenum,
      });
      this.putAt(this.samplenum - BigInt(this.pulseWidth), this.samplenum, 2, ['0']);
      this.bitcount++;
    }
    if (this.bitcount === 28) this.finishSubframe();
  }

  private decodePreamble(): void {
    if (this.preambleState < 2) {
      this.preamble.push(this.pulseType());
      this.preambleState++;
      return;
    }
    this.preamble.push(this.pulseType());
    this.preambleState = 0;
    this.state = 'DECODE_STREAM';
    const pattern = this.preamble.join(',');
    if (pattern === '2,0,1,0') this.putEdge(1, ['Preamble W', 'W']);
    else if (pattern === '2,2,1,1') this.putEdge(1, ['Preamble M', 'M']);
    else if (pattern === '2,1,1,2') this.putEdge(1, ['Preamble B', 'B']);
    else this.putEdge(1, ['Unknown Preamble', 'Unknown Prea.', 'U']);
    this.preamble = [];
    this.seenPreamble = true;
    this.bitcount = 0;
    this.firstOne = true;
  }

  *decode(): LogicGenerator {
    yield this.wait({ data: 'e' });
    yield this.wait({ data: 'e' });
    this.ssEdge = 0n;
    this.putEdge(2, ['Skip']);
    this.ssEdge = this.samplenum;
    this.previousEdge = this.samplenum;

    while (true) {
      yield this.wait({ data: 'e' });
      this.pulseWidth = Number(this.samplenum - this.previousEdge);
      this.previousEdge = this.samplenum;

      if (this.state === 'GET_FIRST') {
        if (this.pulseWidth !== 0) {
          this.clocks.push(this.pulseWidth);
          this.state = 'GET_SECOND';
          this.putEdge(2, [`Found width 1: ${this.pulseWidth}`, `W1: ${this.pulseWidth}`]);
          this.ssEdge = this.samplenum;
        }
      } else if (this.state === 'GET_SECOND') {
        if (this.pulseWidth > this.clocks[0]! * 1.3 || this.pulseWidth <= this.clocks[0]! * 0.75) {
          this.putEdge(2, [`Found width 2: ${this.pulseWidth}`, `W2: ${this.pulseWidth}`]);
          this.clocks.push(this.pulseWidth);
          this.state = 'GET_THIRD';
        } else {
          this.putEdge(2, [`Search width 2: ${this.pulseWidth}`, `SW2: ${this.pulseWidth}`]);
        }
        this.ssEdge = this.samplenum;
      } else if (this.state === 'GET_THIRD') {
        const differs =
          (this.pulseWidth > this.clocks[0]! * 1.3 || this.pulseWidth <= this.clocks[0]! * 0.75) &&
          (this.pulseWidth > this.clocks[1]! * 1.3 || this.pulseWidth <= this.clocks[1]! * 0.75);
        if (!differs) {
          this.putEdge(2, [`Search width 3: ${this.pulseWidth}`, `SW3: ${this.pulseWidth}`]);
          this.ssEdge = this.samplenum;
          continue;
        }

        this.putEdge(2, [`Found width 3: ${this.pulseWidth}`, `W3: ${this.pulseWidth}`]);
        this.ssEdge = this.samplenum;
        this.bitrateMessageStart = this.samplenum;
        this.clocks.push(this.pulseWidth);
        this.clocks.sort((left, right) => left - right);
        this.range1 = (this.clocks[0]! + this.clocks[1]!) / 2;
        this.range2 = (this.clocks[1]! + this.clocks[2]!) / 2;
        if (this.clocks[0]! <= 3) {
          this.putAt(0n, this.samplenum, 0, ['Short pulses detected. Increase sample rate!']);
          throw new Error('Short pulses detected');
        }
        this.putAt(0n, this.samplenum, 0, ['Synchronisation']);
        this.ssEdge = 0n;

        yield this.wait({ data: 'e' });
        this.pulseWidth = Number(this.samplenum - this.previousEdge);
        this.previousEdge = this.samplenum;
        this.state = 'DECODE_STREAM';
      } else if (this.state === 'DECODE_STREAM') {
        this.decodeStream(this.pulseType());
      } else {
        this.decodePreamble();
      }
    }
  }
}

export default SpdifDecoder;
