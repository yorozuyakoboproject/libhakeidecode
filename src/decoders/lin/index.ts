import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { AnnotationData, DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

type LinState = 'WAIT_FOR_BREAK' | 'SYNC' | 'PID' | 'DATA' | 'CHECKSUM' | 'ERROR';
type LinByte = readonly [ss: bigint, es: bigint, value: number];

const TRANSITIONS: Readonly<Record<LinState, readonly LinState[]>> = {
  WAIT_FOR_BREAK: ['SYNC'],
  SYNC: ['PID'],
  PID: ['DATA'],
  DATA: ['DATA', 'CHECKSUM'],
  CHECKSUM: ['WAIT_FOR_BREAK'],
  ERROR: ['SYNC'],
};

export class LinDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private state: LinState = 'WAIT_FOR_BREAK';
  private uartIdleCount = 0;
  private header: LinByte[] = [];
  private response: LinByte[] = [];
  private version = 2;
  private ssBlock = 0n;
  private esBlock = 0n;
  private outAnn = -1;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = 'WAIT_FOR_BREAK';
    this.uartIdleCount = 0;
    this.header = [];
    this.response = [];
    this.ssBlock = 0n;
    this.esBlock = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.version = Number(this.options.version);
  }

  private transit(target: LinState): boolean {
    if (target !== 'ERROR' && !TRANSITIONS[this.state].includes(target)) return false;
    this.state = target;
    return true;
  }

  private putX(data: AnnotationData): void {
    this.put(this.ssBlock, this.esBlock, this.outAnn, data);
  }

  private wipeBreakNullByte(value: number): boolean {
    if (this.state !== 'WAIT_FOR_BREAK' && this.state !== 'ERROR') {
      if (this.response.length) value = this.response.pop()![2];
      else this.header.pop();
    }
    if (value !== 0) {
      this.transit('ERROR');
      this.handleError();
      return false;
    }
    return true;
  }

  private handleUartIdle(): void {
    if (this.state === 'WAIT_FOR_BREAK' || this.state === 'ERROR') return;
    this.uartIdleCount++;
    if (this.uartIdleCount !== 2) return;
    this.transit('CHECKSUM');
    this.handleChecksum();
    this.state = 'WAIT_FOR_BREAK';
    this.uartIdleCount = 0;
  }

  private handleBreak(value: number): void {
    if (this.state !== 'WAIT_FOR_BREAK' && this.state !== 'ERROR') {
      if (this.wipeBreakNullByte(value)) {
        this.transit('CHECKSUM');
        this.handleChecksum();
      }
    }
    this.state = 'WAIT_FOR_BREAK';
    this.uartIdleCount = 0;
    this.transit('SYNC');
    this.putX([1, ['Break condition', 'Break', 'Brk', 'B']]);
  }

  private handleSync(value: number): void {
    this.transit('PID');
    this.header.push([this.ssBlock, this.esBlock, value]);
  }

  private handlePid(value: number): void {
    this.transit('DATA');
    this.header.push([this.ssBlock, this.esBlock, value]);
  }

  private handleData(value: number): void {
    this.response.push([this.ssBlock, this.esBlock, value]);
  }

  private static calcParity(pid: number): number {
    const id = Array.from({ length: 8 }, (_, index) => ((pid & 0x3f) >>> index) & 1);
    const p0 = id[0]! ^ id[1]! ^ id[2]! ^ id[4]!;
    const p1 = id[1]! ^ id[3]! ^ id[4]! ^ id[5]! ? 0 : 1;
    return p0 | (p1 << 1);
  }

  private checksumIsValid(pid: number, data: readonly LinByte[], checksum: number): boolean {
    if (this.version === 2) {
      const id = pid & 0x3f;
      if (id !== 60 && id !== 61) checksum += pid;
    }
    for (const byte of data) checksum += byte[2];
    return (checksum & 0xff) === 0xff;
  }

  private handleChecksum(): void {
    const sync = this.header.shift() ?? null;
    if (sync !== null) {
      this.put(sync[0], sync[1], this.outAnn, [0, ['Sync', 'S']]);
      if (sync[2] !== 0x55) this.put(sync[0], sync[1], this.outAnn, [2, ['Sync is not 0x55', 'Not 0x55', '!= 0x55']]);
    }

    const pid = this.header.shift() ?? null;
    const checksum = this.response.pop() ?? null;
    if (pid !== null) {
      const id = pid[2] & 0x3f;
      const parity = pid[2] >> 6;
      const expected = LinDecoder.calcParity(pid[2]);
      const parityValid = parity === expected;
      if (!parityValid) this.put(pid[0], pid[1], this.outAnn, [2, [`P != ${expected}`]]);
      this.put(pid[0], pid[1], this.outAnn, [
        parityValid ? 0 : 3,
        [
          `ID: ${id.toString(16).toUpperCase().padStart(2, '0')} Parity: ${parity} (${parityValid ? 'ok' : 'bad'})`,
          `ID: 0x${id.toString(16).toUpperCase().padStart(2, '0')}`,
          `I: ${id}`,
        ],
      ]);
    }

    if (this.response.length && pid !== null && checksum !== null) {
      const checksumValid = this.checksumIsValid(pid[2], this.response, checksum[2]);
      for (const byte of this.response) {
        const hex = byte[2].toString(16).toUpperCase().padStart(2, '0');
        this.put(byte[0], byte[1], this.outAnn, [0, [`Data: 0x${hex}`, `D: 0x${hex}`]]);
      }
      const hex = checksum[2].toString(16).toUpperCase().padStart(2, '0');
      this.put(checksum[0], checksum[1], this.outAnn, [
        checksumValid ? 0 : 3,
        [`Checksum: 0x${hex}`, 'Checksum', 'Chk', 'C'],
      ]);
      if (!checksumValid) this.put(checksum[0], checksum[1], this.outAnn, [2, ['Checksum invalid']]);
    }
    this.header = [];
    this.response = [];
  }

  private handleError(): void {
    this.putX([3, ['Error', 'Err', 'E']]);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as readonly unknown[];
    if (!Array.isArray(packet) || packet.length < 3) return;
    const type = packet[0];
    this.ssBlock = ss;
    this.esBlock = es;
    if (type === 'IDLE') this.handleUartIdle();
    if (type === 'BREAK') this.handleBreak(Number(packet[2]));
    if (type !== 'DATA') return;
    const payload = packet[2] as readonly [number, unknown];
    if (!Number.isInteger(payload[0])) return;
    if (this.state === 'WAIT_FOR_BREAK') this.wipeBreakNullByte(payload[0]);
    else if (this.state === 'SYNC') this.handleSync(payload[0]);
    else if (this.state === 'PID') this.handlePid(payload[0]);
    else if (this.state === 'DATA') this.handleData(payload[0]);
    else if (this.state === 'ERROR') this.handleError();
  }
}

export default LinDecoder;
