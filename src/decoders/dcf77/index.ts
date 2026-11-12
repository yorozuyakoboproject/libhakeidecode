import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pins } from '../../libhakeidecode/index.js';
import { bcd2int } from '../common.js';
import { descriptor } from './descriptor.js';

export type Dcf77Options = Record<string, never>;

const ANN = Object.freeze({
  START_OF_MINUTE: 0,
  SPECIAL_BITS: 1,
  CALL: 2,
  SUMMER_ANNOUNCEMENT: 3,
  CEST: 4,
  CET: 5,
  LEAP_SECOND: 6,
  START_OF_TIME: 7,
  MINUTE: 8,
  MINUTE_PARITY: 9,
  HOUR: 10,
  HOUR_PARITY: 11,
  DAY: 12,
  WEEKDAY: 13,
  MONTH: 14,
  YEAR: 15,
  DATE_PARITY: 16,
  RAW: 17,
  UNKNOWN: 18,
  WARNING: 19,
});

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export class Dcf77Decoder extends Decoder<Dcf77Options> {
  static descriptor = descriptor;

  private outAnn = -1;
  private samplerate: number | null = null;
  private ssBit = 0n;
  private ssBitOld = 0n;
  private esBit = 0n;
  private ssBlock = 0n;
  private datebits: number[] = [];
  private bitCount = 0;
  private bitNumberKnown = false;
  private tmp = 0;

  constructor(options: Partial<Dcf77Options> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.ssBit = 0n;
    this.ssBitOld = 0n;
    this.esBit = 0n;
    this.ssBlock = 0n;
    this.datebits = [];
    this.bitCount = 0;
    this.bitNumberKnown = false;
    this.tmp = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private putx(data: readonly [number, readonly string[]]): void {
    this.put(this.ssBit, this.esBit, this.outAnn, data);
  }

  private putb(data: readonly [number, readonly string[]]): void {
    this.put(this.ssBlock, this.samplenum, this.outAnn, data);
  }

  private handleBit(bit: number): void {
    const count = this.bitCount;
    const prefix = this.bitNumberKnown ? 'Bit' : 'Unknown bit';
    this.putx([this.bitNumberKnown ? ANN.RAW : ANN.UNKNOWN, [`${prefix} ${count}: ${bit}`, String(bit)]]);
    if (!this.bitNumberKnown) return;

    if (count >= 36 && count <= 58) this.datebits.push(bit);

    if (count === 0) {
      if (bit === 0) this.putx([ANN.START_OF_MINUTE, ['Start of minute (always 0)', 'Start of minute', 'SoM']]);
      else this.putx([ANN.WARNING, ['Start of minute != 0', 'SoM != 0']]);
    } else if (count <= 14) {
      if (count === 1) {
        this.tmp = bit;
        this.ssBlock = this.ssBit;
      } else this.tmp |= bit << (count - 1);
      if (count === 14) {
        const bits = this.tmp.toString(2).padStart(14, '0');
        this.putb([ANN.SPECIAL_BITS, [`Special bits: ${bits}`, `SB: ${bits}`]]);
      }
    } else if (count === 15) {
      const not = bit === 1 ? '' : 'not ';
      this.putx([ANN.CALL, [`Call bit: ${not}set`, `CB: ${not}set`]]);
    } else if (count === 16) {
      const not = bit === 1 ? '' : 'not ';
      const yes = bit === 1 ? 'yes' : 'no';
      this.putx([
        ANN.SUMMER_ANNOUNCEMENT,
        [`Summer time announcement: ${not}active`, `Summer time: ${not}active`, `Summer time: ${yes}`, `ST: ${yes}`],
      ]);
    } else if (count === 17) {
      const not = bit === 1 ? '' : 'not ';
      const yes = bit === 1 ? 'yes' : 'no';
      this.putx([ANN.CEST, [`CEST: ${not}in effect`, `CEST: ${yes}`]]);
    } else if (count === 18) {
      const not = bit === 1 ? '' : 'not ';
      const yes = bit === 1 ? 'yes' : 'no';
      this.putx([ANN.CET, [`CET: ${not}in effect`, `CET: ${yes}`]]);
    } else if (count === 19) {
      const not = bit === 1 ? '' : 'not ';
      const yes = bit === 1 ? 'yes' : 'no';
      this.putx([
        ANN.LEAP_SECOND,
        [`Leap second announcement: ${not}active`, `Leap second: ${not}active`, `Leap second: ${yes}`, `LS: ${yes}`],
      ]);
    } else if (count === 20) {
      if (bit === 1)
        this.putx([ANN.START_OF_TIME, ['Start of encoded time (always 1)', 'Start of encoded time', 'SoeT']]);
      else this.putx([ANN.WARNING, ['Start of encoded time != 1', 'SoeT != 1']]);
    } else if (count <= 27) {
      if (count === 21) {
        this.tmp = bit;
        this.ssBlock = this.ssBit;
      } else this.tmp |= bit << (count - 21);
      if (count === 27) {
        const minute = bcd2int(this.tmp);
        this.putb([ANN.MINUTE, [`Minutes: ${minute}`, `Min: ${minute}`]]);
      }
    } else if (count === 28) {
      this.tmp |= bit << 7;
      const parity = this.tmp.toString(2).replaceAll('0', '').length;
      const state = parity % 2 === 0 ? 'OK' : 'INVALID!';
      this.putx([ANN.MINUTE_PARITY, [`Minute parity: ${state}`, `Min parity: ${state}`]]);
    } else if (count <= 34) {
      if (count === 29) {
        this.tmp = bit;
        this.ssBlock = this.ssBit;
      } else this.tmp |= bit << (count - 29);
      if (count === 34) this.putb([ANN.HOUR, [`Hours: ${bcd2int(this.tmp)}`]]);
    } else if (count === 35) {
      this.tmp |= bit << 6;
      const parity = this.tmp.toString(2).replaceAll('0', '').length;
      const state = parity % 2 === 0 ? 'OK' : 'INVALID!';
      this.putx([ANN.HOUR_PARITY, [`Hour parity: ${state}`]]);
    } else if (count <= 41) {
      if (count === 36) {
        this.tmp = bit;
        this.ssBlock = this.ssBit;
      } else this.tmp |= bit << (count - 36);
      if (count === 41) this.putb([ANN.DAY, [`Day: ${bcd2int(this.tmp)}`]]);
    } else if (count <= 44) {
      if (count === 42) {
        this.tmp = bit;
        this.ssBlock = this.ssBit;
      } else this.tmp |= bit << (count - 42);
      if (count === 44) {
        const day = bcd2int(this.tmp);
        const name = this.weekdayName(day);
        if (name !== null) this.putb([ANN.WEEKDAY, [`Day of week: ${day} (${name})`, `DoW: ${day} (${name})`]]);
        else this.putb([ANN.WARNING, [`Day of week: ${day} (invalid)`, `DoW: ${day} (inv)`]]);
      }
    } else if (count <= 49) {
      if (count === 45) {
        this.tmp = bit;
        this.ssBlock = this.ssBit;
      } else this.tmp |= bit << (count - 45);
      if (count === 49) {
        const month = bcd2int(this.tmp);
        const name = this.monthName(month);
        if (name !== null) this.putb([ANN.MONTH, [`Month: ${month} (${name})`, `Mon: ${month} (${name})`]]);
        else this.putb([ANN.WARNING, [`Month: ${month} (invalid)`, `Mon: ${month} (inv)`]]);
      }
    } else if (count <= 57) {
      if (count === 50) {
        this.tmp = bit;
        this.ssBlock = this.ssBit;
      } else this.tmp |= bit << (count - 50);
      if (count === 57) this.putb([ANN.YEAR, [`Year: ${bcd2int(this.tmp)}`]]);
    } else if (count === 58) {
      const parity = this.datebits.reduce((ones, value) => ones + value, 0);
      const state = parity % 2 === 0 ? 'OK' : 'INVALID!';
      this.putx([ANN.DATE_PARITY, [`Date parity: ${state}`, `DP: ${state}`]]);
      this.datebits = [];
    } else {
      this.putx([ANN.WARNING, [`Invalid DCF77 bit: ${count}`, `Invalid bit: ${count}`, `Inv: ${count}`]]);
    }
  }

  private weekdayName(day: number): string | null {
    return day >= 0 && day <= 7 ? DAY_NAMES[(day + 6) % 7]! : null;
  }

  private monthName(month: number): string | null {
    return month >= 0 && month <= 12 ? MONTH_NAMES[month]! : null;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    while (true) {
      let pins: Pins = yield this.wait({ data: 'r' });
      this.ssBit = this.samplenum;
      const elapsedMs = Math.trunc((Number(this.ssBit - this.ssBitOld) / this.samplerate) * 1000);
      if (elapsedMs >= 1600 && elapsedMs <= 2400) {
        this.bitCount = 0;
        this.ssBitOld = this.ssBit;
        this.bitNumberKnown = true;
      }
      this.ssBitOld = this.ssBit;

      pins = yield this.wait({ data: 'f' });
      this.esBit = this.samplenum;
      const highMs = Math.trunc((Number(this.esBit - this.ssBit) / this.samplerate) * 1000);
      let bit = -1;
      if (highMs >= 40 && highMs <= 160) bit = 0;
      else if (highMs >= 161 && highMs <= 260) bit = 1;
      if (bit === 0 || bit === 1) {
        this.handleBit(bit);
        this.bitCount++;
      } else this.putx([ANN.WARNING, ['Invalid bit timing', 'Inv timing', 'Inv']]);
      void pins;
    }
  }
}

export default Dcf77Decoder;
