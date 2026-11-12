import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const PULSE_START = 0;
const PULSE_ZERO = 1;
const PULSE_ONE = 2;
const PULSE_INVALID = -1;

const WAIT_START = 0;
const GET_BITS = 1;
const WAIT_EOM = 2;
const WAIT_ACK = 3;

const TIMING = [
  { low: [3.5, 3.9], total: [4.3, 4.7] },
  { low: [1.3, 1.7], total: [2.05, 2.75] },
  { low: [0.4, 0.8], total: [2.05, 2.75] },
] as const;

export const CEC_ADDRESSES = [
  'TV',
  'Recording_1',
  'Recording_2',
  'Tuner_1',
  'Playback_1',
  'AudioSystem',
  'Tuner2',
  'Tuner3',
  'Playback_2',
  'Recording_3',
  'Tuner_4',
  'Playback_3',
  'Backup_1',
  'Backup_2',
  'FreeUse',
] as const;

export const CEC_OPCODES: Readonly<Record<number, string>> = {
  0x82: 'ACTIVE_SOURCE',
  0x04: 'IMAGE_VIEW_ON',
  0x0d: 'TEXT_VIEW_ON',
  0x9d: 'INACTIVE_SOURCE',
  0x85: 'REQUEST_ACTIVE_SOURCE',
  0x80: 'ROUTING_CHANGE',
  0x81: 'ROUTING_INFORMATION',
  0x86: 'SET_STREAM_PATH',
  0x36: 'STANDBY',
  0x0b: 'RECORD_OFF',
  0x09: 'RECORD_ON',
  0x0a: 'RECORD_STATUS',
  0x0f: 'RECORD_TV_SCREEN',
  0x33: 'CLEAR_ANALOGUE_TIMER',
  0x99: 'CLEAR_DIGITAL_TIMER',
  0xa1: 'CLEAR_EXTERNAL_TIMER',
  0x34: 'SET_ANALOGUE_TIMER',
  0x97: 'SET_DIGITAL_TIMER',
  0xa2: 'SET_EXTERNAL_TIMER',
  0x67: 'SET_TIMER_PROGRAM_TITLE',
  0x43: 'TIMER_CLEARED_STATUS',
  0x35: 'TIMER_STATUS',
  0x9e: 'CEC_VERSION',
  0x9f: 'GET_CEC_VERSION',
  0x83: 'GIVE_PHYSICAL_ADDRESS',
  0x91: 'GET_MENU_LANGUAGE',
  0x84: 'REPORT_PHYSICAL_ADDRESS',
  0x32: 'SET_MENU_LANGUAGE',
  0x42: 'DECK_CONTROL',
  0x1b: 'DECK_STATUS',
  0x1a: 'GIVE_DECK_STATUS',
  0x41: 'PLAY',
  0x08: 'GIVE_TUNER_DEVICE_STATUS',
  0x92: 'SELECT_ANALOGUE_SERVICE',
  0x93: 'SELECT_DIGITAL_SERVICE',
  0x07: 'TUNER_DEVICE_STATUS',
  0x06: 'TUNER_STEP_DECREMENT',
  0x05: 'TUNER_STEP_INCREMENT',
  0x87: 'DEVICE_VENDOR_ID',
  0x8c: 'GIVE_DEVICE_VENDOR_ID',
  0x89: 'VENDOR_COMMAND',
  0xa0: 'VENDOR_COMMAND_WITH_ID',
  0x8a: 'VENDOR_REMOTE_BUTTON_DOWN',
  0x8b: 'VENDOR_REMOTE_BUTTON_UP',
  0x64: 'SET_OSD_STRING',
  0x46: 'GIVE_OSD_NAME',
  0x47: 'SET_OSD_NAME',
  0x8d: 'MENU_REQUEST',
  0x8e: 'MENU_STATUS',
  0x44: 'USER_CONTROL_PRESSED',
  0x45: 'USER_CONTROL_RELEASE',
  0x8f: 'GIVE_DEVICE_POWER_STATUS',
  0x90: 'REPORT_POWER_STATUS',
  0x00: 'FEATURE_ABORT',
  0xff: 'ABORT',
  0x71: 'GIVE_AUDIO_STATUS',
  0x7d: 'GIVE_SYSTEM_AUDIO_MODE_STATUS',
  0x7a: 'REPORT_AUDIO_STATUS',
  0x72: 'SET_SYSTEM_AUDIO_MODE',
  0x70: 'SYSTEM_AUDIO_MODE_REQUEST',
  0x7e: 'SYSTEM_AUDIO_MODE_STATUS',
  0x9a: 'SET_AUDIO_RATE',
};

interface CommandByte {
  readonly st: bigint;
  readonly ed: bigint;
  readonly val: number;
}

export function cecLogicalAddress(value: number, initiator: boolean): string {
  if (value < 0 || value > 0x0f) return 'Invalid';
  if (value === 0x0f) return initiator ? 'Unregistered' : 'Broadcast';
  return CEC_ADDRESSES[value]!;
}

export function cecHeader(header: number): readonly [string, string] {
  return [cecLogicalAddress(header >>> 4, true), cecLogicalAddress(header & 0x0f, false)];
}

export function cecFrameText(bytes: readonly number[]): string {
  return bytes.map((value) => value.toString(16).padStart(2, '0')).join(':');
}

export function cecSectionText(bytes: readonly number[], eom: boolean, nack: boolean): string {
  let text = '';
  for (let index = 0; index < bytes.length; index++) {
    if (index === 0) {
      const [source, destination] = cecHeader(bytes[index]!);
      text = `HDR: ${source}, ${destination}`;
    } else if (index === 1) {
      text += ` | OPC: ${CEC_OPCODES[bytes[index]!] ?? 'Invalid'}`;
    } else {
      if (index === 2) text += ' | OPS: ';
      text += `0x${bytes[index]!.toString(16).padStart(2, '0')}`;
      if (index !== bytes.length - 1) text += ', ';
    }
  }
  if (bytes.length === 1) text += eom ? ' | OPC: PING' : ' | OPC: NONE. Aborted cmd';
  return text + (nack ? ' | R: NACK' : ' | R: ACK');
}

export class CecDecoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;
  private samplerate: number | null = null;
  private outAnn = -1;
  private stat = WAIT_START;
  private fallStart: bigint | null = null;
  private fallEnd: bigint | null = null;
  private rise: bigint | null = null;
  private maxAckLenSamples = 0n;
  private eom: boolean | null = null;
  private bitCount = 0;
  private byteCount = 0;
  private byte = 0;
  private byteStart: bigint | null = null;
  private frameStart: bigint | null = null;
  private frameEnd: bigint | null = null;
  private isNack = false;
  private commandBytes: CommandByte[] = [];

  constructor(options: Record<string, never> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.stat = WAIT_START;
    this.fallStart = null;
    this.fallEnd = null;
    this.rise = null;
    this.eom = null;
    this.bitCount = 0;
    this.byteCount = 0;
    this.byte = 0;
    this.byteStart = null;
    this.frameStart = null;
    this.frameEnd = null;
    this.isNack = false;
    this.commandBytes = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.maxAckLenSamples = BigInt(Math.round((TIMING[PULSE_ZERO]!.total[0] * 2 * value) / 1000));
  }

  private resetFrame(): void {
    this.eom = null;
    this.bitCount = 0;
    this.byteCount = 0;
    this.byte = 0;
    this.byteStart = null;
    this.frameStart = null;
    this.frameEnd = null;
    this.isNack = false;
    this.commandBytes = [];
  }

  private annotate(classIndex: number, texts: readonly string[], ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private handleFrame(nack: boolean): void {
    if (this.fallStart === null || this.fallEnd === null || this.frameStart === null || this.frameEnd === null) return;
    const values = this.commandBytes.map((item) => item.val);
    this.annotate(7, [cecFrameText(values)], this.frameStart, this.frameEnd);
    this.annotate(8, [cecSectionText(values, this.eom === true, nack)], this.frameStart, this.frameEnd);
  }

  private process(): void {
    if (this.rise === null || this.fallStart === null || this.fallEnd === null) return;
    const zeroTime = (Number(this.rise - this.fallStart) / this.samplerate!) * 1000;
    const totalTime = (Number(this.fallEnd - this.fallStart) / this.samplerate!) * 1000;
    let pulse = PULSE_INVALID;
    for (let index = PULSE_START; index <= PULSE_ONE; index++) {
      if (zeroTime >= TIMING[index]!.low[0] && zeroTime <= TIMING[index]!.low[1]) {
        pulse = index;
        break;
      }
    }

    if (pulse === PULSE_INVALID) {
      this.stat = WAIT_START;
      this.annotate(9, ['Invalid pulse: Wrong timing'], this.fallStart, this.fallEnd);
      return;
    }
    if (this.stat === WAIT_START && pulse !== PULSE_START) {
      this.annotate(9, ['Expected START: BIT found'], this.fallStart, this.fallEnd);
      return;
    }
    if ((this.stat === WAIT_ACK || this.stat === WAIT_EOM) && pulse === PULSE_START) {
      this.annotate(9, ['Expected BIT: START received)'], this.fallStart, this.fallEnd);
      this.stat = WAIT_START;
    }
    if (this.stat === WAIT_ACK && pulse !== PULSE_START && totalTime < TIMING[pulse]!.total[0]) {
      this.annotate(9, ['ACK pulse below minimun time'], this.fallStart, this.fallEnd);
      this.stat = WAIT_START;
      return;
    }
    if (this.stat === GET_BITS && pulse === PULSE_START) {
      if (this.bitCount === 0) this.handleFrame(this.isNack);
      else this.annotate(9, ['ERROR: Incomplete byte received'], this.frameStart ?? this.fallStart, this.samplenum);
      this.stat = WAIT_START;
    }
    if (
      this.stat !== WAIT_ACK &&
      pulse !== PULSE_START &&
      (totalTime < TIMING[pulse]!.total[0] || totalTime > TIMING[pulse]!.total[1])
    ) {
      this.annotate(9, ['Bit pulse exceeds total pulse timespan'], this.fallStart, this.fallEnd);
      this.stat = WAIT_START;
      return;
    }

    let bit = 0;
    if (pulse === PULSE_ZERO) bit = 0;
    else if (pulse === PULSE_ONE) bit = 1;

    if (this.stat === WAIT_START) {
      this.stat = GET_BITS;
      this.resetFrame();
      this.annotate(0, ['ST'], this.fallStart, this.fallEnd);
    } else if (this.stat === GET_BITS) {
      if (this.bitCount === 0) {
        this.byteStart = this.fallStart;
        this.byte = 0;
        if (!this.commandBytes.length) this.frameStart = this.fallStart;
      }
      this.byte += bit << (7 - this.bitCount);
      this.bitCount++;
      this.annotate(5, [String(bit)], this.fallStart, this.fallEnd);
      if (this.bitCount === 8) {
        this.bitCount = 0;
        this.byteCount++;
        this.stat = WAIT_EOM;
        const start = this.byteStart ?? this.fallStart;
        this.annotate(6, [`0x${this.byte.toString(16).padStart(2, '0')}`], start, this.samplenum);
        this.commandBytes.push({ st: start, ed: this.samplenum, val: this.byte });
      }
    } else if (this.stat === WAIT_EOM) {
      this.eom = bit !== 0;
      this.frameEnd = this.fallEnd;
      this.annotate(this.eom ? 2 : 1, [this.eom ? 'EOM=Y' : 'EOM=N'], this.fallStart, this.fallEnd);
      this.stat = WAIT_ACK;
    } else if (this.stat === WAIT_ACK) {
      if ((this.commandBytes[0]!.val & 0x0f) === 0x0f) bit = ~bit & 1;
      const annEnd =
        this.fallEnd - this.fallStart > this.maxAckLenSamples ? this.fallStart + this.maxAckLenSamples : this.fallEnd;
      if (bit) {
        this.isNack = true;
        this.annotate(3, ['NACK'], this.fallStart, annEnd);
      } else {
        this.annotate(4, ['ACK'], this.fallStart, annEnd);
      }
      if (this.eom || this.isNack) {
        this.stat = WAIT_START;
        this.handleFrame(this.isNack);
      } else {
        this.stat = GET_BITS;
      }
    }
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    yield this.wait({ cec: 'f' });
    this.fallEnd = this.samplenum;
    while (true) {
      yield this.wait({ cec: 'r' });
      this.rise = this.samplenum;
      if (this.stat === WAIT_ACK) yield this.wait([{ cec: 'f' }, { skip: this.maxAckLenSamples }]);
      else yield this.wait({ cec: 'f' });
      this.fallStart = this.fallEnd;
      this.fallEnd = this.samplenum;
      this.process();
      if (this.matched?.[0] === false && this.matched?.[1] === true) {
        yield this.wait({ cec: 'f' });
        this.fallEnd = this.samplenum;
      }
    }
  }
}

export default CecDecoder;
