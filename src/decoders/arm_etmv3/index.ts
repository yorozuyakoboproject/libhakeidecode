import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { AnnotationData, DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface ArmEtmv3Options {
  objdump: string;
  objdump_opts: string;
  elffile: string;
  branch_enc: 'alternative' | 'original';
}

type UartData = readonly ['DATA', 0 | 1, readonly [value: number, bits: unknown]];
type PacketType =
  | 'branch'
  | 'a_sync'
  | 'cyclecount'
  | 'i_sync'
  | 'trigger'
  | 'ooo_data'
  | 'store_failed'
  | 'ooo_place'
  | 'vmid'
  | 'data'
  | 'timestamp'
  | 'data_suppressed'
  | 'ignore'
  | 'value_not_traced'
  | 'context_id'
  | 'exception_exit'
  | 'exception_entry'
  | 'p_header'
  | 'unknown';
type CpuState = 'arm' | 'thumb' | 'jazelle';

interface ExceptionInfo {
  nonSecure: number;
  exception: number;
  cancelled: number;
  altIsa: number;
  hypervisor: number;
  resume: number;
}

interface BranchInfo {
  address: bigint;
  addressLength: number;
  cpuState: CpuState;
  exceptionInfo: ExceptionInfo | null;
}

const EXCEPTION_NAMES = [
  'No exception',
  'IRQ1',
  'IRQ2',
  'IRQ3',
  'IRQ4',
  'IRQ5',
  'IRQ6',
  'IRQ7',
  'IRQ0',
  'UsageFault',
  'NMI',
  'SVC',
  'DebugMon',
  'MemManage',
  'PendSV',
  'SysTick',
  'Reserved',
  'Reset',
  'BusFault',
  'Reserved',
  'Reserved',
];
for (let index = 8; index < 496; index++) EXCEPTION_NAMES.push(`IRQ${index}`);

function parseVarint(bytes: readonly number[]): readonly [value: bigint, length: number] {
  let value = 0n;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return [value, index + 1];
  }
  return [value, bytes.length];
}

function parseUint(bytes: readonly number[]): bigint {
  let value = 0n;
  for (let index = 0; index < bytes.length; index++) value |= BigInt(bytes[index]!) << BigInt(index * 8);
  return value;
}

function parseExceptionInfo(bytes: readonly number[]): ExceptionInfo | null {
  if (!bytes.length) return null;
  let [value, length] = parseVarint(bytes);
  if ((bytes[length - 1]! & 0x80) !== 0) return null;
  if (length === 2 && (value & (1n << 13n)) !== 0n) value = (value & 0x7fn) | ((value & 0x3f80n) << 7n);
  return {
    nonSecure: Number(value & 1n),
    exception: Number(((value >> 1n) & 0x0fn) | ((value >> 7n) & 0x1f0n)),
    cancelled: Number((value >> 5n) & 1n),
    altIsa: Number((value >> 6n) & 1n),
    hypervisor: Number((value >> 12n) & 1n),
    resume: Number((value >> 14n) & 0x0fn),
  };
}

function bit(value: bigint, index: number): boolean {
  return ((value >> BigInt(index)) & 1n) !== 0n;
}

function parseBranchAddress(
  bytes: readonly number[],
  referenceAddress: bigint,
  cpuState: CpuState,
  branchEncoding: ArmEtmv3Options['branch_enc'],
): BranchInfo | null {
  let [address, addressLength] = parseVarint(bytes);
  if ((bytes[addressLength - 1]! & 0x80) !== 0) return null;
  let addressBits = 7 * addressLength;
  let hasExceptionInfo = false;
  if (branchEncoding === 'original') {
    if (addressLength === 5 && (bytes[4]! & 0x40) !== 0) hasExceptionInfo = true;
  } else {
    addressBits--;
    if (addressLength >= 2 && bit(address, addressBits)) {
      hasExceptionInfo = true;
      address &= ~(1n << BigInt(addressBits));
    }
  }
  let exceptionInfo: ExceptionInfo | null = null;
  if (hasExceptionInfo) {
    exceptionInfo = parseExceptionInfo(bytes.slice(addressLength));
    if (!exceptionInfo) return null;
  }
  if (addressLength === 5) {
    if ((bytes[4]! & 0xb8) === 0x08) cpuState = 'arm';
    else if ((bytes[4]! & 0xb0) === 0x10) cpuState = 'thumb';
    else if ((bytes[4]! & 0xa0) === 0x20) cpuState = 'jazelle';
    else throw new Error(`Unhandled branch byte 4: 0x${bytes[4]!.toString(16).padStart(2, '0')}`);
  }
  if (cpuState === 'arm') {
    address = (address & 0xfffffffen) << 1n;
    addressBits++;
  } else if (cpuState === 'thumb') {
    address &= 0xfffffffen;
  } else {
    address = (address & 0xfffffffefn) >> 1n;
    addressBits--;
  }
  if (addressLength < 5) {
    const mask = (0xffffffffn << BigInt(addressBits)) & 0xffffffffn;
    address |= referenceAddress & mask;
  }
  return { address: address & 0xffffffffn, addressLength, cpuState, exceptionInfo };
}

function hex32(value: bigint): string {
  return (value & 0xffffffffn).toString(16).padStart(8, '0');
}

export class ArmEtmv3Decoder extends Decoder<ArmEtmv3Options> {
  static descriptor = descriptor;
  private outAnn = -1;
  private buffer: number[] = [];
  private syncBuffer: number[] = [];
  private previousSample = 0n;
  private startSample = 0n;
  private byteLength = 0n;
  private lastBranch = 0n;
  private cpuState: CpuState = 'arm';
  private currentPc = 0n;

  constructor(options: Partial<ArmEtmv3Options> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.buffer = [];
    this.syncBuffer = [];
    this.previousSample = 0n;
    this.startSample = 0n;
    this.byteLength = 0n;
    this.lastBranch = 0n;
    this.cpuState = 'arm';
    this.currentPc = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private packetType(value: number): PacketType {
    if ((value & 0x01) === 0x01) return 'branch';
    if (value === 0x00) return 'a_sync';
    if (value === 0x04) return 'cyclecount';
    if (value === 0x08) return 'i_sync';
    if (value === 0x0c) return 'trigger';
    if ([0x20, 0x40, 0x60].includes(value & 0xf3)) return 'ooo_data';
    if (value === 0x50) return 'store_failed';
    if (value === 0x70) return 'i_sync';
    if ([0x54, 0x58, 0x5c].includes(value & 0xdf)) return 'ooo_place';
    if (value === 0x3c) return 'vmid';
    if ((value & 0xd3) === 0x02) return 'data';
    if ((value & 0xfb) === 0x42) return 'timestamp';
    if (value === 0x62) return 'data_suppressed';
    if (value === 0x66) return 'ignore';
    if ((value & 0xef) === 0x6a) return 'value_not_traced';
    if (value === 0x6e) return 'context_id';
    if (value === 0x76) return 'exception_exit';
    if (value === 0x7e) return 'exception_entry';
    if ((value & 0x81) === 0x80) return 'p_header';
    return 'unknown';
  }

  private fallback(buffer: readonly number[]): AnnotationData {
    const type = this.packetType(buffer[0]!);
    return [0, [`Unhandled ${type}: ${buffer.map((value) => value.toString(16).padStart(2, '0')).join(' ')}`]];
  }

  private instructionsExecuted(execution: readonly boolean[]): void {
    if (!execution.length) return;
    const delta = Math.max(1, Number(this.previousSample - this.startSample) / execution.length);
    for (let index = 0; index < execution.length; index++) {
      const pc = this.currentPc;
      const next = pc + (this.cpuState === 'thumb' ? 2n : 4n);
      const ss = this.startSample + BigInt(Math.round(delta * index));
      const es = this.startSample + BigInt(Math.round(delta * (index + 1)));
      const text = hex32(pc);
      this.put(ss, es, this.outAnn, [5, [`PC 0x${text}`, `0x${text}`, text]]);
      this.currentPc = execution[index] ? next : next;
    }
  }

  private handleASync(buffer: readonly number[]): AnnotationData | null {
    return buffer[buffer.length - 1] === 0x80 ? [0, ['Synchronization']] : null;
  }

  private handleExceptionExit(_buffer: readonly number[]): AnnotationData {
    return [2, ['Exception exit']];
  }

  private handleExceptionEntry(_buffer: readonly number[]): AnnotationData {
    return [2, ['Exception entry']];
  }

  private handleISync(buffer: readonly number[]): AnnotationData | null {
    if (buffer.length < 6) return null;
    let cycleCount: bigint | null = null;
    let index: number;
    if (buffer[0] === 0x08) {
      index = 1;
    } else {
      const [count, length] = parseVarint(buffer.slice(1, 6));
      cycleCount = count;
      index = 1 + length;
    }
    if (buffer.length <= index + 4) return null;
    const info = buffer[index]!;
    const address = parseUint(buffer.slice(index + 1, index + 5));
    const reasonCode = (info >> 5) & 3;
    const reason = ['Periodic', 'Tracing enabled', 'After overflow', 'Exit from debug'][reasonCode]!;
    const jazelle = (info >> 4) & 1;
    const thumb = address & 1n;
    const pc = address & 0xfffffffen;
    if (reasonCode === 0 && this.currentPc !== pc)
      this.put(this.startSample, this.previousSample, this.outAnn, [
        0,
        [`WARN: Unexpected PC change 0x${hex32(this.currentPc)} -> 0x${hex32(pc)}`],
      ]);
    this.lastBranch = pc;
    this.currentPc = pc;
    this.cpuState = jazelle ? 'jazelle' : thumb ? 'thumb' : 'arm';
    const cycleText = cycleCount === null ? '' : `, cyclecount ${cycleCount}`;
    if (info & 0x80)
      this.put(this.startSample, this.previousSample, this.outAnn, [0, ['WARN: LSIP I-Sync packet not implemented']]);
    return [
      0,
      [`I-Sync: ${reason}, PC 0x${hex32(pc)}, ${this.cpuState} state${cycleText}`, `I-Sync: ${reason} 0x${hex32(pc)}`],
    ];
  }

  private handleTrigger(_buffer: readonly number[]): AnnotationData {
    return [0, ['Trigger event', 'Trigger']];
  }

  private handlePHeader(buffer: readonly number[]): AnnotationData {
    if ((buffer[0]! & 0x83) === 0x80) {
      const skipped = (buffer[0]! >> 6) & 1;
      const executed = (buffer[0]! >> 2) & 15;
      this.instructionsExecuted([...Array<boolean>(executed).fill(true), ...Array<boolean>(skipped).fill(false)]);
      if (skipped)
        return [
          3,
          [
            `${executed} instructions executed, ${skipped} skipped due to condition codes`,
            `${executed} ins exec, ${skipped} skipped`,
            `${executed}E,${skipped}N`,
          ],
        ];
      return [3, [`${executed} instructions executed`, `${executed} ins exec`, `${executed}E`]];
    }
    if ((buffer[0]! & 0xf3) === 0x82) {
      const first = (buffer[0]! >> 3) & 1;
      const second = (buffer[0]! >> 2) & 1;
      this.instructionsExecuted([first === 0, second === 0]);
      const words = ['executed', 'skipped'];
      const short = ['E', 'S'];
      return [
        3,
        [
          `Instruction 1 ${words[first]}, instruction 2 ${words[second]}`,
          `I1 ${short[first]}, I2 ${short[second]}`,
          `${short[first]},${short[second]}`,
        ],
      ];
    }
    return this.fallback(buffer);
  }

  private handleBranch(buffer: readonly number[]): AnnotationData | null {
    if ((buffer[buffer.length - 1]! & 0x80) !== 0) return null;
    const branch = parseBranchAddress(buffer, this.lastBranch, this.cpuState, this.options.branch_enc);
    if (!branch) return null;
    this.lastBranch = branch.address;
    this.currentPc = branch.address;
    let details = '';
    if (branch.cpuState !== this.cpuState) {
      details += `, to ${branch.cpuState} state`;
      this.cpuState = branch.cpuState;
    }
    let classIndex = 1;
    if (branch.exceptionInfo) {
      classIndex = 2;
      const info = branch.exceptionInfo;
      if (info.nonSecure) details += ', to non-secure state';
      if (info.exception) {
        details +=
          info.exception < EXCEPTION_NAMES.length
            ? `, exception ${EXCEPTION_NAMES[info.exception]}`
            : `, exception 0x${info.exception.toString(16).padStart(2, '0')}`;
      }
      if (info.cancelled) details += ', instr cancelled';
      if (info.altIsa) details += ', to AltISA';
      if (info.hypervisor) details += ', to hypervisor';
      if (info.resume) details += `, instr resume 0x${info.resume.toString(16).padStart(2, '0')}`;
    }
    return [classIndex, [`Branch to 0x${hex32(branch.address)}${details}`, `B 0x${hex32(branch.address)}${details}`]];
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const [packetType, , payload] = data as UartData;
    if (packetType !== 'DATA') return;
    const value = payload[0];
    this.byteLength = es - ss;
    if (ss - this.previousSample > 16n * this.byteLength) this.buffer = [];
    this.previousSample = es;
    this.buffer.push(value);
    if (this.buffer.length === 1) this.startSample = ss;
    this.syncBuffer = [...this.syncBuffer.slice(-4), value];
    if (this.syncBuffer.join(',') === '0,0,0,0,128') {
      this.buffer = [...this.syncBuffer];
      this.syncBuffer = [];
    }
    const type = this.packetType(this.buffer[0]!);
    let output: AnnotationData | null;
    if (type === 'a_sync') output = this.handleASync(this.buffer);
    else if (type === 'exception_exit') output = this.handleExceptionExit(this.buffer);
    else if (type === 'exception_entry') output = this.handleExceptionEntry(this.buffer);
    else if (type === 'i_sync') output = this.handleISync(this.buffer);
    else if (type === 'trigger') output = this.handleTrigger(this.buffer);
    else if (type === 'p_header') output = this.handlePHeader(this.buffer);
    else if (type === 'branch') output = this.handleBranch(this.buffer);
    else output = this.fallback(this.buffer);
    if (output !== null) {
      if (output.length) this.put(this.startSample, es, this.outAnn, output);
      this.buffer = [];
    }
  }
}

export default ArmEtmv3Decoder;
