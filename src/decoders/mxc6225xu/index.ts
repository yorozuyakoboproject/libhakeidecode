import { descriptor } from './descriptor.js';
import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';

export type Mxc6225xuOptions = Record<string, OptionValue>;

const SHAKE = ['none', 'shake left', 'shake right', 'undefined'] as const;
const ORIENTATION = [
  'vertical in upright orientation',
  'rotated 90 degrees clockwise',
  'vertical in inverted orientation',
  'rotated 90 degrees counterclockwise',
] as const;
const SHAKE_THRESHOLD = ['0.5g', '1.0g', '1.5g', '2.0g'] as const;
const SHAKE_COUNT = ['16', '32', '64', '128'] as const;
const ORIENTATION_COUNT = ['16', '32', '64', '128'] as const;

type State = 'idle' | 'get-slave-addr' | 'get-reg-addr' | 'write-regs' | 'read-regs' | 'read-regs2';

function signedByte(value: number): number {
  return value & 0x80 ? value - 0x100 : value;
}

function statusText(value: number): string {
  const int = (value >> 7) & 1;
  const shake = (value >> 5) & 3;
  const tilt = (value >> 4) & 1;
  const orientation = (value >> 2) & 3;
  const rotation = value & 3;
  return (
    `INT = ${int}: Orientation ${int === 0 ? 'unchanged and no' : 'changed or'} shake event occurred\n` +
    `SH[1:0] = ${shake.toString(2)}: Shake event: ${SHAKE[shake]}\n` +
    `TILT = ${tilt}: Orientation measurement is ${tilt === 0 ? '' : 'not '}valid\n` +
    `ORI[1:0] = ${orientation.toString(2)}: ${ORIENTATION[orientation]}\n` +
    `OR[1:0] = ${rotation.toString(2)}: ${ORIENTATION[rotation]}\n`
  );
}

function detectionText(value: number): string {
  const shakeMode = (value >> 6) & 1;
  const threshold = (value >> 4) & 3;
  const shakeCount = (value >> 2) & 3;
  const orientationCount = value & 3;
  return (
    `SHM = ${shakeMode}: Set shake mode to ${shakeMode}\n` +
    `SHTH[1:0] = ${threshold.toString(2)}: Set shake threshold to ${SHAKE_THRESHOLD[threshold]}\n` +
    `SHC[1:0] = ${shakeCount.toString(2)}: Set shake count to ${SHAKE_COUNT[shakeCount]} readings\n` +
    `ORC[1:0] = ${orientationCount.toString(2)}: Set orientation count to ${ORIENTATION_COUNT[orientationCount]} readings\n`
  );
}

export class Mxc6225xuDecoder extends Decoder<Mxc6225xuOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private state: State = 'idle';
  private reg = 0;

  override reset(): void {
    this.state = 'idle';
    this.reg = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private handleRegister(register: number, value: number, ss: bigint, es: bigint): void {
    let text: string | null = null;
    if (register === 0x00) text = `XOUT: ${signedByte(value)}`;
    else if (register === 0x01) text = `YOUT: ${signedByte(value)}`;
    else if (register === 0x02) text = statusText(value);
    else if (register === 0x03) text = detectionText(value);
    if (text !== null) this.put(ss, es, this.outAnn, [0, [text]]);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || typeof data[0] !== 'string') return;
    if (data[0] === 'START') {
      if (data[1] !== true && this.state === 'idle') this.state = 'get-slave-addr';
      else if (data[1] === true && this.state === 'write-regs') this.state = 'read-regs';
      return;
    }
    if (data[0] === 'ADDRESS') {
      if (this.state === 'get-slave-addr' && data[1] === 'write') this.state = 'get-reg-addr';
      else if (this.state === 'read-regs' && data[1] === 'read') this.state = 'read-regs2';
      return;
    }
    if (data[0] === 'DATA') {
      if (this.state === 'get-reg-addr' && data[1] === 'write' && typeof data[2] === 'number') {
        this.reg = data[2];
        this.state = 'write-regs';
      } else if (this.state === 'write-regs' && data[1] === 'write' && typeof data[2] === 'number') {
        this.handleRegister(this.reg, data[2], ss, es);
        this.reg++;
      } else if (this.state === 'read-regs2' && data[1] === 'read' && typeof data[2] === 'number') {
        this.handleRegister(this.reg, data[2], ss, es);
        this.reg++;
      }
      return;
    }
    if (data[0] === 'STOP' && (this.state === 'write-regs' || this.state === 'read-regs2')) this.state = 'idle';
  }
}

export default Mxc6225xuDecoder;
