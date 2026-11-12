import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';
import { deviceName } from './parts.js';

const ANN = Object.freeze({
  PE: 0,
  RSB0: 1,
  RSB1: 2,
  RSB2: 3,
  CE: 4,
  RFB: 5,
  RHFB: 6,
  REFB: 7,
  RLB: 8,
  REEM: 9,
  RP: 10,
  LPMP: 11,
  WP: 12,
  WARNING: 13,
  DEVICE: 14,
});

const VENDORS: Readonly<Record<number, string>> = { 0x00: 'Device locked', 0x1e: 'Atmel' };

interface WireByte {
  readonly value: number | null;
  readonly ss: bigint;
  readonly es: bigint;
}

function wordWidth(value: number | null): number {
  if (value === null || value === 0) return 1;
  return Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
}

function hex(value: number, width = 2): string {
  return (value & 0xff).toString(16).padStart(width, '0');
}

export class AvrIspDecoder extends Decoder {
  static descriptor = descriptor;
  private outAnn = -1;
  private mosiBytes: number[] = [];
  private misoBytes: number[] = [];
  private ssCmd = 0n;
  private esCmd = 0n;
  private xx = 0;
  private yy = 0;
  private mm = 0;
  private ssDevice: bigint | null = null;
  private vendorCode = 0;
  private partFamily = 0;
  private partNumber = 0;

  override reset(): void {
    this.mosiBytes = [];
    this.misoBytes = [];
    this.ssCmd = 0n;
    this.esCmd = 0n;
    this.xx = 0;
    this.yy = 0;
    this.mm = 0;
    this.ssDevice = null;
    this.vendorCode = 0;
    this.partFamily = 0;
    this.partNumber = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putCommand(classIndex: number, texts: readonly string[], ss = this.ssCmd, es = this.esCmd): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private warning(text: string): void {
    this.putCommand(ANN.WARNING, [text]);
  }

  private handleProgrammingEnable(cmd: readonly number[], ret: readonly number[]): void {
    this.putCommand(ANN.PE, ['Programming enable']);
    if (ret[1] !== 0xac || ret[2] !== 0x53 || ret[3] !== cmd[2]) this.warning('Warning: Unexpected bytes in reply!');
  }

  private handleSignature0(cmd: readonly number[], ret: readonly number[]): void {
    this.vendorCode = ret[3]!;
    this.putCommand(ANN.RSB0, [`Vendor code: 0x${hex(ret[3]!)} (${VENDORS[this.vendorCode] ?? 'Unknown'})`]);
    this.xx = cmd[1]!;
    this.yy = cmd[3]!;
    if (ret[1] !== 0x30 || ret[2] !== cmd[1]) this.warning('Warning: Unexpected bytes in reply!');
    if (this.vendorCode !== 0x1e) this.warning('Warning: Vendor code was not 0x1e (Atmel)!');
  }

  private handleSignature1(cmd: readonly number[], ret: readonly number[]): void {
    this.partFamily = ret[3]!;
    this.putCommand(ANN.RSB1, [`Part family / memory size: 0x${hex(ret[3]!)}`]);
    this.mm = cmd[3]!;
    this.ssDevice = this.ssCmd;
    if (ret[1] !== 0x30 || ret[2] !== cmd[1] || ret[0] !== this.yy) this.warning('Warning: Unexpected bytes in reply!');
  }

  private handleSignature2(cmd: readonly number[], ret: readonly number[]): void {
    this.partNumber = ret[3]!;
    this.putCommand(ANN.RSB2, [`Part number: 0x${hex(ret[3]!)}`]);
    const name = deviceName(this.partFamily, this.partNumber);
    if (name) this.putCommand(ANN.DEVICE, [`Device: Atmel ${name}`], this.ssDevice ?? this.ssCmd);
    if (ret[1] !== 0x30 || ret[2] !== this.xx || ret[0] !== this.mm)
      this.warning('Warning: Unexpected bytes in reply!');
    this.xx = 0;
    this.yy = 0;
    this.mm = 0;
  }

  private handleChipErase(cmd: readonly number[], ret: readonly number[]): void {
    this.putCommand(ANN.CE, ['Chip erase']);
    const bit = (ret[2]! & 0x80) >> 7;
    if (ret[1] !== 0xac || bit !== 1 || ret[3] !== cmd[2]) this.warning('Warning: Unexpected bytes in reply!');
  }

  private handleReadProgramMemory(cmd: readonly number[], ret: readonly number[]): void {
    const high = (cmd[0]! & 0x08) !== 0,
      label = high ? 'High' : 'Low',
      suffix = high ? 'H' : 'L',
      address = ((cmd[1]! & 0x0f) << 8) + cmd[2]!;
    this.putCommand(ANN.RP, [
      `Read program memory ${label}: [0x${address.toString(16).padStart(3, '0')}]: 0x${hex(ret[3]!)}`,
      `[${address.toString(16).padStart(3, '0')}${suffix}]:${hex(ret[3]!)}`,
      hex(ret[3]!),
    ]);
  }

  private handleLoadProgramMemoryPage(cmd: readonly number[]): void {
    const high = (cmd[0]! & 0x08) !== 0,
      label = high ? 'High' : 'Low',
      suffix = high ? 'H' : 'L',
      address = cmd[2]! & 0x1f;
    this.putCommand(ANN.LPMP, [
      `Load program memory page ${label}: [0x${address.toString(16).padStart(3, '0')}]: 0x${hex(cmd[3]!)}`,
      `[${address.toString(16).padStart(3, '0')}${suffix}]=${hex(cmd[3]!)}`,
      hex(cmd[3]!),
    ]);
  }

  private handleCommand(cmd: readonly number[], ret: readonly number[]): void {
    if (cmd[0] === 0xac && cmd[1] === 0x53) this.handleProgrammingEnable(cmd, ret);
    else if (cmd[0] === 0xac && (cmd[1]! & 0x80) !== 0) this.handleChipErase(cmd, ret);
    else if (cmd[0] === 0x50 && cmd[1] === 0x00 && cmd[2] === 0x00)
      this.putCommand(ANN.RFB, [`Read fuse bits: 0x${hex(ret[3]!)}`]);
    else if (cmd[0] === 0x58 && cmd[1] === 0x08 && cmd[2] === 0x00)
      this.putCommand(ANN.RHFB, [`Read fuse high bits: 0x${hex(ret[3]!)}`]);
    else if (cmd[0] === 0x50 && cmd[1] === 0x08 && cmd[2] === 0x00)
      this.putCommand(ANN.REFB, [`Read extended fuse bits: 0x${hex(ret[3]!)}`]);
    else if (cmd[0] === 0x30 && cmd[2] === 0x00) this.handleSignature0(cmd, ret);
    else if (cmd[0] === 0x30 && cmd[2] === 0x01) this.handleSignature1(cmd, ret);
    else if (cmd[0] === 0x30 && cmd[2] === 0x02) this.handleSignature2(cmd, ret);
    else if (cmd[0] === 0x58 && cmd[1] === 0x00) this.putCommand(ANN.RLB, [`Read lock bits: 0x${hex(ret[3]!)}`]);
    else if (cmd[0] === 0xa0 && (cmd[1]! & 0xc0) === 0) {
      const address = ((cmd[1]! & 1) << 8) + cmd[2]!;
      this.putCommand(ANN.REEM, [
        `Read EEPROM Memory: [0x${address.toString(16).padStart(3, '0')}]: 0x${hex(ret[3]!)}`,
      ]);
    } else if ((cmd[0] === 0x20 || cmd[0] === 0x28) && (cmd[1]! & 0xf0) === 0) this.handleReadProgramMemory(cmd, ret);
    else if ((cmd[0] === 0x40 || cmd[0] === 0x48) && (cmd[1]! & 0xf0) === 0) this.handleLoadProgramMemoryPage(cmd);
    else if (cmd[0] === 0x4c && (cmd[1]! & 0xf0) === 0) {
      const address = ((cmd[1]! & 0x0f) << 3) + (cmd[2]! << 5);
      this.putCommand(ANN.WP, [`Write program memory page: 0x${address.toString(16)}`]);
    } else {
      this.warning(
        `Unknown command: ${cmd.map((value) => hex(value)).join(' ')} (reply: ${ret
          .map((value) => hex(value))
          .join(' ')})!`,
      );
    }
  }

  private consume(mosi: WireByte[], miso: WireByte[]): void {
    for (let index = 0; index < mosi.length; index++) {
      const mosiByte = mosi[index]!,
        misoByte = miso[index]!;
      if (!this.mosiBytes.length) this.ssCmd = mosiByte.ss;
      this.mosiBytes.push(mosiByte.value ?? 0);
      this.misoBytes.push(misoByte.value ?? 0);
      if (this.mosiBytes.length < 4) continue;
      this.esCmd = misoByte.es;
      this.handleCommand(this.mosiBytes, this.misoBytes);
      this.mosiBytes = [];
      this.misoBytes = [];
    }
  }

  private split(ss: bigint, es: bigint, mosi: number | null, miso: number | null): [WireByte[], WireByte[]] {
    const count = Math.max(wordWidth(mosi), wordWidth(miso)),
      span = es - ss,
      mosiValue = mosi ?? 0,
      misoValue = miso ?? 0,
      mosiBytes: WireByte[] = [],
      misoBytes: WireByte[] = [];
    for (let index = 0; index < count; index++) {
      const dataSs = ss + (span * BigInt(index)) / BigInt(count),
        dataEs = ss + (span * BigInt(index + 1)) / BigInt(count),
        shift = 8 * (count - index - 1);
      mosiBytes.push({
        value: mosi === null ? null : Math.floor(mosiValue / 2 ** shift) & 0xff,
        ss: dataSs,
        es: dataEs,
      });
      misoBytes.push({
        value: miso === null ? null : Math.floor(misoValue / 2 ** shift) & 0xff,
        ss: dataSs,
        es: dataEs,
      });
    }
    return [mosiBytes, misoBytes];
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    if (data[0] === 'WARNING') return;
    if (data[0] !== 'WORD') return;
    const mosi = typeof data[1] === 'number' ? data[1] : null,
      miso = typeof data[2] === 'number' ? data[2] : null;
    if (mosi === null && miso === null) return;
    this.consume(...this.split(ss, es, mosi, miso));
  }
}

export default AvrIspDecoder;
