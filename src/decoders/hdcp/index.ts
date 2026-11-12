import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import type { I2CProtocolPacket } from '../i2c/index.js';
import { descriptor } from './descriptor.js';

const MESSAGE_IDS: Readonly<Record<number, string>> = {
  2: 'AKE_Init',
  3: 'AKE_Send_Cert',
  4: 'AKE_No_stored_km',
  5: 'AKE_Stored_km',
  7: 'AKE_Send_H_prime',
  8: 'AKE_Send_Pairing_Info',
  9: 'LC_Init',
  10: 'LC_Send_L_prime',
  11: 'SKE_Send_Eks',
  12: 'RepeaterAuth_Send_ReceiverID_List',
  15: 'RepeaterAuth_Send_Ack',
  16: 'RepeaterAuth_Stream_Manage',
  17: 'RepeaterAuth_Stream_Ready',
};

const WRITE_ITEMS: Readonly<Record<number, string>> = {
  0x00: '1.4 Bksv - Receiver KSV',
  0x08: "1.4 Ri' - Link Verification",
  0x0a: "1.4 Pj' - Enhanced Link Verification",
  0x10: '1.4 Aksv - Transmitter KSV',
  0x15: '1.4 Ainfo - Transmitter KSV',
  0x18: '1.4 An - Session random number',
  0x20: "1.4 V'H0",
  0x24: "1.4 V'H1",
  0x28: "1.4 V'H2",
  0x2c: "1.4 V'H3",
  0x30: "1.4 V'H4",
  0x40: '1.4 Bcaps',
  0x41: '1.4 Bstatus',
  0x43: '1.4 KSV FIFO',
  0x50: 'HDCP2Version',
  0x60: 'Write_Message',
  0x70: 'RxStatus',
  0x80: 'Read_Message',
};

export type HdcpProtocolPacket = ['MESSAGE', message: number, text: string] | ['SUMMARY', text: string];

export class HdcpDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;
  private outAnn = -1;
  private outProtocol = -1;
  private state = 'IDLE';
  private stack: number[] = [];
  private ssBlock = 0n;
  private esBlock = 0n;
  private type = '';

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = 'IDLE';
    this.stack = [];
    this.ssBlock = 0n;
    this.esBlock = 0n;
    this.type = '';
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'hdcp');
  }

  private putBlock(classIndex: number, text: string, packet: HdcpProtocolPacket): void {
    this.put(this.ssBlock, this.esBlock, this.outAnn, [classIndex, [text]]);
    this.put(this.ssBlock, this.esBlock, this.outProtocol, packet);
  }

  private putMessage(message: number, text: string): void {
    const classIndex = message >= 0 && message < 18 ? message : 18;
    this.put(this.ssBlock, this.esBlock, this.outAnn, [classIndex, [text]]);
    this.put(this.ssBlock, this.esBlock, this.outProtocol, ['MESSAGE', message, text]);
  }

  private finishBuffer(): void {
    this.esBlock = this.samplenum;
    this.state = 'IDLE';
    if (!this.type) return;
    if (!this.stack.length) {
      this.putBlock(18, this.type, ['SUMMARY', this.type]);
      return;
    }
    if (this.type === 'RxStatus') {
      const high = this.stack.pop() ?? 0,
        low = this.stack.pop() ?? 0,
        rxstatus = (high << 8) | low,
        text =
          this.type +
          ', reauth ' +
          (rxstatus & 0x800 ? 'True' : 'False') +
          ', ready ' +
          (rxstatus & 0x400 ? 'True' : 'False') +
          ', length ' +
          (rxstatus & 0x3ff);
      this.putBlock(18, text, ['SUMMARY', text]);
      return;
    }
    if (this.type === '1.4 Bstatus') {
      const high = this.stack.pop() ?? 0,
        low = this.stack.pop() ?? 0,
        bstatus = (high << 8) | low,
        text =
          this.type +
          ', ' +
          (bstatus & 0x7f) +
          ' devices, depth ' +
          ((bstatus & 0x700) >> 8) +
          ', hdmi mode ' +
          (bstatus & 0x1000 ? 'True' : 'False');
      this.putBlock(18, text, ['SUMMARY', text]);
      return;
    }
    if (this.type === 'Read_Message' || this.type === 'Write_Message') {
      const message = this.stack.shift() ?? 0,
        text = this.type + ', ' + (MESSAGE_IDS[message] ?? 'Invalid');
      this.putMessage(message, text);
      return;
    }
    if (this.type === 'HDCP2Version') {
      const version = this.stack.shift() ?? 0,
        text = version & 0x4 ? 'HDCP2' : 'NOT HDCP2';
      this.putBlock(18, text, ['SUMMARY', text]);
      return;
    }
    this.putBlock(18, this.type, ['SUMMARY', this.type]);
  }

  private process(command: string, value: number | null, ss: bigint, es: bigint): void {
    if (this.state === 'IDLE') {
      if (command === 'START') {
        this.reset();
        this.ssBlock = ss;
      } else if (command !== 'START REPEAT') return;
      this.state = 'GET SLAVE ADDR';
      return;
    }
    if (this.state === 'GET SLAVE ADDR') {
      if (command === 'ADDRESS READ') {
        this.state = 'BUFFER DATA';
        if (value !== 0x3a) this.state = 'IDLE';
      } else if (command === 'ADDRESS WRITE') {
        this.state = 'WRITE OFFSET';
        if (value !== 0x3a) this.state = 'IDLE';
      }
      return;
    }
    if (this.state === 'WRITE OFFSET') {
      if (command !== 'DATA WRITE' || value === null) return;
      this.type = WRITE_ITEMS[value] ?? this.type;
      if (value === 0x10 || value === 0x15 || value === 0x18 || value === 0x60) this.state = 'BUFFER DATA';
      else if (this.type) this.state = 'IDLE';
      return;
    }
    if (this.state !== 'BUFFER DATA') return;
    if (command === 'STOP' || command === 'NACK') {
      this.esBlock = es;
      this.finishBuffer();
    } else if ((command === 'DATA READ' || command === 'DATA WRITE') && value !== null) {
      this.stack.push(value);
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as I2CProtocolPacket;
    if (!Array.isArray(packet)) return;
    if (packet[0] === 'START') {
      this.process(packet[1] ? 'START REPEAT' : 'START', null, ss, es);
    } else if (packet[0] === 'STOP') {
      this.process('STOP', null, ss, es);
    } else if (packet[0] === 'ADDRESS') {
      const address = packet[2] >>> 1,
        command = packet[1] === 'read' ? 'ADDRESS READ' : 'ADDRESS WRITE';
      this.process(command, address, ss, es);
      if (!packet[3]) this.process('NACK', null, es, es);
    } else if (packet[0] === 'DATA') {
      const command = packet[1] === 'read' ? 'DATA READ' : 'DATA WRITE';
      this.process(command, packet[2], ss, es);
      if (!packet[3]) this.process('NACK', null, es, es);
    }
  }
}

export default HdcpDecoder;
