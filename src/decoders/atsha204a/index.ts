import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import type { I2CDirection, I2CProtocolPacket } from '../i2c/index.js';
import { descriptor } from './descriptor.js';

const WORD_ADDRESS: Readonly<Record<number, string>> = {
  0x00: 'RESET',
  0x01: 'SLEEP',
  0x02: 'IDLE',
  0x03: 'COMMAND',
};

const OPCODES: Readonly<Record<number, string>> = {
  0x01: 'Pause',
  0x02: 'Read',
  0x08: 'MAC',
  0x11: 'HMAC',
  0x12: 'Write',
  0x15: 'GenDig',
  0x16: 'Nonce',
  0x17: 'Lock',
  0x1b: 'Random',
  0x1c: 'DeriveKey',
  0x20: 'UpdateExtra',
  0x24: 'Counter',
  0x28: 'CheckMac',
  0x30: 'DevRev',
  0x40: 'GenKey',
  0x41: 'Sign',
  0x43: 'ECDH',
  0x45: 'Verify',
  0x46: 'PrivWrite',
  0x47: 'SHA',
};

const ZONES: Readonly<Record<number, string>> = {
  0x00: 'CONFIG',
  0x01: 'OTP',
  0x02: 'DATA',
};

const STATUS: Readonly<Record<number, string>> = {
  0x00: 'Command success',
  0x01: 'Checkmac failure',
  0x03: 'Parse error',
  0x0f: 'Execution error',
  0x11: 'Ready',
  0xff: 'CRC / communications error',
};

interface ByteRecord {
  ss: bigint;
  es: bigint;
  value: number;
}

type State = 'IDLE' | 'GET SLAVE ADDR' | 'READ REGS' | 'WRITE REGS';

function hex(value: number, digits = 2): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

function dataEnd(_ss: bigint, es: bigint): bigint {
  return es;
}

function dataInterval(record: ByteRecord): [bigint, bigint] {
  return [record.ss, dataEnd(record.ss, record.es)];
}

function byteText(records: readonly ByteRecord[]): string {
  return records.map((record) => record.value.toString(16).padStart(2, '0')).join(' ');
}

export class Atsha204aDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private state: State = 'IDLE';
  private waddr = -1;
  private opcode = -1;
  private bytes: ByteRecord[] = [];

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = 'IDLE';
    this.waddr = -1;
    this.opcode = -1;
    this.bytes = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private warning(records: readonly ByteRecord[], message: string): void {
    if (!records.length) return;
    this.annotate(records[0]!.ss, records.at(-1)!.es, 8, [`Warning: ${message}`]);
  }

  private putWaddr(record: ByteRecord): void {
    const name = WORD_ADDRESS[record.value] ?? `0x${hex(record.value)}`;
    this.annotate(...dataInterval(record), 0, [`Word addr: ${name}`]);
  }

  private putCount(record: ByteRecord): void {
    this.annotate(...dataInterval(record), 1, [`Count: ${record.value}`]);
  }

  private putOpcode(record: ByteRecord): void {
    const name = OPCODES[record.value] ?? `0x${hex(record.value)}`;
    this.annotate(...dataInterval(record), 2, [`Opcode: ${name}`]);
  }

  private putParam1(record: ByteRecord): void {
    const value = record.value;
    let text: string;
    switch (this.opcode) {
      case 0x28:
      case 0x24:
      case 0x30:
      case 0x43:
      case 0x40:
      case 0x11:
      case 0x08:
      case 0x16:
      case 0x1b:
      case 0x47:
      case 0x41:
      case 0x45:
        text = `Mode: ${hex(value)}`;
        break;
      case 0x1c:
        text = `Random: ${value}`;
        break;
      case 0x46:
        text = `Encrypted: ${value & 0x40 ? 'Yes' : 'No'}`;
        break;
      case 0x15:
        text = `Zone: ${ZONES[value] ?? hex(value)}`;
        break;
      case 0x17:
        text = `Zone: ${value ? 'DATA/OTP' : 'CONFIG'}, Summary: ${value & 0x80 ? 'Ignored' : 'Used'}`;
        break;
      case 0x01:
        text = `Selector: ${hex(value)}`;
        break;
      case 0x02:
        text = `Zone: ${ZONES[value & 0x03] ?? hex(value & 0x03)}, Length: ${value & 0x90 ? '32 bytes' : '4 bytes'}`;
        break;
      case 0x12:
        text =
          `Zone: ${ZONES[value & 0x03] ?? hex(value & 0x03)}, Encrypted: ${value & 0x40 ? 'Yes' : 'No'}, ` +
          `Length: ${value & 0x90 ? '32 bytes' : '4 bytes'}`;
        break;
      default:
        text = `Param1: ${hex(value)}`;
    }
    this.annotate(...dataInterval(record), 3, [text]);
  }

  private putParam2(low: ByteRecord, high: ByteRecord): void {
    const pair = `${high.value.toString(16).padStart(2, '0')} ${low.value.toString(16).padStart(2, '0')}`;
    let text: string;
    switch (this.opcode) {
      case 0x1c:
        text = `TargetKey: ${pair}`;
        break;
      case 0x24:
      case 0x43:
      case 0x40:
      case 0x46:
      case 0x41:
      case 0x45:
        text = `KeyID: ${pair}`;
        break;
      case 0x16:
      case 0x01:
      case 0x1b:
        text = `Zero: ${pair}`;
        break;
      case 0x11:
      case 0x08:
      case 0x28:
      case 0x15:
        text = `SlotID: ${pair}`;
        break;
      case 0x17:
        text = `Summary: ${pair}`;
        break;
      case 0x02:
      case 0x12:
        text = `Address: ${pair}`;
        break;
      case 0x20:
        text = `NewValue: ${low.value.toString(16).padStart(2, '0')}`;
        break;
      default:
        text = '-';
    }
    this.annotate(low.ss, dataEnd(high.ss, high.es), 4, [text]);
  }

  private putData(records: readonly ByteRecord[]): void {
    if (!records.length) return;
    const opcode = this.opcode;
    if (opcode === 0x28) {
      const clientChallenge = records.slice(0, 32),
        clientResponse = records.slice(32, 64),
        otherData = records.slice(64, 77);
      if (clientChallenge.length)
        this.annotate(records[0]!.ss, dataEnd(clientChallenge.at(-1)!.ss, clientChallenge.at(-1)!.es), 5, [
          `ClientChal: ${byteText(clientChallenge)}`,
        ]);
      if (clientResponse.length)
        this.annotate(records[32]!.ss, dataEnd(clientResponse.at(-1)!.ss, clientResponse.at(-1)!.es), 5, [
          `ClientResp: ${byteText(clientResponse)}`,
        ]);
      if (otherData.length)
        this.annotate(records[64]!.ss, dataEnd(otherData.at(-1)!.ss, otherData.at(-1)!.es), 5, [
          `OtherData: ${byteText(otherData)}`,
        ]);
    } else if (opcode === 0x1c) {
      this.annotate(records[0]!.ss, dataEnd(records.at(-1)!.ss, records.at(-1)!.es), 5, [`MAC: ${byteText(records)}`]);
    } else if (opcode === 0x43) {
      const x = records.slice(0, 32),
        y = records.slice(32, 64);
      if (x.length) this.annotate(records[0]!.ss, dataEnd(x.at(-1)!.ss, x.at(-1)!.es), 5, [`Pub X: ${byteText(x)}`]);
      if (y.length) this.annotate(records[32]!.ss, dataEnd(y.at(-1)!.ss, y.at(-1)!.es), 5, [`Pub Y: ${byteText(y)}`]);
    } else if (opcode === 0x15 || opcode === 0x40) {
      this.annotate(records[0]!.ss, dataEnd(records.at(-1)!.ss, records.at(-1)!.es), 5, [
        `OtherData: ${byteText(records)}`,
      ]);
    } else if (opcode === 0x08) {
      this.annotate(records[0]!.ss, dataEnd(records.at(-1)!.ss, records.at(-1)!.es), 5, [
        `Challenge: ${byteText(records)}`,
      ]);
    } else if (opcode === 0x46) {
      if (records.length > 36) {
        const value = records.slice(0, -32),
          mac = records.slice(-32);
        this.annotate(records[0]!.ss, dataEnd(value.at(-1)!.ss, value.at(-1)!.es), 5, [`Value: ${byteText(value)}`]);
        this.annotate(mac[0]!.ss, dataEnd(mac.at(-1)!.ss, mac.at(-1)!.es), 5, [`MAC: ${byteText(mac)}`]);
      } else {
        this.annotate(records[0]!.ss, dataEnd(records.at(-1)!.ss, records.at(-1)!.es), 5, [
          `Value: ${byteText(records)}`,
        ]);
      }
    } else if (opcode === 0x45) {
      if (records.length >= 64) {
        const r = records.slice(0, 32),
          s = records.slice(32, 64);
        this.annotate(records[0]!.ss, dataEnd(r.at(-1)!.ss, r.at(-1)!.es), 5, [`ECDSA R: ${byteText(r)}`]);
        this.annotate(records[32]!.ss, dataEnd(s.at(-1)!.ss, s.at(-1)!.es), 5, [`ECDSA S: ${byteText(s)}`]);
      }
      if (records.length === 83) {
        const other = records.slice(64, 83);
        this.annotate(other[0]!.ss, dataEnd(other.at(-1)!.ss, other.at(-1)!.es), 5, [`OtherData: ${byteText(other)}`]);
      } else if (records.length === 128) {
        const x = records.slice(64, 96),
          y = records.slice(96, 128);
        this.annotate(x[0]!.ss, dataEnd(x.at(-1)!.ss, x.at(-1)!.es), 5, [`Pub X: ${byteText(x)}`]);
        this.annotate(y[0]!.ss, dataEnd(y.at(-1)!.ss, y.at(-1)!.es), 5, [`Pub Y: ${byteText(y)}`]);
      }
    } else if (opcode === 0x12) {
      if (records.length > 32) {
        const value = records.slice(0, -32),
          mac = records.slice(-32);
        this.annotate(records[0]!.ss, dataEnd(value.at(-1)!.ss, value.at(-1)!.es), 5, [`Value: ${byteText(value)}`]);
        this.annotate(mac[0]!.ss, dataEnd(mac.at(-1)!.ss, mac.at(-1)!.es), 5, [`MAC: ${byteText(mac)}`]);
      } else {
        this.annotate(records[0]!.ss, dataEnd(records.at(-1)!.ss, records.at(-1)!.es), 5, [
          `Value: ${byteText(records)}`,
        ]);
      }
    } else {
      this.annotate(records[0]!.ss, dataEnd(records.at(-1)!.ss, records.at(-1)!.es), 5, [`Data: ${byteText(records)}`]);
    }
  }

  private putCrc(records: readonly ByteRecord[]): void {
    if (records.length < 2) return;
    this.annotate(records[0]!.ss, dataEnd(records[1]!.ss, records[1]!.es), 6, [
      `CRC: ${hex(records[0]!.value)} ${hex(records[1]!.value)}`,
    ]);
  }

  private putStatus(records: readonly ByteRecord[], value: number): void {
    if (!records.length) return;
    this.annotate(records[0]!.ss, records.at(-1)!.es, 7, [`Status: ${STATUS[value] ?? `0x${hex(value)}`}`]);
  }

  private outputTx(): void {
    const bytes = this.bytes;
    if (!bytes.length) return;
    this.waddr = bytes[0]!.value;
    this.putWaddr(bytes[0]!);
    if (this.waddr !== 0x03) return;
    if (bytes.length < 2) {
      this.warning(bytes, 'Invalid command frame: missing count');
      return;
    }
    const count = bytes[1]!.value;
    this.putCount(bytes[1]!);
    if (bytes.length - 1 !== count) {
      this.warning(bytes, `Invalid frame length: Got ${bytes.length - 1}, expecting ${count} `);
      return;
    }
    if (bytes.length < 8) {
      this.warning(bytes, 'Invalid command frame: too short');
      return;
    }
    this.opcode = bytes[2]!.value;
    this.putOpcode(bytes[2]!);
    this.putParam1(bytes[3]!);
    this.putParam2(bytes[4]!, bytes[5]!);
    this.putData(bytes.slice(6, -2));
    this.putCrc(bytes.slice(-2));
  }

  private outputRx(): void {
    const bytes = this.bytes;
    if (!bytes.length) return;
    const count = bytes[0]!.value;
    this.putCount(bytes[0]!);
    if (this.waddr === 0x00) {
      if (bytes.length < 4) {
        this.warning(bytes, 'Invalid reset response');
        return;
      }
      this.putData([bytes[1]!]);
      this.putCrc(bytes.slice(2, 4));
      this.putStatus(bytes, bytes[1]!.value);
    } else if (this.waddr === 0x03) {
      if (count === 4) {
        if (bytes.length < 4) {
          this.warning(bytes, 'Invalid status response');
          return;
        }
        this.putData([bytes[1]!]);
        this.putCrc(bytes.slice(2, 4));
        this.putStatus(bytes, bytes[1]!.value);
      } else if (bytes.length >= 3) {
        this.putData(bytes.slice(1, -2));
        this.putCrc(bytes.slice(-2));
      } else {
        this.warning(bytes, 'Invalid command response');
      }
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as I2CProtocolPacket;
    switch (packet[0]) {
      case 'START':
        this.state = 'GET SLAVE ADDR';
        this.bytes = [];
        return;
      case 'STOP':
        if (this.state === 'READ REGS') {
          this.opcode = -1;
          this.outputRx();
          this.waddr = -1;
        } else if (this.state === 'WRITE REGS') {
          this.outputTx();
        }
        this.bytes = [];
        this.state = 'IDLE';
        return;
      case 'ADDRESS':
        if (this.state !== 'GET SLAVE ADDR') return;
        this.state = packet[1] === 'read' ? 'READ REGS' : 'WRITE REGS';
        return;
      case 'DATA': {
        const direction: I2CDirection = packet[1],
          value = packet[2];
        if (this.state === 'READ REGS' && direction === 'read') this.bytes.push({ ss, es, value });
        else if (this.state === 'WRITE REGS' && direction === 'write') this.bytes.push({ ss, es, value });
        return;
      }
      default:
        return;
    }
  }
}

export default Atsha204aDecoder;
