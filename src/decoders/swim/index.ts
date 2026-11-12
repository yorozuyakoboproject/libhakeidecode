import { Decoder, OUTPUT_ANN, OUTPUT_BINARY, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pin } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface SwimOptions {
  debug: 'yes' | 'no';
}

type Edge = readonly [level: number, sample: bigint | null];
type ProtocolState = 'CMD' | 'N' | '@E' | '@H' | '@L' | 'D';

export class SwimDecoder extends Decoder<SwimOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outBinary = -1;
  private samplerate: number | null = null;
  private swimClock = 3_600_000;
  private syncReflenMin = 0;
  private syncReflenMax = 0;
  private eseqReflen = 0;
  private eseqEdge: Edge[] = [
    [-1, null],
    [-1, null],
  ];
  private eseqPairnum = 0;
  private eseqPairstart: bigint | null = null;
  private bitEdge: Edge[] = [
    [-1, null],
    [-1, null],
  ];
  private bitMaxlen = -1;
  private bitReflen = 1;
  private bitSeqLen = 0;
  private bitSeqEnd: bigint | null = null;
  private bitSeqStart = 0n;
  private bitSeqValue = 0;
  private bitSeqDir = 0;
  private protoState: ProtocolState = 'CMD';
  private protoByteCount = 0;
  private protoAddr = 0;
  private protoAddrStart = 0n;
  private debug = false;

  override reset(): void {
    this.bitEdge = [
      [-1, null],
      [-1, null],
    ];
    this.bitMaxlen = -1;
    this.bitSeqLen = 0;
    this.bitSeqEnd = null;
    this.protoState = 'CMD';
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
    this.debug = this.options.debug === 'yes';
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private level(pin: Pin | undefined): 0 | 1 {
    if (pin !== 0 && pin !== 1) throw new Error('SWIM is not a digital level.');
    return pin;
  }

  private adjustTimings(): void {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    this.bitReflen = Math.ceil((this.samplerate * 22) / this.swimClock);
  }

  private setupTimings(): void {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    this.syncReflenMin = Math.floor((this.samplerate * 64) / 8_800_000);
    this.syncReflenMax = Math.ceil((this.samplerate * 128) / 3_600_000);
    this.eseqReflen = Math.ceil(this.samplerate / 2048);
    this.adjustTimings();
  }

  private putAt(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private putSequence(classIndex: number, texts: readonly string[]): void {
    this.putAt(this.bitSeqStart, this.bitSeqEnd ?? this.samplenum, classIndex, texts);
  }

  private byteTexts(value: number): readonly string[] {
    return [`0x${value.toString(16).padStart(2, '0')}`, value.toString(16).padStart(2, '0'), value.toString(16)];
  }

  private protocol(): void {
    if (this.protoState === 'CMD') {
      if (this.bitSeqValue === 0x00) this.putSequence(10, ['system reset', 'SRST', '!']);
      else if (this.bitSeqValue === 0x01) {
        this.protoState = 'N';
        this.putSequence(10, ['read on-the-fly', 'ROTF', 'r']);
      } else if (this.bitSeqValue === 0x02) {
        this.protoState = 'N';
        this.putSequence(10, ['write on-the-fly', 'WOTF', 'w']);
      } else this.putSequence(9, ['unknown', 'UNK']);
      return;
    }
    if (this.protoState === 'N') {
      this.protoByteCount = this.bitSeqValue;
      this.protoState = '@E';
      const hex = this.bitSeqValue.toString(16).padStart(2, '0');
      this.putSequence(11, [`byte count 0x${hex}`, `bytes 0x${hex}`, `0x${hex}`, hex, this.bitSeqValue.toString(16)]);
      return;
    }
    if (this.protoState === '@E') {
      this.protoAddr = this.bitSeqValue;
      this.protoAddrStart = this.bitSeqStart;
      this.protoState = '@H';
      return;
    }
    if (this.protoState === '@H') {
      this.protoAddr = (this.protoAddr << 8) | this.bitSeqValue;
      this.protoState = '@L';
      return;
    }
    if (this.protoState === '@L') {
      this.protoAddr = (this.protoAddr << 8) | this.bitSeqValue;
      this.protoState = 'D';
      const hex = this.protoAddr.toString(16).padStart(6, '0');
      this.putAt(this.protoAddrStart, this.bitSeqEnd ?? this.samplenum, 12, [
        `address 0x${hex}`,
        `addr 0x${hex}`,
        `0x${hex}`,
        hex,
        this.protoAddr.toString(16),
      ]);
      return;
    }
    if (this.protoByteCount > 0) {
      this.protoByteCount--;
      if (this.protoByteCount === 0) this.protoState = 'CMD';
    }
    this.putSequence(13 + this.bitSeqDir, this.byteTexts(this.bitSeqValue));
    this.put(this.bitSeqStart, this.bitSeqEnd ?? this.samplenum, this.outBinary, [
      this.bitSeqDir,
      Uint8Array.of(this.bitSeqValue),
    ]);
    if (this.debug) this.putSequence(15, [`${this.protoByteCount} more`, String(this.protoByteCount)]);
  }

  private bitSequence(bitStart: bigint, bitEnd: bigint, bit: 0 | 1): void {
    if (this.bitSeqLen === 0) {
      this.bitReflen = Number(bitEnd - bitStart);
      this.bitSeqValue = 0;
      this.bitSeqDir = bit;
      this.bitSeqLen = 1;
      this.putAt(bitStart, bitEnd, 2 + bit, ['start', 's']);
    } else if (
      (this.protoState === 'CMD' && this.bitSeqLen === 4) ||
      (this.protoState !== 'CMD' && this.bitSeqLen === 9)
    ) {
      this.bitSeqEnd = bitStart;
      this.bitSeqLen++;
      this.putAt(bitStart, bitEnd, 4, ['parity', 'par', 'p']);
      this.bitSeqValue &= 0xff;
      this.putSequence(7 + this.bitSeqDir, this.byteTexts(this.bitSeqValue));
    } else if (
      (this.protoState === 'CMD' && this.bitSeqLen === 5) ||
      (this.protoState !== 'CMD' && this.bitSeqLen === 10)
    ) {
      this.putAt(bitStart, bitEnd, bit === 1 ? 5 : 6, bit === 1 ? ['ack', 'a'] : ['nack', 'n']);
      if (bit === 1) this.protocol();
      this.bitSeqLen = 0;
    } else {
      if (this.bitSeqLen === 1) this.bitSeqStart = bitStart;
      this.bitSeqValue = (this.bitSeqValue << 1) | bit;
      this.bitSeqLen++;
    }
  }

  private bit(start: bigint, middle: bigint, end: bigint): void {
    const bit: 0 | 1 = middle - start >= end - middle ? 0 : 1;
    this.putAt(start, end, 0, [String(bit)]);
    this.bitSequence(start, end, bit);
  }

  private detectSynchronizationFrame(): void {
    const start = this.eseqEdge[1]![1];
    if (start === null || !this.samplerate) return;
    const length = this.samplenum - start;
    if (length < BigInt(this.syncReflenMin) || length > BigInt(this.syncReflenMax)) return;
    this.putAt(start, this.samplenum, 1, ['synchronization frame', 'synchronization', 'sync', 's']);
    this.reset();
    this.swimClock = 128 * (this.samplerate / Number(length));
    this.adjustTimings();
  }

  private potentialEnterSequence(start: bigint, end: bigint): void {
    this.eseqPairstart = start;
    this.eseqReflen = Number(end - start);
    this.eseqPairnum = 1;
  }

  private detectEnterSequence(start: bigint | null, end: bigint): void {
    if (start === null) return;
    const length = Number(end - start);
    if (this.eseqPairnum === 0 || Math.abs(this.eseqReflen - length) > 2) this.potentialEnterSequence(start, end);
    else if (this.eseqPairnum < 4) {
      this.eseqPairnum++;
      if (this.eseqPairnum === 4) this.eseqReflen /= 2;
    } else {
      this.eseqPairnum++;
      if (this.eseqPairnum === 8) {
        this.putAt(this.eseqPairstart ?? start, end, 1, ['enter sequence', 'enter seq', 'enter', 'ent', 'e']);
        this.eseqPairnum = 0;
      }
    }
  }

  *decode(): LogicGenerator {
    this.setupTimings();
    let previousSample = this.samplenum;
    while (true) {
      let pins;
      const before = previousSample;
      if (this.bitMaxlen === 0) {
        pins = yield this.wait([{ swim: 'e' }, { skip: 1 }]);
        this.bitMaxlen = -1;
      } else if (this.bitMaxlen > 0) {
        const remaining = this.bitMaxlen;
        pins = yield this.wait([{ swim: 'e' }, { skip: remaining }]);
        if (this.matched?.[1]) this.bitMaxlen = 0;
        else this.bitMaxlen = Math.max(0, remaining - Number(this.samplenum - before));
      } else {
        pins = yield this.wait({ swim: 'e' });
      }
      previousSample = this.samplenum;
      let swim: number = this.level(pins[0]);

      const previousLine = this.eseqEdge[1]!;
      if (swim !== previousLine[0]) {
        if (swim === 1 && previousLine[1] !== null) {
          this.detectSynchronizationFrame();
          this.detectEnterSequence(this.eseqEdge[0]![1], this.samplenum);
        }
        this.eseqEdge.shift();
        this.eseqEdge.push([swim, this.samplenum]);
      }

      const lastBitEdge = this.bitEdge[1]!;
      if ((swim !== lastBitEdge[0] && (swim !== 1 || lastBitEdge[0] !== -1)) || this.bitMaxlen === 0) {
        if (this.bitMaxlen === 0 && lastBitEdge[0] === 1) swim = -1;
        if (lastBitEdge[0] !== 0 && swim === 0) this.bitMaxlen = this.bitReflen;
        const start = this.bitEdge[0]!;
        if (
          start[0] === 0 &&
          lastBitEdge[0] === 1 &&
          start[1] !== null &&
          lastBitEdge[1] !== null &&
          Number(this.samplenum - start[1]) <= this.bitReflen + 2
        )
          this.bit(start[1], lastBitEdge[1], this.samplenum);
        this.bitEdge.shift();
        this.bitEdge.push([swim, this.samplenum]);
      }
    }
  }
}

export default SwimDecoder;
