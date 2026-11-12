import {
  Decoder,
  OUTPUT_ANN,
  OUTPUT_BINARY,
  OUTPUT_PROTOCOL,
  SRD_CONF_SAMPLERATE,
} from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pins } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface OokOptions {
  invert: string;
  decodeas: string;
  preamble: string;
  preamlen: string;
  diffmanvar: string;
}

export type OokBit = readonly [ss: bigint, es: bigint, state: string];
type MutableOokBit = [bigint, bigint, string];
type OokPulse = [ss: bigint, samples: bigint, state: string];

const ANN = Object.freeze({
  FRAME: 0,
  INFO: 1,
  MAN_1111: 2,
  MAN_1010: 3,
  DIFF_MAN: 4,
  NRZ: 5,
});

function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

export class OokDecoder extends Decoder<OokOptions> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private ss = 0n;
  private es = 0n;
  private ss1111 = 0n;
  private ss1010 = 0n;
  private samplenumberLast: bigint | null = null;
  private sampleFirst = 0n;
  private sampleHigh = 0n;
  private sampleLow = 0n;
  private edgeCount = 0;
  private wordFirst = 0n;
  private state = 'IDLE';
  private lstate: string | null = null;
  private lstate1010: string | null = null;
  private insync = 0;
  private manErrors = 0;
  private manErrors1010 = 0;
  private preamble: OokPulse[] = [];
  private halfTime = -1;
  private halfTime1010 = 0;
  private pulseLengths: bigint[] = [];
  private decoded: MutableOokBit[] = [];
  private decoded1010: MutableOokBit[] = [];
  private diffManTrans = '0';
  private diffManLen = 1;
  private readonly maxErrors = 5;
  private timeoutReset = false;
  private outAnn = -1;
  private outProtocol = -1;
  private outBinary = -1;

  constructor(options: Partial<OokOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.ss = this.es = 0n;
    this.ss1111 = this.ss1010 = 0n;
    this.samplenumberLast = null;
    this.sampleFirst = 0n;
    this.sampleHigh = 0n;
    this.sampleLow = 0n;
    this.edgeCount = 0;
    this.wordFirst = 0n;
    this.state = 'IDLE';
    this.lstate = null;
    this.lstate1010 = null;
    this.insync = 0;
    this.manErrors = 0;
    this.manErrors1010 = 0;
    this.preamble = [];
    this.halfTime = -1;
    this.halfTime1010 = 0;
    this.pulseLengths = [];
    this.decoded = [];
    this.decoded1010 = [];
    this.diffManTrans = '0';
    this.diffManLen = 1;
    this.timeoutReset = false;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'ook');
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private putx(classIndex: number, texts: readonly string[]): void {
    this.put(this.ss, this.es, this.outAnn, [classIndex, texts]);
  }

  private putp(data: readonly OokBit[]): void {
    this.put(this.ss, this.es, this.outProtocol, data);
  }

  private dumpPulseLengths(): void {
    if (!this.samplerate || !this.pulseLengths.length) return;
    this.pulseLengths[this.pulseLengths.length - 1] = this.sampleFirst;
    const text =
      'Pulses(us)=' +
      this.pulseLengths.map((value) => Math.trunc((Number(value) * 1_000_000) / this.samplerate!)).join(',') +
      '\n';
    const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
    const start = this.samplenum > 10n ? this.samplenum - 10n : 0n;
    this.put(start, this.samplenum, this.outBinary, [0, bytes]);
  }

  private decodeNrz(start: bigint, samples: bigint, state: string): void {
    this.pulseLengths.push(samples);
    let dsamples = state === '1' ? this.sampleHigh : this.sampleLow;
    if (dsamples <= 0n) dsamples = 1n;
    this.ss = start;
    this.es = start + samples;
    while (samples > Number(dsamples) * 0.5) {
      if (samples >= Number(dsamples) * 1.5) {
        this.es = this.ss + dsamples;
        this.putx(ANN.NRZ, [state]);
        this.decoded.push([this.ss, this.es, state]);
        this.edgeCount++;
      } else if (samples >= Number(dsamples) * 0.5 && samples < Number(dsamples) * 1.5) {
        this.putx(ANN.NRZ, [state]);
        this.decoded.push([this.ss, this.es, state]);
        this.edgeCount++;
      } else {
        this.edgeCount++;
      }
      samples -= dsamples;
      this.ss += dsamples;
      this.es += dsamples;
      if (this.es > this.samplenum) this.es = this.samplenum;
      if (this.state === 'DECODE_TIMEOUT') {
        this.ss = this.decoded[0]![0];
        this.es = this.decoded.at(-1)![1];
        this.dumpPulseLengths();
        this.putp(this.decoded);
        this.decodeTimeout();
        break;
      }
    }
  }

  private lockOntoPreamble(samples: bigint, state: string): void {
    this.edgeCount++;
    const ratio = 5n;
    if (this.state === 'DECODE_TIMEOUT') {
      this.preamble = [];
      this.edgeCount = 0;
      this.wordFirst = this.samplenum;
      this.sampleFirst = this.samplenumberLast === null ? 0n : this.samplenum - this.samplenumberLast;
      this.state = 'WAITING_FOR_PREAMBLE';
      this.manErrors = 0;
    }

    const preDetect = Number.parseInt(this.options.preamlen, 10);
    const preSamples = this.samplenumberLast === null ? 0n : this.samplenum - this.samplenumberLast;
    if (this.preamble.length > 0) {
      const previous = this.preamble.at(-1)!;
      if (preSamples * ratio < previous[1] || previous[1] * ratio < preSamples) {
        this.put(this.samplenum, this.samplenum, this.outAnn, [ANN.FRAME, ['R']]);
        this.preamble = [];
        this.preamble.push([this.samplenumberLast ?? this.samplenum, preSamples, state]);
        this.edgeCount = 0;
        this.samplenumberLast = this.samplenum;
        this.wordFirst = this.samplenum;
      } else {
        this.preamble.push([this.samplenumberLast ?? this.samplenum, preSamples, state]);
      }
    } else {
      this.preamble.push([this.samplenumberLast ?? this.samplenum, preSamples, state]);
    }

    if (this.preamble.length === preDetect) {
      if (this.preamble[0]![2] === '1') {
        this.sampleHigh = this.preamble[0]![1];
        this.sampleLow = this.preamble[1]![1];
      } else {
        this.sampleHigh = this.preamble[1]![1];
        this.sampleLow = this.preamble[0]![1];
      }
      this.edgeCount = 0;
      for (let index = 0; index < this.preamble.length; index++) {
        const pulse = this.preamble[index]!;
        if (index > 1) {
          const reference = this.preamble[index - 2]![1];
          if (pulse[1] * 4n > reference * 5n || pulse[1] * 5n < reference * 4n) {
            if (pulse[2] === '1') this.sampleHigh = pulse[1];
            else this.sampleLow = pulse[1];
          }
        }
        if (this.options.decodeas === 'NRZ') this.decodeNrz(pulse[0], pulse[1], pulse[2]);
        if (this.options.decodeas === 'Manchester') this.decodeManchester(pulse[0], pulse[1], pulse[2]);
        if (this.options.decodeas === 'Diff Manchester') {
          this.es = pulse[0] + pulse[1];
          this.decodeDiffManchester(pulse[0], pulse[1], pulse[2]);
        }
        this.sampleFirst = (this.sampleHigh + this.sampleLow) / 2n;
      }
      this.insync = 1;
      this.state = 'DECODING';
    }
    this.lstate = state;
    this.lstate1010 = state;
  }

  private decodeDiffManchester(start: bigint, samples: bigint, state: string): void {
    this.pulseLengths.push(samples);
    const dsamples = state === '1' ? this.sampleHigh : this.sampleLow;
    if (dsamples <= 0n) return;
    this.es = start + samples;
    const pLength = pythonRound(Number(samples) / Number(dsamples));

    if (this.edgeCount === 0) {
      this.diffManTrans = '1';
      this.diffManLen = 1;
      this.ss = start;
    } else if (this.edgeCount % 2 === 1) {
      if (this.options.diffmanvar === '0') this.diffManTrans = this.diffManTrans === '1' ? '0' : '1';
      if (this.diffManLen === 1 && pLength === 1) {
        this.putx(ANN.DIFF_MAN, [this.diffManTrans]);
        this.decoded.push([this.ss, this.es, this.diffManTrans]);
        this.diffManTrans = '1';
      } else if (this.diffManLen === 1 && pLength === 2) {
        this.es -= samples / 2n;
        this.putx(ANN.DIFF_MAN, [this.diffManTrans]);
        this.decoded.push([this.ss, this.es, this.diffManTrans]);
        this.diffManTrans = '0';
        this.edgeCount++;
      } else if (this.diffManLen === 2 && pLength === 1) {
        this.putx(ANN.DIFF_MAN, [this.diffManTrans]);
        this.decoded.push([this.ss, this.es, this.diffManTrans]);
        this.diffManTrans = '1';
      } else if (this.diffManLen === 2 && pLength === 2) {
        this.es -= samples;
        this.putx(ANN.DIFF_MAN, ['E']);
        this.decoded.push([this.ss, this.es, 'E']);
        this.ss = this.es;
        this.es += samples;
        this.putx(ANN.DIFF_MAN, ['E']);
        this.decoded.push([this.ss, this.es, 'E']);
        this.diffManTrans = '1';
      } else if (this.diffManLen === 1 && pLength > 4 && this.state === 'DECODE_TIMEOUT') {
        this.es = this.ss + 2n * this.sampleFirst;
        this.putx(ANN.DIFF_MAN, [this.diffManTrans]);
        this.decoded.push([this.ss, this.es, this.diffManTrans]);
        this.ss = this.decoded[0]![0];
        this.es = this.decoded.at(-1)![1];
        this.dumpPulseLengths();
        if (this.manErrors < this.maxErrors) this.putp(this.decoded);
        else {
          this.ss = this.wordFirst;
          this.putx(ANN.INFO, ['Probably not Diff Manchester encoded']);
        }
        this.decodeTimeout();
      }
      this.ss = this.es;
    }
    this.diffManLen = pLength;
    this.edgeCount++;
  }

  private decodeManchesterSim(
    start: bigint,
    samples: bigint,
    state: string,
    dsamples: number,
    halfTime: number,
    lstate: string | null,
    ss: bigint,
    pream: string,
  ): {
    halfTime: number;
    lstate: string | null;
    ss: bigint;
    bit: MutableOokBit | null;
    errors: number;
  } {
    let bit: MutableOokBit | null = null;
    let errors = 0;
    if (this.edgeCount === 0) halfTime++;
    if (Number(samples) > 0.75 * dsamples && Number(samples) <= 1.5 * dsamples) {
      halfTime += 2;
      let es: bigint;
      if (halfTime % 2 === 0) es = start;
      else es = start + samples / 2n;
      if (ss === start) {
        lstate = 'E';
        es = start + samples;
      }
      if (!(this.edgeCount === 0 && pream === '1010') && lstate !== null) bit = [ss, es, lstate];
      lstate = state;
      ss = es;
    } else if (Number(samples) > 0.25 * dsamples && Number(samples) <= 0.75 * dsamples) {
      halfTime++;
      if (halfTime % 2 === 0) {
        const es = start + samples;
        if (lstate !== null) bit = [ss, es, lstate];
        lstate = state;
        ss = es;
      } else {
        ss = start;
        lstate = state;
      }
    } else {
      errors = 1;
      if (this.state !== 'DECODE_TIMEOUT') {
        lstate = 'E';
        bit = [ss, ss + samples, lstate];
      } else {
        bit = [ss, ss + this.sampleFirst, lstate ?? 'E'];
      }
    }
    return { halfTime, lstate, ss, bit, errors };
  }

  private decodeManchester(start: bigint, samples: bigint, state: string): void {
    this.pulseLengths.push(samples);
    const dsamples = state === '1' ? this.sampleHigh : this.sampleLow;
    if (dsamples <= 0n) return;
    let lastBit: MutableOokBit | null = null;

    if (this.options.preamble !== '1010') {
      const result = this.decodeManchesterSim(
        start,
        samples,
        state,
        Number(dsamples) * 2,
        this.halfTime,
        this.lstate,
        this.ss1111,
        '1111',
      );
      this.halfTime = result.halfTime;
      this.lstate = result.lstate;
      this.ss1111 = result.ss;
      lastBit = result.bit;
      this.manErrors += result.errors;
      if (lastBit) this.decoded.push([...lastBit]);
    }

    if (this.options.preamble !== '1111') {
      const result = this.decodeManchesterSim(
        start,
        samples,
        state,
        Number(dsamples),
        this.halfTime1010,
        this.lstate1010,
        this.ss1010,
        '1010',
      );
      this.halfTime1010 = result.halfTime;
      this.lstate1010 = result.lstate;
      this.ss1010 = result.ss;
      lastBit = result.bit;
      this.manErrors1010 += result.errors;
      if (lastBit) this.decoded1010.push([...lastBit]);
    }
    this.edgeCount++;

    if (lastBit) {
      this.ss = lastBit[0];
      this.es = lastBit[1];
      if (this.options.preamble === '1111') this.putx(ANN.MAN_1111, [lastBit[2]]);
      if (this.options.preamble === '1010') this.putx(ANN.MAN_1010, [lastBit[2]]);
    }

    if (this.state === 'DECODE_TIMEOUT') {
      this.dumpPulseLengths();
      let decoded = this.decoded;
      let errors = this.manErrors;
      let row: number = ANN.MAN_1111;
      if (
        this.options.preamble === '1010' ||
        (this.manErrors1010 < this.maxErrors && this.manErrors1010 < this.manErrors && this.decoded1010.length > 0)
      ) {
        decoded = this.decoded1010;
        errors = this.manErrors1010;
        row = ANN.MAN_1010;
      }
      if (this.options.preamble === 'auto')
        for (const bit of decoded) {
          this.ss = bit[0];
          this.es = bit[1];
          this.putx(row, [bit[2]]);
        }
      if (errors < this.maxErrors && decoded.length > 0) {
        this.ss = decoded[0]![0];
        this.es = decoded.at(-1)![1];
        this.putp(decoded);
      } else {
        this.ss = this.wordFirst;
        this.putx(ANN.INFO, ['Not Manchester encoded or wrong preamble']);
      }
      this.put(this.es, this.es, this.outAnn, [ANN.FRAME, ['T']]);
      this.decodeTimeout();
    }
  }

  private decodeTimeout(): void {
    this.samplenumberLast = null;
    this.edgeCount = 0;
    this.manErrors = 0;
    this.manErrors1010 = 0;
    this.state = 'IDLE';
    this.insync = 0;
    this.preamble = [];
    this.halfTime = -1;
    this.halfTime1010 = 0;
    this.decoded = [];
    this.decoded1010 = [];
    this.pulseLengths = [];
    this.timeoutReset = true;
  }

  *decode(): LogicGenerator {
    while (true) {
      let pin: Pins;
      if (this.edgeCount === 0) {
        pin = yield this.wait({ data: 'e' });
        this.state = 'DECODING';
      } else {
        const timeout = this.sampleFirst > 0n ? 5n * this.sampleFirst : 5n;
        pin = yield this.wait([{ data: 'e' }, { skip: timeout }]);
        if (this.matched?.[1] && !this.matched[0]) this.state = 'DECODE_TIMEOUT';
      }

      if (this.samplenumberLast === null) {
        this.samplenumberLast = this.samplenum;
        this.wordFirst = this.samplenum;
        continue;
      }

      const samples = this.samplenum - this.samplenumberLast;
      if (this.sampleFirst === 0n) this.sampleFirst = samples;
      let pinstate = Number(pin[0] ?? 0);
      if (this.state === 'DECODE_TIMEOUT') pinstate = Number(!pinstate);
      if (this.options.invert === 'yes') pinstate = Number(!pinstate);
      const state = pinstate ? '0' : '1';

      if (this.options.preamlen === '0') {
        this.sampleHigh = this.sampleFirst;
        this.sampleLow = this.sampleFirst;
        this.insync = 0;
      }

      if (this.insync === 0) this.lockOntoPreamble(samples, state);
      else if (this.options.decodeas === 'NRZ') this.decodeNrz(this.samplenumberLast, samples, state);
      else if (this.options.decodeas === 'Manchester') this.decodeManchester(this.samplenumberLast, samples, state);
      else if (this.options.decodeas === 'Diff Manchester')
        this.decodeDiffManchester(this.samplenumberLast, samples, state);

      this.samplenumberLast = this.samplenum;
      if (this.timeoutReset) {
        this.timeoutReset = false;
        yield this.wait({ data: 'e' });
        this.samplenumberLast = this.samplenum;
        this.wordFirst = this.samplenum;
      }
    }
  }
}

export default OokDecoder;
