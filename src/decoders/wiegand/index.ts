import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface WiegandOptions {
  active: 'low' | 'high';
  bitwidth_ms: number;
}

export class WiegandDecoder extends Decoder<WiegandOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private samplerate: number | null = null;
  private samplesPerBit = 10;
  private active = 0;
  private inactive = 1;
  private d0Previous: number | null = null;
  private d1Previous: number | null = null;
  private state: 'data' | 'invalid' | 'idle' | null = null;
  private stateStart: bigint | null = null;
  private bitStart: bigint | null = null;
  private bitEnd: bigint | null = null;
  private bit: number | null = null;
  private bits: number[] = [];

  override reset(): void {
    this.samplerate = null;
    this.d0Previous = null;
    this.d1Previous = null;
    this.state = null;
    this.stateStart = null;
    this.bitStart = null;
    this.bitEnd = null;
    this.bit = null;
    this.bits = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.active = this.options.active === 'high' ? 1 : 0;
    this.inactive = this.active ^ 1;
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    const millisecondsPerSample = 1000 / value;
    this.samplesPerBit = Math.max(1, Math.floor(this.options.bitwidth_ms / millisecondsPerSample));
  }

  private updateState(state: 'data' | 'invalid' | 'idle', bit: number | null): void {
    const now = this.samplenum;
    if (this.bit !== null) {
      this.bits.push(this.bit);
      if (this.bitStart !== null) this.put(this.bitStart, now, this.outAnn, [0, [String(this.bit)]]);
    }
    this.bit = bit;
    this.bitStart = now;
    this.bitEnd = bit === null ? null : now + BigInt(this.samplesPerBit);

    if (state === this.state) return;
    if (this.state === 'data') {
      const value = this.bits.join('');
      this.put(this.stateStart ?? now, now, this.outAnn, [
        1,
        [`${this.bits.length} bits ${value}`, `${this.bits.length} bits`],
      ]);
    } else if (this.state === 'invalid') {
      this.put(this.stateStart ?? now, now, this.outAnn, [1, ['invalid']]);
    }
    this.stateStart = now;
    this.state = state;
    this.bits = [];
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    while (true) {
      const pins = yield this.wait();
      const d0 = Number(pins[0]);
      const d1 = Number(pins[1]);
      if (d0 === this.d0Previous && d1 === this.d1Previous) {
        if (this.bitEnd !== null && this.samplenum >= this.bitEnd)
          this.updateState(d0 === this.inactive && d1 === this.inactive ? 'idle' : 'invalid', null);
        continue;
      }

      if (this.state === null || this.state === 'idle' || this.state === 'data') {
        if (d0 === this.active && d1 === this.inactive) this.updateState('data', 0);
        else if (d0 === this.inactive && d1 === this.active) this.updateState('data', 1);
        else if (d0 === this.active && d1 === this.active) this.updateState('invalid', null);
      } else if (this.state === 'invalid' && d0 === this.inactive && d1 === this.inactive) {
        this.updateState('idle', null);
      }

      this.d0Previous = d0;
      this.d1Previous = d1;
    }
  }
}

export default WiegandDecoder;
