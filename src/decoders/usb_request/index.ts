import { Decoder, OUTPUT_ANN, OUTPUT_BINARY, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface UsbRequestOptions {
  in_request_start: 'submit' | 'first-ack';
}

type RequestType = 'SETUP IN' | 'SETUP OUT' | 'BULK IN' | 'BULK OUT' | null;
type TransactionState = 'IDLE' | 'TOKEN RECEIVED' | 'DATA RECEIVED';

interface RequestState {
  setupData: number[];
  data: number[];
  type: RequestType;
  ss: bigint;
  es: bigint | null;
  ssData: bigint | null;
  id: number;
  addr: number;
  ep: number;
  wLength?: number;
  handshake?: string;
}

function writeU32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

class PcapPacket {
  readonly header = new Uint8Array(64);
  readonly timestamp: readonly [number, number];
  private readonly payload: readonly number[];

  constructor(request: RequestState, timestamp: readonly [number, number], submit: boolean) {
    this.timestamp = timestamp;
    this.payload = request.data;
    this.header[9] = 3;
    this.header[14] = 0x2d;
    this.header[15] = 0x3c;
    writeU32BE(this.header, 4, request.id);
    this.header[8] = submit ? 0x53 : 0x43;
    writeU32BE(this.header, 20, timestamp[0]);
    writeU32BE(this.header, 24, timestamp[1]);
    this.header[11] = request.addr;
    this.header[10] = request.ep;
    if (request.type === 'SETUP IN' || request.type === 'SETUP OUT') {
      this.header[9] = 2;
      this.header[14] = 0;
      for (let index = 0; index < Math.min(8, request.setupData.length); index++)
        this.header[40 + index] = request.setupData[index]! & 0xff;
    }
    if (request.type === 'BULK IN') this.header[10] = 0x80 | request.ep;
    this.header[15] = 0;
    writeU32BE(this.header, 36, request.data.length);
  }

  packet(): Uint8Array {
    const bytes = new Uint8Array(this.header.length + this.payload.length);
    bytes.set(this.header);
    for (let index = 0; index < this.payload.length; index++)
      bytes[this.header.length + index] = this.payload[index]! & 0xff;
    return bytes;
  }

  recordHeader(): Uint8Array {
    const bytes = new Uint8Array(16);
    const length = this.header.length + this.payload.length;
    writeU32BE(bytes, 0, this.timestamp[0]);
    writeU32BE(bytes, 4, this.timestamp[1]);
    writeU32BE(bytes, 8, length);
    writeU32BE(bytes, 12, length);
    return bytes;
  }
}

export class UsbRequestDecoder extends Decoder<UsbRequestOptions> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private secsPerSample = 0;
  private requestId = 0;
  private transactionState: TransactionState = 'IDLE';
  private ssTransaction = 0n;
  private esTransaction = 0n;
  private transactionEp = 0;
  private transactionAddr = 0;
  private transactionType = '';
  private transactionData: number[] = [];
  private handshake = '';
  private requests = new Map<string, RequestState>();
  private wrotePcapHeader = false;
  private outAnn = -1;
  private outBinary = -1;

  constructor(options: Partial<UsbRequestOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.secsPerSample = 0;
    this.requestId = 0;
    this.transactionState = 'IDLE';
    this.ssTransaction = 0n;
    this.esTransaction = 0n;
    this.transactionEp = 0;
    this.transactionAddr = 0;
    this.transactionType = '';
    this.transactionData = [];
    this.handshake = '';
    this.requests = new Map();
    this.wrotePcapHeader = false;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.secsPerSample = value > 0 ? 1 / value : 0;
  }

  private putAnnotation(ss: bigint, es: bigint, classIndex: number, text: string): void {
    this.put(ss, es, this.outAnn, [classIndex, [text]]);
  }

  private putBinary(ss: bigint, bytes: Uint8Array): void {
    this.put(ss, ss, this.outBinary, [0, bytes]);
  }

  private tsFromSample(sample: bigint): readonly [number, number] {
    const seconds = Number(sample) * this.secsPerSample;
    return [Math.trunc(seconds), Math.trunc((seconds % 1) * 1e6)];
  }

  private writePcapHeader(): void {
    if (this.wrotePcapHeader) return;
    const header = Uint8Array.from([
      0xa1, 0xb2, 0xc3, 0xd4, 0x00, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
      0xff, 0x00, 0x00, 0x00, 0xdc,
    ]);
    this.put(0n, 0n, this.outBinary, [0, header]);
    this.wrotePcapHeader = true;
  }

  private key(addr: number, ep: number): string {
    return `${addr}:${ep}`;
  }

  private requestSummary(request: RequestState): string {
    let text = '[';
    if (request.type === 'SETUP IN' || request.type === 'SETUP OUT') {
      for (const byte of request.setupData) text += ` ${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      text += ' ][';
    }
    for (const byte of request.data) text += ` ${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    return `${text} ] : ${request.handshake}`;
  }

  private handleRequest(start: boolean, end: boolean): void {
    if (!start && !end) return;
    this.writePcapHeader();
    const key = this.key(this.transactionAddr, this.transactionEp);
    const request = this.requests.get(key);
    if (!request) return;
    let ssData = request.ssData;
    if (this.options.in_request_start === 'submit') ssData = request.ss;
    if (start) {
      const timestamp = this.tsFromSample(request.ss);
      const packet = new PcapPacket(request, timestamp, true);
      this.putBinary(request.ss, packet.recordHeader());
      this.putBinary(request.ss, packet.packet());
    }
    if (end && request.es !== null) {
      const summary = this.requestSummary(request);
      if (request.type === 'SETUP IN') this.putAnnotation(request.ss, request.es, 0, `SETUP in: ${summary}`);
      else if (request.type === 'SETUP OUT') this.putAnnotation(request.ss, request.es, 1, `SETUP out: ${summary}`);
      else if (request.type === 'BULK IN')
        this.putAnnotation(ssData ?? request.ss, request.es, 2, `BULK in: ${summary}`);
      else if (request.type === 'BULK OUT') this.putAnnotation(request.ss, request.es, 3, `BULK out: ${summary}`);
      const timestamp = this.tsFromSample(request.es);
      const packet = new PcapPacket(request, timestamp, false);
      this.putBinary(request.ss, packet.recordHeader());
      this.putBinary(request.ss, packet.packet());
      this.requests.delete(key);
    }
  }

  private handleTransfer(): void {
    let requestStarted = false;
    const requestEnd = ['ACK', 'STALL', 'timeout'].includes(this.handshake);
    const ep = this.transactionEp;
    const addr = this.transactionAddr;
    const key = this.key(addr, ep);
    const previous = this.requests.get(key);
    if (
      this.transactionType === 'SETUP' &&
      previous &&
      (previous.type === 'SETUP IN' || previous.type === 'SETUP OUT')
    ) {
      previous.es = this.ssTransaction;
      this.handleRequest(false, true);
    }

    let request = this.requests.get(key);
    if (!request) {
      request = {
        setupData: [],
        data: [],
        type: null,
        ss: this.ssTransaction,
        es: null,
        ssData: null,
        id: this.requestId++,
        addr,
        ep,
      };
      this.requests.set(key, request);
      requestStarted = true;
    }
    if (requestEnd) {
      request.es = this.esTransaction;
      request.handshake = this.handshake;
    }

    if ((request.type === null || request.type === 'BULK IN') && this.transactionType === 'IN') {
      request.type = 'BULK IN';
      if (request.data.length === 0 && this.transactionData.length > 0) request.ssData = this.ssTransaction;
      request.data.push(...this.transactionData);
      this.handleRequest(requestStarted, requestEnd);
    } else if ((request.type === null || request.type === 'BULK OUT') && this.transactionType === 'OUT') {
      request.type = 'BULK OUT';
      if (this.handshake === 'ACK') request.data.push(...this.transactionData);
      this.handleRequest(requestStarted, requestEnd);
    } else if (request.type === null && this.transactionType === 'SETUP') {
      request.setupData = this.transactionData;
      request.wLength = (this.transactionData[6] ?? 0) | ((this.transactionData[7] ?? 0) << 8);
      if ((this.transactionData[0] ?? 0) & 0x80) {
        request.type = 'SETUP IN';
        this.handleRequest(true, false);
      } else {
        request.type = 'SETUP OUT';
        this.handleRequest(request.wLength === 0, false);
      }
    } else if (request.type === 'SETUP IN' && this.transactionType === 'IN') {
      request.data.push(...this.transactionData);
    } else if (request.type === 'SETUP OUT' && this.transactionType === 'OUT') {
      if (this.handshake === 'ACK') request.data.push(...this.transactionData);
      if (request.wLength === request.data.length) this.handleRequest(true, false);
    } else if (request.type === 'SETUP IN' && this.transactionType === 'OUT') {
      this.handleRequest(false, requestEnd);
    } else if (request.type === 'SETUP OUT' && this.transactionType === 'IN') {
      this.handleRequest(false, requestEnd);
    }
  }

  private error(ss: bigint, es: bigint, text: string): void {
    this.putAnnotation(ss, es, 4, text);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    if (!Array.isArray(data) || data.length !== 2 || data[0] !== 'PACKET') return;
    const packet = data[1];
    if (!Array.isArray(packet) || packet.length < 2) return;
    const [category, name, info] = packet as [string, string, unknown];

    if (category === 'TOKEN') {
      if (name === 'SOF') return;
      if (this.transactionState === 'TOKEN RECEIVED') {
        let timeout = this.esTransaction;
        timeout += (this.esTransaction - this.ssTransaction) / 2n;
        if (ss > timeout) {
          this.esTransaction = timeout;
          this.handshake = 'timeout';
          this.handleTransfer();
          this.transactionState = 'IDLE';
        }
      }
      if (this.transactionState !== 'IDLE') {
        this.error(ss, es, `ERR: received ${name} token in state ${this.transactionState}`);
        return;
      }
      if (!Array.isArray(info) || info.length < 5) return;
      const [, , addr, ep] = info as [string, string, number, number, number];
      this.transactionData = [];
      this.ssTransaction = ss;
      this.esTransaction = es;
      this.transactionState = 'TOKEN RECEIVED';
      this.transactionEp = ep;
      if (ep > 0 && name === 'IN') this.transactionEp = ep + 0x80;
      this.transactionAddr = addr;
      this.transactionType = name;
      return;
    }

    if (category === 'DATA') {
      if (this.transactionState !== 'TOKEN RECEIVED') {
        this.error(ss, es, `ERR: received ${name} token in state ${this.transactionState}`);
        return;
      }
      this.transactionData = Array.isArray(info) && Array.isArray(info[2]) ? [...(info[2] as number[])] : [];
      this.transactionState = 'DATA RECEIVED';
      return;
    }

    if (category === 'HANDSHAKE') {
      if (this.transactionState !== 'TOKEN RECEIVED' && this.transactionState !== 'DATA RECEIVED') {
        this.error(ss, es, `ERR: received ${name} token in state ${this.transactionState}`);
        return;
      }
      this.handshake = name;
      this.transactionState = 'IDLE';
      this.esTransaction = es;
      this.handleTransfer();
      return;
    }

    if (name !== 'PRE') this.error(ss, es, `ERR: received unhandled ${name} token in state ${this.transactionState}`);
  }
}

export default UsbRequestDecoder;
