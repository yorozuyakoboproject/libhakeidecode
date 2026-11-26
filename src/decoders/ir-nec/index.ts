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
export const IR_NEC_ANN = Object.freeze({
  BIT: 0,
  AGC_PULSE: 1,
  LONG_PAUSE: 2,
  SHORT_PAUSE: 3,
  STOP_BIT: 4,
  LEADER_CODE: 5,
  ADDR: 6,
  ADDR_INV: 7,
  CMD: 8,
  CMD_INV: 9,
  REPEAT_CODE: 10,
  REMOTE: 11,
  WARNING: 12,
});
const REMOTE_DEVICES: Readonly<Record<number, string>> = {
  0x00: 'Joy-it SBC-IRC01',
  0x40: 'Matsui TV',
  0xea41: 'LED Panel',
};
const REMOTE_COMMANDS: Readonly<Record<number, Readonly<Record<number, readonly [string, string]>>>> = {
  0x00: {
    0x45: ['Volume down', 'Vol-'],
    0x46: ['Play/Pause', 'P/P'],
    0x47: ['Volume up', 'Vol+'],
    0x44: ['Setup', 'Set'],
    0x40: ['Up', 'U'],
    0x43: ['Stop / Mode', 'S/M'],
    0x07: ['Left', 'L'],
    0x15: ['Enter', 'E'],
    0x09: ['Right', 'R'],
    0x16: ['0 / 10+', '0'],
    0x19: ['Down', 'D'],
    0x0d: ['Back', 'B'],
    0x0c: ['1', '1'],
    0x18: ['2', '2'],
    0x5e: ['3', '3'],
    0x08: ['4', '4'],
    0x1c: ['5', '5'],
    0x5a: ['6', '6'],
    0x42: ['7', '7'],
    0x52: ['8', '8'],
    0x4a: ['9', '9'],
  },
  0x40: {
    0: ['0', '0'],
    1: ['1', '1'],
    2: ['2', '2'],
    3: ['3', '3'],
    4: ['4', '4'],
    5: ['5', '5'],
    6: ['6', '6'],
    7: ['7', '7'],
    8: ['8', '8'],
    9: ['9', '9'],
    11: ['-/--', '-/--'],
    16: ['Mute', 'M'],
    18: ['Standby', 'StBy'],
    26: ['Volume up', 'Vol+'],
    27: ['Program up', 'P+'],
    30: ['Volume down', 'Vol-'],
    31: ['Program down', 'P-'],
    68: ['AV', 'AV'],
  },
  0xea41: {
    0x10: ['Warmer', 'T+'],
    0x11: ['Colder', 'T-'],
    0x12: ['Brighter', '+'],
    0x13: ['Darker', '-'],
    0x14: ['Off', 'O'],
    0x15: ['On', 'I'],
    0x41: ['Min Brightness', 'Min'],
    0x48: ['Max Brightness', 'Max'],
  },
};
type ParseState = 'idle' | 'auto-leader' | 'leader-space' | 'repeat-mark' | 'bit-mark' | 'bit-space' | 'stop-mark';

export class IRNECDecoder extends Decoder<IRNECOptions> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outProtocol = -1;
  private outAnn = -1;
  private state: ParseState = 'idle';
  private activeLevel: number | null = null;
  private frameStart: bigint | null = null;
  private agcEnd: bigint | null = null;
  private bitStart: bigint | null = null;
  private autoLevel = 0;
  private autoStart: bigint | null = null;
  private autoEnd: bigint | null = null;
  private bits: number[] = [];
  private bitRanges: Array<readonly [bigint, bigint]> = [];
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
    this.agcEnd = null;
    this.bitStart = null;
    this.autoLevel = 0;
    this.autoStart = null;
    this.autoEnd = null;
    this.bits = [];
    this.bitRanges = [];
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
    this.agcEnd = null;
    this.bitStart = null;
    this.bits = [];
    this.bitRanges = [];
    this.markDuration = 0;
    this.autoStart = null;
    this.autoEnd = null;
  }

  private emitLeader(ss: bigint, agcEnd: bigint, es: bigint, kind: 'Long' | 'Short'): void {
    this.put(ss, agcEnd, this.outAnn, [IR_NEC_ANN.AGC_PULSE, ['AGC pulse', 'AGC', 'A']]);
    this.put(agcEnd, es, this.outAnn, [
      kind === 'Long' ? IR_NEC_ANN.LONG_PAUSE : IR_NEC_ANN.SHORT_PAUSE,
      [`${kind} pause`, `${kind[0]}-pause`, `${kind[0]}P`, 'P'],
    ]);
    if (kind === 'Long') {
      this.put(ss, es, this.outAnn, [IR_NEC_ANN.LEADER_CODE, ['Leader code', 'Leader', 'LC', 'L']]);
    }
  }

  private emitRepeat(ss: bigint, agcEnd: bigint | null, pauseEnd: bigint, es: bigint): void {
    const frame: Omit<IRNECFrame, 'ss' | 'es'> = {
      kind: 'repeat',
      address: null,
      command: null,
      addressInverse: null,
      commandInverse: null,
      valid: true,
    };
    if (agcEnd !== null && agcEnd > ss && pauseEnd > agcEnd) {
      this.emitLeader(ss, agcEnd, pauseEnd, 'Short');
    }
    if (es > pauseEnd) {
      this.put(pauseEnd, es, this.outAnn, [IR_NEC_ANN.STOP_BIT, ['Stop bit', 'Stop', 'St', 'S']]);
    }
    this.put(ss, es, this.outAnn, [IR_NEC_ANN.REPEAT_CODE, ['Repeat code', 'Repeat', 'RC', 'R']]);
    this.put(ss, es, this.outProtocol, ['FRAME', frame]);
  }

  private emitBits(ss: bigint, es: bigint): void {
    let value = 0;
    for (let bit = 0; bit < 32; bit++) value += this.bits[bit]! * 2 ** bit;
    const extended = this.options.extended === 'yes';
    let address = 0,
      addressInverse: number | null = null,
      command = 0,
      commandInverse = 0,
      valid = true;
    const packByte = (offset: number, count: number): number => {
      let out = 0;
      for (let i = 0; i < count; i++) out += this.bits[offset + i]! * 2 ** i;
      return out;
    };
    const putField = (
      cls: number,
      longName: string,
      short1: string,
      short2: string,
      val: number,
      bits: number,
      fromIdx: number,
      toIdx: number,
    ): void => {
      const fss = this.bitRanges[fromIdx]?.[0] ?? ss;
      const fes = this.bitRanges[toIdx]?.[1] ?? es;
      const digits = bits / 4;
      const hex = '0x' + val.toString(16).toUpperCase().padStart(digits, '0');
      this.put(fss, fes, this.outAnn, [
        cls,
        [`${longName}: ${hex}`, `${short1}: ${hex}`, `${short2}: ${hex}`, short2],
        val,
      ]);
    };

    if (extended) {
      address = packByte(0, 16);
      command = packByte(16, 8);
      commandInverse = packByte(24, 8);
      valid = (command ^ commandInverse) === 0xff;
      putField(IR_NEC_ANN.ADDR, 'Address', 'ADDR', 'A', address, 16, 0, 15);
      putField(IR_NEC_ANN.CMD, 'Command', 'CMD', 'C', command, 8, 16, 23);
      putField(IR_NEC_ANN.CMD_INV, 'Command#', 'CMD#', 'C#', commandInverse, 8, 24, 31);
      if (!valid) {
        const fss = this.bitRanges[16]?.[0] ?? ss;
        const fes = this.bitRanges[31]?.[1] ?? es;
        const rawCmd = ((commandInverse << 8) | command).toString(16).toUpperCase().padStart(4, '0');
        this.put(fss, fes, this.outAnn, [IR_NEC_ANN.WARNING, [`Command error: 0x${rawCmd}`]]);
      }
    } else {
      address = packByte(0, 8);
      addressInverse = packByte(8, 8);
      command = packByte(16, 8);
      commandInverse = packByte(24, 8);
      const addrValid = (address ^ addressInverse) === 0xff;
      const cmdValid = (command ^ commandInverse) === 0xff;
      valid = addrValid && cmdValid;
      putField(IR_NEC_ANN.ADDR, 'Address', 'ADDR', 'A', address, 8, 0, 7);
      putField(IR_NEC_ANN.ADDR_INV, 'Address#', 'ADDR#', 'A#', addressInverse, 8, 8, 15);
      if (!addrValid) {
        const fss = this.bitRanges[0]?.[0] ?? ss;
        const fes = this.bitRanges[15]?.[1] ?? es;
        const rawAddr = ((addressInverse << 8) | address).toString(16).toUpperCase().padStart(4, '0');
        this.put(fss, fes, this.outAnn, [IR_NEC_ANN.WARNING, [`Address error: 0x${rawAddr}`]]);
      }
      putField(IR_NEC_ANN.CMD, 'Command', 'CMD', 'C', command, 8, 16, 23);
      putField(IR_NEC_ANN.CMD_INV, 'Command#', 'CMD#', 'C#', commandInverse, 8, 24, 31);
      if (!cmdValid) {
        const fss = this.bitRanges[16]?.[0] ?? ss;
        const fes = this.bitRanges[31]?.[1] ?? es;
        const rawCmd = ((commandInverse << 8) | command).toString(16).toUpperCase().padStart(4, '0');
        this.put(fss, fes, this.outAnn, [IR_NEC_ANN.WARNING, [`Command error: 0x${rawCmd}`]]);
      }
    }

    const remoteDev = REMOTE_DEVICES[address];
    const remoteBtn = REMOTE_COMMANDS[address]?.[command];
    const stopSamples = BigInt(Math.max(1, Math.round(0.56e-3 * (this.samplerate ?? 1))));
    const remoteEs = es + stopSamples;
    if (remoteDev || remoteBtn) {
      const dev = remoteDev ?? 'Unknown device';
      const btn = remoteBtn ?? ['Unknown', 'Unk'];
      this.put(ss, remoteEs, this.outAnn, [IR_NEC_ANN.REMOTE, [`${dev}: ${btn[0]}`, `${dev}: ${btn[1]}`, btn[1]]]);
    } else {
      const addrHex =
        '0x' +
        address
          .toString(16)
          .toUpperCase()
          .padStart(extended ? 4 : 2, '0');
      const cmdHex = '0x' + command.toString(16).toUpperCase().padStart(2, '0');
      this.put(ss, remoteEs, this.outAnn, [
        IR_NEC_ANN.REMOTE,
        [`Addr ${addrHex} · Cmd ${cmdHex}`, `${addrHex}:${cmdHex}`, cmdHex],
        value >>> 0,
      ]);
    }

    const frame: Omit<IRNECFrame, 'ss' | 'es'> = {
      kind: 'nec',
      address,
      command,
      addressInverse,
      commandInverse,
      valid,
    };
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
        this.agcEnd = es;
      } else if (this.state === 'stop-mark') {
        return;
      } else if (this.state === 'repeat-mark' && this.shortMark(duration)) {
        this.emitRepeat(this.frameStart ?? ss, this.agcEnd, ss, es);
        this.state = 'idle';
        this.frameStart = null;
        this.agcEnd = null;
      } else if (this.state === 'bit-mark' && this.shortMark(duration)) {
        this.markDuration = duration;
        this.bitStart = ss;
        this.state = 'bit-space';
      } else if (this.state !== 'idle') this.discard('Unexpected IR mark duration');
      return;
    }
    if (this.state === 'stop-mark') {
      this.state = 'idle';
      return;
    }
    if (this.state === 'leader-space') {
      if (this.between(duration, 3.5e-3, 5.5e-3)) {
        this.emitLeader(this.frameStart ?? ss, this.agcEnd ?? ss, es, 'Long');
        this.bits = [];
        this.bitRanges = [];
        this.state = 'bit-mark';
      } else if (this.between(duration, 1.8e-3, 2.8e-3)) {
        this.state = 'repeat-mark';
      } else {
        this.discard('Invalid NEC leader space');
      }
    } else if (this.state === 'bit-space') {
      if (!this.shortMark(this.markDuration)) {
        this.discard('Invalid NEC bit mark');
        return;
      }
      let bitVal = 0;
      if (this.between(duration, 0.32e-3, 1.0e-3)) bitVal = 0;
      else if (this.between(duration, 1.25e-3, 2.1e-3)) bitVal = 1;
      else {
        this.discard('Invalid NEC bit space');
        return;
      }
      const bss = this.bitStart ?? ss;
      this.bits.push(bitVal);
      this.bitRanges.push([bss, es]);
      this.put(bss, es, this.outAnn, [IR_NEC_ANN.BIT, [String(bitVal)]]);
      if (this.bits.length === 32) {
        this.emitBits(this.frameStart ?? ss, es);
        const stopSamples = BigInt(Math.max(1, Math.round(0.56e-3 * (this.samplerate ?? 1))));
        this.put(es, es + stopSamples, this.outAnn, [IR_NEC_ANN.STOP_BIT, ['Stop bit', 'Stop', 'St', 'S']]);
        this.state = 'stop-mark';
        this.frameStart = null;
        this.agcEnd = null;
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
          this.agcEnd = this.autoEnd;
          if (this.between(duration, 3.5e-3, 5.5e-3)) {
            this.emitLeader(this.frameStart ?? ss, this.agcEnd ?? ss, es, 'Long');
            this.bits = [];
            this.bitRanges = [];
            this.state = 'bit-mark';
          } else {
            this.state = 'repeat-mark';
          }
          this.autoStart = null;
          this.autoEnd = null;
        } else this.discard('Automatic polarity detection failed');
        return;
      }
      if (this.leader(duration)) {
        this.state = 'auto-leader';
        this.autoLevel = level;
        this.autoStart = ss;
        this.autoEnd = es;
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
