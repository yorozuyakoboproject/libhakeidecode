import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const EM4100_ANN = Object.freeze({
  BIT: 0,
  HEADER: 1,
  VERSION_CUSTOMER: 2,
  DATA: 3,
  ROW_PARITY_OK: 4,
  ROW_PARITY_ERR: 5,
  COL_PARITY_OK: 6,
  COL_PARITY_ERR: 7,
  STOP: 8,
  TAG: 9,
});

type State = 'HEADER' | 'PAYLOAD' | 'TRAILER';

export class Em4100Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private bitWidth = 0;
  private halfbitLimit = 0;
  private polarity = 1;
  private outAnn = -1;
  private oldpin: number | null = null;
  private lastSamplenum = 0n;
  private lastlastSamplenum = 0n;
  private lastEdge = 0n;
  private oldpl = 0;
  private oldpp = 0;
  private oldsamplenum = 0n;
  private lastBitPos = 0n;
  private ssFirst = 0n;
  private firstOne = 0;
  private state: State = 'HEADER';
  private data = 0;
  private dataBits = 0;
  private ssData = 0n;
  private dataParity = 0;
  private payloadCount = 0;
  private dataColParity = [0, 0, 0, 0, 0, 0];
  private colParity = [0, 0, 0, 0, 0, 0];
  private tag = 0;
  private allRowParityOk = true;
  private colParityPos: Array<readonly [bigint, bigint]> = [];

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.bitWidth = 0;
    this.halfbitLimit = 0;
    this.oldpin = null;
    this.lastSamplenum = 0n;
    this.lastlastSamplenum = 0n;
    this.lastEdge = 0n;
    this.oldpl = 0;
    this.oldpp = 0;
    this.oldsamplenum = 0n;
    this.lastBitPos = 0n;
    this.ssFirst = 0n;
    this.firstOne = 0;
    this.state = 'HEADER';
    this.data = 0;
    this.dataBits = 0;
    this.ssData = 0n;
    this.dataParity = 0;
    this.payloadCount = 0;
    this.dataColParity = [0, 0, 0, 0, 0, 0];
    this.colParity = [0, 0, 0, 0, 0, 0];
    this.tag = 0;
    this.allRowParityOk = true;
    this.colParityPos = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.bitWidth = (value / Number(this.options.coilfreq)) * Number(this.options.datarate);
    this.halfbitLimit = this.bitWidth * 0.75;
    this.polarity = this.options.polarity === 'active-low' ? 0 : 1;
  }

  private putBit(bit: number, ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [EM4100_ANN.BIT, [String(bit)]]);
    if (this.state === 'HEADER') {
      if (bit === 1) {
        if (this.firstOne > 0) this.firstOne++;
        if (this.firstOne === 9) {
          this.put(this.ssFirst, es, this.outAnn, [EM4100_ANN.HEADER, ['Header', 'Head', 'He', 'H']]);
          this.firstOne = 0;
          this.state = 'PAYLOAD';
          return;
        }
        if (this.firstOne === 0) {
          this.firstOne = 1;
          this.ssFirst = ss;
        }
      }
      if (bit === 0) this.firstOne = 0;
      return;
    }

    if (this.state === 'PAYLOAD') {
      this.payloadCount++;
      if (this.dataBits === 0) {
        this.ssData = ss;
        this.data = 0;
        this.dataParity = 0;
      }
      this.dataBits++;
      if (this.dataBits === 5) {
        const field = this.payloadCount <= 10 ? 'Version/customer' : 'Data';
        const classIndex = this.payloadCount <= 10 ? EM4100_ANN.VERSION_CUSTOMER : EM4100_ANN.DATA;
        this.put(this.ssData, ss, this.outAnn, [
          classIndex,
          [`${field}: ${this.data.toString(16).toUpperCase()}`, this.data.toString(16).toUpperCase()],
        ]);
        const ok = this.dataParity === bit;
        if (!ok) this.allRowParityOk = false;
        this.put(ss, es, this.outAnn, [
          ok ? EM4100_ANN.ROW_PARITY_OK : EM4100_ANN.ROW_PARITY_ERR,
          ok ? ['Row parity: OK', 'RP: OK', 'RP', 'R'] : ['Row parity: ERROR', 'RP: ERROR', 'RP', 'R'],
        ]);
        this.tag = (this.tag << 4) | this.data;
        this.dataBits = 0;
        if (this.payloadCount === 50) {
          this.state = 'TRAILER';
          this.payloadCount = 0;
        }
      }
      this.dataParity ^= bit;
      this.dataColParity[this.dataBits] ^= bit;
      this.data = (this.data << 1) | bit;
      return;
    }

    this.payloadCount++;
    if (this.dataBits === 0) {
      this.ssData = ss;
      this.data = 0;
      this.dataParity = 0;
    }
    this.dataBits++;
    this.colParity[this.dataBits] = bit;
    this.colParityPos.push([ss, es]);
    if (this.dataBits !== 5) return;
    this.put(ss, es, this.outAnn, [EM4100_ANN.STOP, ['Stop bit', 'SB', 'S']]);
    for (let index = 1; index < 5; index++) {
      const ok = this.dataColParity[index] === this.colParity[index];
      const [ssPos, esPos] = this.colParityPos[index - 1]!;
      this.put(ssPos, esPos, this.outAnn, [
        ok ? EM4100_ANN.COL_PARITY_OK : EM4100_ANN.COL_PARITY_ERR,
        [`Column parity ${index}: ${ok ? 'OK' : 'ERROR'}`, `CP${index}: ${ok ? 'OK' : 'ERROR'}`, `CP${index}`, 'C'],
      ]);
    }
    const allColumns = this.dataColParity.slice(1, 5).every((value, index) => value === this.colParity[index + 1]);
    if (allColumns && this.allRowParityOk)
      this.put(this.ssFirst, es, this.outAnn, [
        EM4100_ANN.TAG,
        [`Tag: ${this.tag.toString(16).toUpperCase().padStart(10, '0')}`, 'Tag', 'T'],
      ]);
    this.tag = 0;
    this.dataBits = 0;
    if (this.payloadCount === 5) {
      this.state = 'HEADER';
      this.payloadCount = 0;
      this.dataColParity = [0, 0, 0, 0, 0, 0];
      this.colParity = [0, 0, 0, 0, 0, 0];
      this.colParityPos = [];
      this.allRowParityOk = true;
    }
  }

  private manchesterDecode(length: number): void {
    if (this.oldpin === null) return;
    const bit = this.oldpin ^ this.polarity;
    if (length > this.halfbitLimit) {
      const es = this.samplenum - BigInt(Math.trunc(length / 2));
      const ss =
        this.oldpl > this.halfbitLimit
          ? this.oldsamplenum - BigInt(Math.trunc(this.oldpl / 2))
          : this.oldsamplenum - BigInt(this.oldpl);
      this.putBit(bit, ss, es);
      this.lastBitPos = this.samplenum - BigInt(Math.trunc(length / 2));
    } else {
      const es = this.samplenum;
      if (this.oldpl > this.halfbitLimit) {
        const ss = this.oldsamplenum - BigInt(Math.trunc(this.oldpl / 2));
        this.putBit(bit, ss, es);
        this.lastBitPos = this.samplenum;
      } else if (this.lastBitPos <= this.oldsamplenum - BigInt(this.oldpl)) {
        const ss = this.oldsamplenum - BigInt(this.oldpl);
        this.putBit(bit, ss, es);
        this.lastBitPos = this.samplenum;
      }
    }
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    if (!(this.bitWidth > 0)) throw new Error('Invalid EM4100 bit width.');
    const pins = yield this.wait();
    this.oldpin = Number(pins[0]);
    this.lastSamplenum = this.samplenum;
    this.lastlastSamplenum = this.samplenum;
    this.lastEdge = this.samplenum;
    this.oldpl = 0;
    this.oldpp = 0;
    this.oldsamplenum = 0n;
    this.lastBitPos = 0n;
    while (true) {
      const next = yield this.wait({ data: 'e' });
      const length = Number(this.samplenum - this.oldsamplenum);
      this.manchesterDecode(length);
      this.oldpl = length;
      this.oldpp = Number(next[0]);
      this.oldsamplenum = this.samplenum;
      this.oldpin = Number(next[0]);
    }
  }
}

export default Em4100Decoder;
