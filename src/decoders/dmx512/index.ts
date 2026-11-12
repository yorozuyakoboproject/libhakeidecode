import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface Dmx512Options {
  min_break: number;
  max_mark: number;
  min_break_break: number;
  max_reset_reset: number;
  show_zero: 'yes' | 'no';
  format: 'dec' | 'hex' | 'bin';
}

type PacketItem = [ss: bigint, es: bigint, value: number, valid: boolean];
type DeferredFrame = [ss: bigint, es: bigint, value: number, valid: boolean];
type UartFrame = readonly ['FRAME', 0 | 1, readonly [value: number, valid: boolean | null]];

const ANN = Object.freeze({
  BREAK: 0,
  MAB: 1,
  INTERFRAME: 2,
  INTERPACKET: 3,
  STARTCODE: 4,
  DATABYTE: 5,
  CHANNEL: 6,
  SLOT: 7,
  RESET: 8,
  WARNING: 9,
  ERROR: 10,
});

export class Dmx512Decoder extends Decoder<Dmx512Options> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outProtocol = -1;
  private samplerate: number | null = null;
  private samplesPerUsec = 0;
  private lastReset: bigint | null = null;
  private lastBreak: bigint | null = null;
  private packet: PacketItem[] | null = null;
  private lastEs: bigint | null = null;
  private lastFrame: DeferredFrame | null = null;
  private startCode: number | null = null;

  constructor(options: Partial<Dmx512Options> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.samplesPerUsec = 0;
    this.lastReset = null;
    this.lastBreak = null;
    this.packet = null;
    this.lastEs = null;
    this.lastFrame = null;
    this.startCode = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'dmx512');
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.samplesPerUsec = value / 1_000_000;
  }

  private truthy(sample: bigint | null): sample is bigint {
    return sample !== null && sample !== 0n;
  }

  private usecs(samples: number): number {
    return samples / this.samplesPerUsec;
  }

  private formatValue(value: number): string {
    if (this.options.format === 'hex') return value.toString(16).toUpperCase().padStart(2, '0');
    if (this.options.format === 'bin') return value.toString(2).padStart(8, '0');
    return String(value);
  }

  private flushPacket(): void {
    if (this.packet?.length) {
      const ss = this.packet[0]![0];
      const es = this.packet[this.packet.length - 1]![1];
      this.put(ss, es, this.outProtocol, ['PACKET', this.packet]);
    }
    this.packet = null;
  }

  private flushReset(ss: bigint | null, es: bigint | null): void {
    if (ss === null || es === null) return;
    this.put(ss, es, this.outAnn, [ANN.RESET, ['RESET SEQUENCE', 'RESET', 'R']]);
    if (this.truthy(this.lastReset) && this.samplerate) {
      const duration = this.usecs(Number(es - this.lastReset));
      if (duration > this.options.max_reset_reset)
        this.put(this.lastReset, es, this.outAnn, [
          ANN.WARNING,
          ['Excessive RESET to RESET interval', 'RESET to RESET', 'RESET'],
        ]);
    }
    this.lastReset = es;
  }

  private flushBreak(ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [ANN.BREAK, ['BREAK', 'B']]);
    if (this.samplerate) {
      if (this.usecs(Number(es - ss)) < this.options.min_break)
        this.put(ss, es, this.outAnn, [ANN.WARNING, ['Short BREAK period', 'Short BREAK', 'BREAK']]);
      if (this.truthy(this.lastBreak) && this.usecs(Number(ss - this.lastBreak)) < this.options.min_break_break)
        this.put(ss, es, this.outAnn, [
          ANN.WARNING,
          ['Short BREAK to BREAK interval', 'Short BREAK to BREAK', 'BREAK'],
        ]);
    }
    this.lastBreak = ss;
    this.lastEs = es;
  }

  private flushMark(
    ss: bigint | null,
    es: bigint | null,
    isMab = false,
    isInterframe = false,
    isInterpacket = false,
  ): void {
    if (ss === null || es === null || ss >= es) return;
    let classIndex: number;
    let texts: readonly string[];
    if (isMab) {
      classIndex = ANN.MAB;
      texts = ['MARK AFTER BREAK', 'MAB'];
    } else if (isInterframe) {
      classIndex = ANN.INTERFRAME;
      texts = ['INTER FRAME', 'IF'];
    } else if (isInterpacket) {
      classIndex = ANN.INTERPACKET;
      texts = ['INTER PACKET', 'IP'];
    } else return;
    this.put(ss, es, this.outAnn, [classIndex, texts]);
    if (this.samplerate && this.usecs(Number(es - ss)) > this.options.max_mark)
      this.put(ss, es, this.outAnn, [ANN.ERROR, ['Excessive MARK length', 'MARK length', 'MARK']]);
  }

  private flushFrame(ss: bigint, es: bigint, value: number, valid: boolean): void {
    if (!valid) this.put(ss, es, this.outAnn, [ANN.ERROR, ['Invalid frame', 'Frame']]);
    this.lastEs = es;
    if (!this.truthy(this.lastBreak)) return;

    const isStart = this.packet === null;
    if (isStart) this.packet = [];
    const slot = this.packet!.length;
    this.packet!.push([ss, es, value, valid]);

    if (isStart) {
      this.startCode = value;
      const text = this.formatValue(value);
      this.put(ss, es, this.outAnn, [ANN.STARTCODE, [`STARTCODE ${text}`, `START ${text}`, text]]);
    } else {
      const text = this.formatValue(value);
      this.put(ss, es, this.outAnn, [
        ANN.DATABYTE,
        [`DATABYTE ${slot}: ${text}`, `DATA ${slot}: ${text}`, `DATA ${text}`, text],
      ]);
    }

    let channelClass: number | null;
    let channelTexts: readonly string[];
    if (isStart) channelClass = null;
    else if (this.startCode === 0) {
      channelClass = ANN.CHANNEL;
      if (value === 0 && this.options.show_zero === 'no') channelClass = null;
      else {
        const text = this.formatValue(value);
        channelTexts = [`CHANNEL ${slot}: ${text}`, `CH ${slot}: ${text}`, `CH ${text}`, text];
      }
    } else {
      channelClass = ANN.SLOT;
      const text = this.formatValue(value);
      channelTexts = [`SLOT ${slot}: ${text}`, `SL ${slot}: ${text}`, `SL ${text}`, text];
    }
    if (channelClass !== null) this.put(ss, es, this.outAnn, [channelClass, channelTexts!]);

    if (isStart && value === 0) this.flushReset(this.lastBreak, es);
  }

  private handleBreak(ss: bigint, es: bigint): void {
    let frame = this.lastFrame;
    this.lastFrame = null;
    const invalidZeroAtBreak = frame !== null && !frame[3] && frame[2] === 0 && frame[0] === ss;
    if (invalidZeroAtBreak) frame = null;
    if (frame) this.flushFrame(...frame);

    this.flushMark(this.lastEs, ss, false, false, true);
    this.flushPacket();
    this.flushBreak(ss, es);
  }

  private handleFrame(ss: bigint, es: bigint, value: number, valid: boolean): void {
    const previous = this.lastFrame;
    this.lastFrame = null;
    if (previous) this.flushFrame(...previous);

    const isMab = this.truthy(this.lastBreak) && this.packet === null;
    const isInterframe = this.packet !== null && this.packet.length > 0;
    this.flushMark(this.lastEs, ss, isMab, isInterframe, false);

    if (valid) this.flushFrame(ss, es, value, valid);
    else this.lastFrame = [ss, es, value, valid];
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    const type = data[0];
    if (type === 'BREAK') this.handleBreak(ss, es);
    else if (type === 'FRAME') {
      const payload = (data as unknown as UartFrame)[2];
      this.handleFrame(ss, es, payload[0], payload[1] === true);
    }
  }
}

export default Dmx512Decoder;
