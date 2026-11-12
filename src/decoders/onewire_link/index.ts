import { descriptor } from './descriptor.js';
import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';

export interface OnewireLinkOptions {
  overdrive: 'yes' | 'no';
}

export type OnewireLinkPacket = ['BIT', number] | ['RESET/PRESENCE', boolean];

const ANN = Object.freeze({ BIT: 0, WARNING: 1, RESET: 2, PRESENCE: 3, OVERDRIVE: 4 });

const timing = {
  RSTL: { min: [480, 48], max: [960, 80] },
  RSTH: { min: [480, 48] },
  PDH: { min: [15, 2], max: [60, 6] },
  PDL: { min: [60, 8], max: [240, 24] },
  SLOT: { min: [60, 6], max: [120, 16] },
  REC: { min: [1, 1] },
  LOWR: { min: [1, 1], max: [15, 2] },
} as const;

type State = 'INITIAL' | 'IDLE' | 'LOW' | 'SLOT' | 'PRESENCE DETECT HIGH' | 'PRESENCE DETECT LOW' | 'PRESENCE DETECT';

function value(range: readonly [number, number], overdrive: boolean): number {
  return range[overdrive ? 1 : 0];
}

function shown(value: number): string {
  return value.toFixed(1);
}

export class OnewireLinkDecoder extends Decoder<OnewireLinkOptions> {
  static descriptor = descriptor;

  samplerate: number | null = null;
  private outAnn = -1;
  private outProtocol = -1;
  private state: State = 'INITIAL';
  private bit = 0;
  private bitCount = -1;
  private command = 0;
  private overdrive = false;
  private fall = 0n;
  private rise = 0n;

  constructor(options: Partial<OnewireLinkOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.state = 'INITIAL';
    this.bit = 0;
    this.bitCount = -1;
    this.command = 0;
    this.overdrive = false;
    this.fall = 0n;
    this.rise = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'onewire_link');
    this.outAnn = this.register(OUTPUT_ANN);
    this.overdrive = this.options.overdrive === 'yes';
    this.fall = 0n;
    this.rise = 0n;
    this.bitCount = -1;
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private announcement(ss: bigint, es: bigint, data: readonly [number, readonly string[]]): void {
    this.put(ss, es, this.outAnn, data);
  }

  private putm(data: readonly [number, readonly string[]]): void {
    this.announcement(0n, 0n, data);
  }

  private putpfs(data: OnewireLinkPacket): void {
    this.put(this.fall, this.samplenum, this.outProtocol, data);
  }

  private putfs(data: readonly [number, readonly string[]]): void {
    this.announcement(this.fall, this.samplenum, data);
  }

  private putfr(data: readonly [number, readonly string[]]): void {
    this.announcement(this.fall, this.rise, data);
  }

  private putprs(data: OnewireLinkPacket): void {
    this.put(this.rise, this.samplenum, this.outProtocol, data);
  }

  private putrs(data: readonly [number, readonly string[]]): void {
    this.announcement(this.rise, this.samplenum, data);
  }

  private checks(): void {
    if (!this.samplerate) return;
    if (this.options.overdrive === 'yes') {
      if (this.samplerate < 2_000_000) {
        this.putm([ANN.WARNING, ['Sampling rate is too low. Must be above 2MHz for proper overdrive mode decoding.']]);
      } else if (this.samplerate < 5_000_000) {
        this.putm([ANN.WARNING, ['Sampling rate is suggested to be above 5MHz for proper overdrive mode decoding.']]);
      }
    } else if (this.samplerate < 400_000) {
      this.putm([ANN.WARNING, ['Sampling rate is too low. Must be above 400kHz for proper normal mode decoding.']]);
    } else if (this.samplerate < 1_000_000) {
      this.putm([ANN.WARNING, ['Sampling rate is suggested to be above 1MHz for proper normal mode decoding.']]);
    }
  }

  private *waitFallingTimeout(start: bigint, microseconds: number): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    const count = Math.trunc((microseconds / 1_000_000) * this.samplerate);
    const skip = start + BigInt(count) - this.samplenum;
    yield this.wait([{ owr: 'f' }, { skip: skip > 0n ? skip : 0n }]);
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    this.checks();
    while (true) {
      if (this.state === 'INITIAL') {
        yield this.wait({ owr: 'h' });
        this.rise = this.samplenum;
        this.state = 'IDLE';
      } else if (this.state === 'IDLE') {
        yield this.wait({ owr: 'f' });
        this.fall = this.samplenum;
        const elapsed = Number(this.fall - this.rise) / this.samplerate;
        if (this.rise > 0n && elapsed * 1_000_000 < value(timing.REC.min, this.overdrive)) {
          this.putfr([
            ANN.WARNING,
            [
              'Recovery time not long enoughRecovery too short',
              'REC < ' + shown(value(timing.REC.min, this.overdrive)),
            ],
          ]);
        }
        this.state = 'LOW';
      } else if (this.state === 'LOW') {
        yield this.wait({ owr: 'r' });
        this.rise = this.samplenum;
        const elapsed = Number(this.rise - this.fall) / this.samplerate;
        const low = elapsed * 1_000_000;
        if (low >= value(timing.RSTL.min, false)) {
          if (low > value(timing.RSTL.max, false)) {
            this.putfr([
              ANN.WARNING,
              [
                'Too long reset pulse might mask interrupt signalling by other devices',
                'Reset pulse too long',
                'RST > ' + shown(value(timing.RSTL.max, false)),
              ],
            ]);
          }
          if (this.overdrive) this.putfr([ANN.OVERDRIVE, ['Exiting overdrive mode', 'Overdrive off']]);
          this.overdrive = false;
          this.putfr([ANN.RESET, ['Reset', 'Rst', 'R']]);
          this.state = 'PRESENCE DETECT HIGH';
        } else if (
          this.overdrive &&
          low >= value(timing.RSTL.min, this.overdrive) &&
          low < value(timing.RSTL.max, this.overdrive)
        ) {
          this.putfr([ANN.RESET, ['Reset', 'Rst', 'R']]);
          this.state = 'PRESENCE DETECT HIGH';
        } else if (low < value(timing.SLOT.max, this.overdrive)) {
          if (low < value(timing.LOWR.min, this.overdrive)) {
            this.putfr([
              ANN.WARNING,
              ['Low signal not long enough', 'Low too short', 'LOW < ' + shown(value(timing.LOWR.min, this.overdrive))],
            ]);
          }
          this.bit = low < value(timing.LOWR.max, this.overdrive) ? 1 : 0;
          this.state = 'SLOT';
        } else {
          this.putfr([ANN.WARNING, ['Erroneous signal', 'Error', 'Err', 'E']]);
          this.state = 'IDLE';
        }
      } else if (this.state === 'PRESENCE DETECT HIGH') {
        yield* this.waitFallingTimeout(this.rise, value(timing.PDH.max, this.overdrive));
        const elapsed = Number(this.samplenum - this.rise) / this.samplerate;
        const high = elapsed * 1_000_000;
        if (this.matched?.[0] && !this.matched[1]) {
          if (high < value(timing.PDH.min, this.overdrive)) {
            this.putrs([
              ANN.WARNING,
              [
                'Presence detect signal is too early',
                'Presence detect too early',
                'PDH < ' + shown(value(timing.PDH.min, this.overdrive)),
              ],
            ]);
          }
          this.fall = this.samplenum;
          this.state = 'PRESENCE DETECT LOW';
        } else {
          this.putrs([ANN.PRESENCE, ['Presence: false', 'Presence', 'Pres', 'P']]);
          this.putprs(['RESET/PRESENCE', false]);
          this.state = 'IDLE';
        }
      } else if (this.state === 'PRESENCE DETECT LOW') {
        yield this.wait({ owr: 'r' });
        const elapsed = Number(this.samplenum - this.fall) / this.samplerate;
        const low = elapsed * 1_000_000;
        if (low < value(timing.PDL.min, this.overdrive)) {
          this.putfs([
            ANN.WARNING,
            [
              'Presence detect signal is too short',
              'Presence detect too short',
              'PDL < ' + shown(value(timing.PDL.min, this.overdrive)),
            ],
          ]);
        } else if (low > value(timing.PDL.max, this.overdrive)) {
          this.putfs([
            ANN.WARNING,
            [
              'Presence detect signal is too long',
              'Presence detect too long',
              'PDL > ' + shown(value(timing.PDL.max, this.overdrive)),
            ],
          ]);
        }
        if (low > value(timing.RSTH.min, this.overdrive)) this.rise = this.samplenum;
        this.state = 'PRESENCE DETECT';
      }

      if (this.state === 'SLOT') {
        yield* this.waitFallingTimeout(this.fall, value(timing.SLOT.min, this.overdrive));
        if (this.matched?.[0] && !this.matched[1]) {
          this.putfs([
            ANN.WARNING,
            ['Time slot not long enough', 'Slot too short', 'SLOT < ' + shown(value(timing.SLOT.min, this.overdrive))],
          ]);
          this.fall = this.samplenum;
          this.state = 'LOW';
        } else {
          this.putfs([ANN.BIT, ['Bit: ' + this.bit, String(this.bit)]]);
          this.putpfs(['BIT', this.bit]);
          if (this.bitCount >= 0) {
            this.command += this.bit << this.bitCount;
            this.bitCount++;
          }
          if (this.bitCount >= 8) {
            if (this.command === 0x3c || this.command === 0x69) {
              this.overdrive = true;
              this.announcement(this.samplenum, this.samplenum, [
                ANN.OVERDRIVE,
                ['Entering overdrive mode', 'Overdrive on'],
              ]);
            }
            this.bitCount = -1;
          }
          this.state = 'IDLE';
        }
      }

      if (this.state === 'PRESENCE DETECT') {
        yield* this.waitFallingTimeout(this.rise, value(timing.RSTH.min, this.overdrive));
        if (this.matched?.[0] && !this.matched[1]) {
          this.putfs([
            ANN.WARNING,
            [
              'Presence detect not long enough',
              'Presence detect too short',
              'RTSH < ' + shown(value(timing.RSTH.min, this.overdrive)),
            ],
          ]);
          this.putrs([ANN.PRESENCE, ['Slave presence detected', 'Slave present', 'Present', 'P']]);
          this.putprs(['RESET/PRESENCE', true]);
          this.fall = this.samplenum;
          this.state = 'LOW';
        } else {
          this.putrs([ANN.PRESENCE, ['Presence: true', 'Presence', 'Pres', 'P']]);
          this.putprs(['RESET/PRESENCE', true]);
          this.rise = this.samplenum;
          this.bitCount = 0;
          this.command = 0;
          this.state = 'IDLE';
        }
      }
    }
  }
}

export default OnewireLinkDecoder;
