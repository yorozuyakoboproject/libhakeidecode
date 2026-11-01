import { descriptor } from './descriptor.js';
import {
  Decoder,
  generatorPlugin,
  OUTPUT_ANN,
  OUTPUT_PROTOCOL,
  SRD_CONF_SAMPLERATE,
} from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator } from '../../libhakeidecode/index.js';
import type { DecodeFrame } from '../definition.js';

export interface IRNECOptions {
  polarity: 'auto' | 'active-low' | 'active-high';
  carrier_frequency: number;
  extended: 'yes' | 'no';
}
export interface IRNECFrame extends DecodeFrame {
  kind: 'nec' | 'repeat';
  address: number | null;
  command: number | null;
  addressInverse: number | null;
  commandInverse: number | null;
  valid: boolean;
}
export type IRNECProtocolPacket = ['FRAME', frame: Omit<IRNECFrame, 'ss' | 'es'>] | ['WARNING', message: string];
export const IR_NEC_ANN = Object.freeze({ FRAME: 0, REPEAT: 1, WARNING: 2 });
type ParseState = 'idle' | 'auto-leader' | 'leader-space' | 'repeat-mark' | 'bit-mark' | 'bit-space' | 'stop-mark';

export class IRNECDecoder extends Decoder<IRNECOptions> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outProtocol = -1;
  private outAnn = -1;
  private state: ParseState = 'idle';
  private activeLevel: number | null = null;
  private frameStart: bigint | null = null;
  private autoLevel = 0;
  private autoStart: bigint | null = null;
  private bits: number[] = [];
  private markDuration = 0;
  private carrierBurst = false;
  private carrierStart: bigint | null = null;
  private carrierLastEnd: bigint | null = null;
  private carrierSeen = false;

  constructor(options: Partial<IRNECOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.state = 'idle';
    this.activeLevel = this.options.polarity === 'active-low' ? 0 : this.options.polarity === 'active-high' ? 1 : null;
    this.frameStart = null;
    this.autoLevel = 0;
    this.autoStart = null;
    this.bits = [];
    this.markDuration = 0;
    this.carrierBurst = false;
    this.carrierStart = null;
    this.carrierLastEnd = null;
    this.carrierSeen = false;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'ir-nec');
    this.outAnn = this.register(OUTPUT_ANN);
    if (!(this.options.carrier_frequency >= 0) || !Number.isFinite(this.options.carrier_frequency))
      throw new Error('Invalid IR carrier frequency.');
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private seconds(samples: number): number {
    return samples / (this.samplerate ?? 1);
  }

  private between(duration: number, min: number, max: number): boolean {
    return duration >= min && duration <= max;
  }

  private leader(duration: number): boolean {
    return this.between(duration, 7.5e-3, 10.5e-3);
  }

  private shortMark(duration: number): boolean {
    return this.between(duration, 0.32e-3, 1.0e-3);
  }

  private warning(message: string, ss = this.samplenum, es = this.samplenum): void {
    this.put(ss, es, this.outAnn, [IR_NEC_ANN.WARNING, [message]]);
    this.put(ss, es, this.outProtocol, ['WARNING', message]);
  }

  private discard(message: string): void {
    if (this.state !== 'idle') this.warning(message);
    this.state = 'idle';
    this.frameStart = null;
    this.bits = [];
    this.markDuration = 0;
    this.autoStart = null;
  }

  private emitRepeat(ss: bigint, es: bigint): void {
    const frame: Omit<IRNECFrame, 'ss' | 'es'> = {
      kind: 'repeat',
      address: null,
      command: null,
      addressInverse: null,
      commandInverse: null,
      valid: true,
    };
    this.put(ss, es, this.outAnn, [IR_NEC_ANN.REPEAT, ['Repeat']]);
    this.put(ss, es, this.outProtocol, ['FRAME', frame]);
  }

  private emitBits(ss: bigint, es: bigint): void {
    let value = 0;
    for (let bit = 0; bit < 32; bit++) value += this.bits[bit]! * 2 ** bit;
    let frame: Omit<IRNECFrame, 'ss' | 'es'>;
    if (this.options.extended === 'yes') {
      const command = (value >>> 16) & 0xff,
        commandInverse = (value >>> 24) & 0xff;
      frame = {
        kind: 'nec',
        address: value & 0xffff,
        command,
        addressInverse: null,
        commandInverse,
        valid: (command ^ commandInverse) === 0xff,
      };
    } else {
      const address = value & 0xff,
        addressInverse = (value >>> 8) & 0xff,
        command = (value >>> 16) & 0xff,
        commandInverse = (value >>> 24) & 0xff;
      frame = {
        kind: 'nec',
        address,
        command,
        addressInverse,
        commandInverse,
        valid: (address ^ addressInverse) === 0xff && (command ^ commandInverse) === 0xff,
      };
    }
    this.put(ss, es, this.outAnn, [IR_NEC_ANN.FRAME, [frame.valid ? 'NEC frame' : 'Invalid NEC frame'], value >>> 0]);
    this.put(ss, es, this.outProtocol, ['FRAME', frame]);
  }

  private consumeRun(mark: boolean, samples: number, ss: bigint, es: bigint): void {
    const duration = this.seconds(samples);
    if (duration >= 20e-3 && this.state !== 'idle') {
      if (this.state === 'stop-mark') this.state = 'idle';
      else this.discard('Interrupted by an idle period');
      return;
    }
    if (mark) {
      if ((this.state === 'idle' || this.state === 'stop-mark') && this.leader(duration)) {
        this.state = 'leader-space';
        this.frameStart = ss;
      } else if (this.state === 'stop-mark') {
        return;
      } else if (this.state === 'repeat-mark' && this.shortMark(duration)) {
        this.emitRepeat(this.frameStart ?? ss, es);
        this.state = 'idle';
        this.frameStart = null;
      } else if (this.state === 'bit-mark' && this.shortMark(duration)) {
        this.markDuration = duration;
        this.state = 'bit-space';
      } else if (this.state !== 'idle') this.discard('Unexpected IR mark duration');
      return;
    }
    if (this.state === 'leader-space') {
      if (this.between(duration, 3.5e-3, 5.5e-3)) {
        this.bits = [];
        this.state = 'bit-mark';
      } else if (this.between(duration, 1.8e-3, 2.8e-3)) this.state = 'repeat-mark';
      else this.discard('Invalid NEC leader space');
    } else if (this.state === 'bit-space') {
      if (!this.shortMark(this.markDuration)) {
        this.discard('Invalid NEC bit mark');
        return;
      }
      if (this.between(duration, 0.32e-3, 1.0e-3)) this.bits.push(0);
      else if (this.between(duration, 1.25e-3, 2.1e-3)) this.bits.push(1);
      else {
        this.discard('Invalid NEC bit space');
        return;
      }
      if (this.bits.length === 32) {
        this.emitBits(this.frameStart ?? ss, es);
        this.state = 'stop-mark';
        this.frameStart = null;
      } else this.state = 'bit-mark';
    }
  }

  private consumeLevelRun(level: number, samples: number, ss: bigint, es: bigint): void {
    const duration = this.seconds(samples);
    if (this.activeLevel === null) {
      if (this.state === 'auto-leader') {
        if (
          level !== this.autoLevel &&
          (this.between(duration, 3.5e-3, 5.5e-3) || this.between(duration, 1.8e-3, 2.8e-3))
        ) {
          this.activeLevel = this.autoLevel;
          this.frameStart = this.autoStart;
          this.state = this.between(duration, 3.5e-3, 5.5e-3) ? 'bit-mark' : 'repeat-mark';
          if (this.state === 'bit-mark') this.bits = [];
          this.autoStart = null;
        } else this.discard('Automatic polarity detection failed');
        return;
      }
      if (this.leader(duration)) {
        this.state = 'auto-leader';
        this.autoLevel = level;
        this.autoStart = ss;
        return;
      }
      return;
    }
    this.consumeRun(level === this.activeLevel, samples, ss, es);
  }

  private consumeRaw(level: number, samples: number, ss: bigint, es: bigint): void {
    const frequency = this.options.carrier_frequency;
    if (!(frequency > 0)) {
      this.consumeLevelRun(level, samples, ss, es);
      return;
    }
    const threshold = Math.max(2, Math.round((this.samplerate ?? 1) / frequency) * 4);
    if (samples <= threshold) {
      this.carrierSeen = true;
      if (!this.carrierBurst) {
        this.carrierBurst = true;
        this.carrierStart = ss;
      }
      this.carrierLastEnd = es;
      return;
    }
    if (!this.carrierSeen) {
      this.consumeLevelRun(level, samples, ss, es);
      return;
    }
    if (this.carrierBurst) {
      const start = this.carrierStart ?? ss,
        end = this.carrierLastEnd ?? es;
      this.carrierBurst = false;
      this.carrierStart = null;
      this.carrierLastEnd = null;
      this.consumeRun(true, Number(end - start), start, end);
    }
    this.consumeRun(false, samples, ss, es);
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    let pins = yield this.wait();
    let level = Number(pins[0]),
      runStart = this.samplenum;
    while (true) {
      pins = yield this.wait({ ir: 'e' });
      const next = Number(pins[0]),
        now = this.samplenum,
        samples = Number(now - runStart);
      this.consumeRaw(level, samples, runStart, now);
      level = next;
      runStart = now;
    }
  }

  onEof(): void {
    if (this.carrierBurst && this.carrierStart !== null && this.carrierLastEnd !== null)
      this.consumeRun(true, Number(this.carrierLastEnd - this.carrierStart), this.carrierStart, this.carrierLastEnd);
    if (this.state !== 'idle' && this.state !== 'stop-mark')
      this.warning('Incomplete NEC frame discarded at end of capture');
  }
}

export const irNecPlugin: DecoderPlugin<any, any> = {
  decoder: IRNECDecoder,
  descriptor,
  createEngine: (context) => generatorPlugin(IRNECDecoder).createEngine(context),
};

export default IRNECDecoder;
