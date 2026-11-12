import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, WaitConditions } from '../../libhakeidecode/index.js';
import { bitpack } from '../common.js';
import { descriptor } from './descriptor.js';

const payloadSizes: Readonly<Record<number, string>> = {
  0b000: '8 bit',
  0b001: '32 bit / 4 byte',
  0b010: '64 bit / 8 byte',
  0b011: '96 bit / 12 byte',
  0b100: '128 bit / 16 byte',
  0b101: '256 bit / 32 byte',
  0b110: '512 bit / 64 byte',
  0b111: '288 bit / 36 byte',
};

const payloadByteSizes: Readonly<Record<number, number>> = {
  0b000: 1,
  0b001: 4,
  0b010: 8,
  0b011: 12,
  0b100: 16,
  0b101: 32,
  0b110: 64,
  0b111: 36,
};

const channelTypes: Readonly<Record<number, string>> = {
  0b0000: 'Interface Control / PING',
  0b0001: 'Unsolicited Status (32 bit)',
  0b0010: 'Slave Interface Control / Read',
  0b0011: 'CTS Transfer',
  0b0100: 'Data Channel A',
  0b0101: 'Data Channel B',
  0b0110: 'Data Channel C',
  0b0111: 'Data Channel D',
  0b1000: 'Data Channel E',
  0b1001: 'Data Channel F',
  0b1010: 'Data Channel G',
  0b1011: 'Data Channel H',
  0b1100: 'Reserved',
  0b1101: 'Reserved',
  0b1110: 'Reserved',
  0b1111: 'Reserved',
};

const controlPayloads: Readonly<Record<number, string>> = {
  0x00: 'PING',
  0x01: 'Reserved',
  0x02: 'Slave interface clock multiplier start',
  0x04: 'Slave interface clock multiplier stop',
  0x08: 'Use 5 MBaud for M->S',
  0x10: 'Use 320 MBaud for M->S',
  0x20: 'Use 5 MBaud for S->M',
  0x40: 'Use 20 MBaud for S->M (needs 20 MHz SysClk)',
  0x80: 'Use 320 MBaud for S->M',
  0x31: 'Enable slave interface transmitter',
  0x32: 'Disable slave interface transmitter',
  0x34: 'Enable clock test mode',
  0x38: 'Disable clock test mode and payload loopback',
  0xff: 'Enable payload loopback',
};

const LFAST_ANN = Object.freeze({
  BIT: 0,
  SYNC: 1,
  HEADER_PAYLOAD_SIZE: 2,
  HEADER_CHANNEL_TYPE: 3,
  HEADER_CTS: 4,
  PAYLOAD: 5,
  CONTROL_DATA: 6,
  SLEEP: 7,
  WARNING: 8,
});

type LfastState = 'sync' | 'header' | 'payload' | 'sleepbit';
type LfastPayloadByte = readonly [ss: bigint, es: bigint, value: number];

function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

export class LfastDecoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outProtocol = -1;
  private bitLength = 0xffffffffn;
  private previousBitLength = 0xffffffffn;
  private ss: bigint | null = null;
  private es = 0n;
  private ssPayload: bigint | null = null;
  private esPayload: bigint | null = null;
  private ssByte = 0n;
  private bits: number[] = [];
  private payload: LfastPayloadByte[] = [];
  private payloadSize = 0;
  private timeout = 0n;
  private channelType = 0;
  private state: LfastState = 'sync';
  private ssBit = 0n;
  private esBit = 0n;
  private ssSync = 0n;
  private ssHeader = 0n;

  constructor(options: Partial<Record<string, never>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.previousBitLength = this.bitLength;
    this.ss = null;
    this.es = 0n;
    this.ssPayload = null;
    this.esPayload = null;
    this.ssByte = 0n;
    this.bits = [];
    this.payload = [];
    this.payloadSize = 0;
    this.bitLength = 0n;
    this.timeout = 0n;
    this.channelType = 0;
    this.state = 'sync';
    this.ssBit = 0n;
    this.esBit = 0n;
    this.ssSync = 0n;
    this.ssHeader = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]);
  }

  private scaledTimeout(multiplier: number, bitLength: bigint): bigint {
    return BigInt(Math.trunc(multiplier * Number(bitLength)));
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private handleSync(): void {
    if (this.bits.length === 1) this.ssSync = this.ssBit;
    if (this.bits.length !== 16) return;

    const value = bitpack(this.bits);
    if (value === 0xa84b) {
      this.annotate(this.ssSync, this.esBit, LFAST_ANN.SYNC, ['Sync OK']);
    } else {
      this.annotate(this.ssSync, this.esBit, LFAST_ANN.WARNING, [`Wrong Sync Value: ${hex2(value)}`]);
      this.reset();
      return;
    }

    this.bits = [];
    this.state = 'header';
    this.timeout = this.bitLength * 8n;
  }

  private handleHeader(): void {
    if (this.bits.length === 1) this.ssHeader = this.ssBit;
    if (this.bits.length !== 8) return;

    const fieldLength = this.esBit - this.ssHeader;
    const value = bitpack(this.bits);
    const sizeId = (value & 0xe0) >>> 5;
    const channels = (value & 0x1e) >>> 1;
    const cts = value & 0x01;
    this.payloadSize = payloadByteSizes[sizeId] ?? 0;
    this.channelType = channels;
    const sizeEnd = this.ssHeader + (fieldLength * 3n) / 8n;
    const channelEnd = this.ssHeader + (fieldLength * 7n) / 8n;

    this.annotate(this.ssHeader, sizeEnd, LFAST_ANN.HEADER_PAYLOAD_SIZE, [payloadSizes[sizeId] ?? 'Unknown']);
    this.annotate(sizeEnd, channelEnd, LFAST_ANN.HEADER_CHANNEL_TYPE, [channelTypes[channels] ?? 'Reserved']);
    this.annotate(channelEnd, this.esBit, LFAST_ANN.HEADER_CTS, [String(cts)]);

    this.bits = [];
    this.state = 'payload';
    this.timeout = this.bitLength * BigInt(this.payloadSize * 8);
  }

  private handlePayload(): void {
    this.timeout = BigInt(Math.trunc((this.payloadSize - this.payload.length) * 8 * Number(this.bitLength)));
    if (this.bits.length === 1) {
      this.ssByte = this.ssBit;
      this.ssPayload ??= this.ssBit;
    }
    if (this.bits.length !== 8) return;

    const value = bitpack(this.bits);
    const text = hex2(value);
    if (this.channelType >= 0b0100 && this.channelType <= 0b1011) {
      this.annotate(this.ssByte, this.esBit, LFAST_ANN.PAYLOAD, [text]);
    } else if (this.payload.length === 0) {
      this.annotate(this.ssByte, this.esBit, LFAST_ANN.CONTROL_DATA, [controlPayloads[value] ?? text]);
    } else {
      this.annotate(this.ssByte, this.esBit, LFAST_ANN.CONTROL_DATA, [text]);
    }

    this.bits = [];
    this.esPayload = this.esBit;
    this.payload.push([this.ssByte, this.esPayload, value]);

    if (this.payload.length === this.payloadSize) {
      this.timeout = this.scaledTimeout(1.4, this.bitLength);
      this.state = 'sleepbit';
    }
  }

  private handleSleepBit(): void {
    if (this.bits.length === 0) {
      this.annotate(this.ssBit, this.esBit, LFAST_ANN.SLEEP, ['No LVDS sleep mode request', 'No sleep', 'N']);
    } else if (this.bits.length > 1) {
      this.annotate(this.ssBit, this.esBit, LFAST_ANN.WARNING, [
        `Expected only the sleep bit, got ${this.bits.length} bits instead`,
      ]);
    } else if (this.bits[0] === 1) {
      this.annotate(this.ssBit, this.esBit, LFAST_ANN.SLEEP, ['LVDS sleep mode request', 'Sleep', 'Y']);
    } else {
      this.annotate(this.ssBit, this.esBit, LFAST_ANN.SLEEP, ['No LVDS sleep mode request', 'No sleep', 'N']);
    }

    if (
      this.channelType >= 0b0100 &&
      this.channelType <= 0b1011 &&
      this.payload.length > 0 &&
      this.ssPayload !== null &&
      this.esPayload !== null
    )
      this.put(this.ssPayload, this.esPayload, this.outProtocol, this.payload);
  }

  private processState(): void {
    if (this.state === 'sync') this.handleSync();
    else if (this.state === 'header') this.handleHeader();
    else if (this.state === 'payload') this.handlePayload();
    else {
      this.handleSleepBit();
      this.reset();
    }
  }

  *decode(): LogicGenerator {
    while (true) {
      const conditions: WaitConditions = this.timeout > 0n ? [{ data: 'e' }, { skip: this.timeout }] : { data: 'e' };
      const pins = yield this.wait(conditions);
      const now = this.samplenum;

      if (this.ss === null) {
        this.ss = now;
        this.timeout = this.scaledTimeout(16.2, this.previousBitLength);
        continue;
      }

      const timedOut = this.matched?.[0] !== true && this.matched?.[1] === true;
      let risingEdge = Number(pins[0]) === 1;
      this.es = now;

      if (timedOut) {
        if (this.state === 'sync') {
          this.reset();
          continue;
        }
        if (this.state === 'sleepbit') {
          this.ssBit += this.bitLength;
          this.esBit = this.ssBit + this.bitLength;
          this.handleSleepBit();
          this.reset();
          continue;
        }
        risingEdge = true;
      }

      if (now === this.ss) continue;
      if (this.bitLength === 0n) this.bitLength = now - this.ss;
      const count = Math.floor(Number(now - this.ss) / Number(this.bitLength) + 0.5);
      if (count === 0) {
        this.annotate(this.ss, now, LFAST_ANN.WARNING, ['Bit time too short']);
        this.reset();
        continue;
      }

      const bitValue = risingEdge ? 0 : 1;
      const span = now - this.ss;
      for (let index = 0; index < count; index++) {
        this.ssBit = this.ss + (span * BigInt(index)) / BigInt(count);
        this.esBit = this.ss + (span * BigInt(index + 1)) / BigInt(count);
        this.annotate(this.ssBit, this.esBit, LFAST_ANN.BIT, [String(bitValue)]);
        this.bits.unshift(bitValue);
        this.processState();
        if (this.ss === null) break;
      }

      if (this.ss !== null) this.ss = this.samplenum;
    }
  }
}

export default LfastDecoder;
