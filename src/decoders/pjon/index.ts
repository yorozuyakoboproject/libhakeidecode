import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

const ANN = Object.freeze({
  RX_INFO: 0,
  HDR_CFG: 1,
  PKT_LEN: 2,
  META_CRC: 3,
  TX_INFO: 4,
  SVC_ID: 5,
  PKT_ID: 6,
  ANON_DATA: 7,
  PAYLOAD: 8,
  END_CRC: 9,
  SYN_RSP: 10,
  RELATION: 11,
  WARN: 12,
});

interface FieldDescription {
  format: string;
  width: number;
  readonly handler: (values: readonly number[]) => readonly string[];
  readonly anncls: number;
}

function calcCrc8(data: readonly number[]): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const odd = crc & 1;
      crc >>>= 1;
      if (odd) crc ^= 0x97;
    }
  }
  return crc & 0xff;
}

function calcCrc32(data: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const odd = crc & 1;
      crc >>>= 1;
      if (odd) crc = (crc ^ 0xedb88320) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hex(value: number, width = 2): string {
  return (value >>> 0).toString(16).padStart(width, '0');
}

function bytesToNumber(values: readonly number[]): number {
  let value = 0;
  for (const byte of values) value = value * 256 + byte;
  return value;
}

export class PjonDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private frameSs: bigint | null = null;
  private frameEs: bigint | null = null;
  private frameRxText: string | null = null;
  private frameTxText: string | null = null;
  private framePayloadText: string | null = null;
  private frameBytes: number[] | null = null;
  private frameHasAck: number | null = null;
  private frameIsBroadcast = false;
  private ackBytes: number[] | null = null;
  private annSs: bigint | null = null;
  private annEs: bigint | null = null;
  private fieldDesc: FieldDescription[] = [];
  private fieldDescIndex = 0;
  private fieldDescGot = 0;
  private cfgShared = 0;
  private cfgTxInfo = 0;
  private cfgSyncAck = 0;
  private cfgAsyncAck = 0;
  private cfgPort = 0;
  private cfgCrc32 = 0;
  private cfgLen16 = 0;
  private cfgPktId = 0;
  private cfgOverhead = 0;
  private outAnn = -1;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.resetFrame();
  }

  private resetFrame(): void {
    this.frameSs = null;
    this.frameEs = null;
    this.frameRxText = null;
    this.frameTxText = null;
    this.framePayloadText = null;
    this.frameBytes = null;
    this.frameHasAck = null;
    this.ackBytes = null;
    this.annSs = null;
    this.annEs = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putg(ss: bigint | null, es: bigint | null, classIndex: number, texts: readonly string[]): void {
    const start = ss ?? this.annSs ?? this.samplenum;
    const end = es ?? this.annEs ?? start;
    this.put(start, end, this.outAnn, [classIndex, texts]);
  }

  private frameFlush(): void {
    if (!this.frameBytes?.length || this.frameSs === null || this.frameEs === null) return;
    const parts: string[] = [];
    if (this.frameRxText !== null) parts.push(`RX ${this.frameRxText}`);
    if (this.frameTxText !== null) parts.push(`TX ${this.frameTxText}`);
    if (this.framePayloadText !== null) parts.push(`DATA ${this.framePayloadText}`);
    if (this.frameHasAck !== null) parts.push(`ACK ${hex(this.frameHasAck)}`);
    if (parts.length) this.putg(this.frameSs, this.frameEs, ANN.RELATION, [parts.join(' - ')]);
  }

  private fieldGetDesc(index = this.fieldDescIndex): FieldDescription | null {
    const resolved = index < 0 ? this.fieldDesc.length + index : index;
    return this.fieldDesc[resolved] ?? null;
  }

  private fieldAddDesc(
    format: string,
    width: number,
    handler: (values: readonly number[]) => readonly string[],
    anncls: number,
  ): void {
    this.fieldDesc.push({ format, width, handler, anncls });
  }

  private fieldSeedDesc(): void {
    this.fieldDesc = [];
    this.fieldAddDesc('<B', 1, (values) => this.handleRxId(values), ANN.RX_INFO);
    this.fieldAddDesc('<B', 1, (values) => this.handleConfig(values), ANN.HDR_CFG);
    this.fieldDescIndex = 0;
    this.fieldDescGot = 0;
    this.frameSs = null;
    this.frameEs = null;
    this.frameRxText = null;
    this.frameIsBroadcast = false;
    this.frameTxText = null;
    this.framePayloadText = null;
    this.frameHasAck = null;
  }

  private handleRxId(values: readonly number[]): readonly string[] {
    const value = values[0]!;
    const text = value === 255 ? 'NA' : value === 0 ? 'BC' : String(value);
    this.frameRxText = text;
    this.frameIsBroadcast = value === 0;
    return [`RX_ID ${text}`, text];
  }

  private handleConfig(values: readonly number[]): readonly string[] {
    const value = values[0]!;
    this.cfgShared = value & 1;
    this.cfgTxInfo = value & 2;
    this.cfgSyncAck = value & 4;
    this.cfgAsyncAck = value & 8;
    this.cfgPort = value & 16;
    this.cfgCrc32 = value & 32;
    this.cfgLen16 = value & 64;
    this.cfgPktId = value & 128;
    const flags = [
      this.cfgPktId ? 'pkt_id' : '-',
      this.cfgLen16 ? 'len16' : '-',
      this.cfgCrc32 ? 'crc32' : '-',
      this.cfgPort ? 'svc_id' : '-',
      this.cfgAsyncAck ? 'ack_mode' : '-',
      this.cfgSyncAck ? 'ack' : '-',
      this.cfgTxInfo ? 'tx_info' : '-',
      this.cfgShared ? 'bus_id' : '-',
    ].join(' ');
    const bits = value.toString(2).padStart(8, '0');

    const lenWidth = this.cfgLen16 ? 2 : 1;
    const crcWidth = this.cfgCrc32 ? 4 : 1;
    this.cfgOverhead = 1 + 1 + lenWidth + 1;
    if (this.cfgShared) this.cfgOverhead += 4;
    if (this.cfgTxInfo) {
      if (this.cfgShared) this.cfgOverhead += 4;
      this.cfgOverhead += 1;
    }
    if (this.cfgPort) this.cfgOverhead += 2;
    if (this.cfgPktId) this.cfgOverhead += 2;
    this.cfgOverhead += crcWidth;

    this.fieldAddDesc(this.cfgLen16 ? '>H' : '>B', lenWidth, (item) => this.handlePacketLength(item), ANN.PKT_LEN);
    this.fieldAddDesc('>B', 1, (item) => this.handleMetaCrc(item), ANN.META_CRC);
    if (this.cfgShared) this.fieldAddDesc('>4B', 4, (item) => this.handleRxBus(item), ANN.ANON_DATA);
    if (this.cfgTxInfo) {
      if (this.cfgShared) this.fieldAddDesc('>4B', 4, (item) => this.handleTxBus(item), ANN.ANON_DATA);
      this.fieldAddDesc('>B', 1, (item) => this.handleTxId(item), ANN.ANON_DATA);
    }
    if (this.cfgPort) {
      this.fieldAddDesc(
        '>H',
        2,
        (item) => {
          const value = bytesToNumber(item);
          return [`PORT ${value}`, String(value)];
        },
        ANN.ANON_DATA,
      );
    }
    if (this.cfgPktId)
      this.fieldAddDesc(
        '>H',
        2,
        (item) => {
          const value = bytesToNumber(item);
          return [`PKT ${hex(value, 4)}`, hex(value, 4)];
        },
        ANN.ANON_DATA,
      );
    this.fieldAddDesc('>0B', 0, (item) => this.handlePayload(item), ANN.PAYLOAD);
    this.fieldAddDesc(this.cfgCrc32 ? '>L' : '>B', crcWidth, (item) => this.handleEndCrc(item), ANN.END_CRC);

    const warnings: string[] = [];
    const wantsAck = this.cfgSyncAck || this.cfgAsyncAck;
    if (wantsAck && !this.cfgTxInfo) warnings.push('ACK request without TX info');
    if (wantsAck && this.frameIsBroadcast) warnings.push('ACK request for broadcast');
    if (this.cfgSyncAck && this.cfgAsyncAck) warnings.push('sync and async ACK request');
    if (this.cfgLen16 && !this.cfgCrc32) warnings.push('extended length needs CRC32');
    if (warnings.length) this.putg(this.annSs, this.annEs, ANN.WARN, [warnings.join(', ')]);
    return [`CFG ${flags}`, `CFG ${bits}`, bits];
  }

  private handlePacketLength(values: readonly number[]): readonly string[] {
    const packetLength = bytesToNumber(values);
    let payloadLength = packetLength - this.cfgOverhead;
    const warnings: string[] = [];
    if (packetLength < this.cfgOverhead || packetLength > 65535) warnings.push('suspicious packet length');
    if (packetLength > 15 && !this.cfgCrc32) warnings.push('length above 15 needs CRC32');
    if (payloadLength < 1) {
      warnings.push('suspicious payload length');
      payloadLength = 0;
    }
    if (warnings.length) this.putg(this.annSs, this.annEs, ANN.WARN, [warnings.join(', ')]);
    const payload = this.fieldGetDesc(-2);
    if (payload) {
      payload.width = payloadLength;
      payload.format = `>${payloadLength}B`;
    }
    return [
      `LENGTH ${packetLength} (PAYLOAD ${payloadLength})`,
      `LEN ${packetLength} (PL ${payloadLength})`,
      `${packetLength} (${payloadLength})`,
      String(packetLength),
    ];
  }

  private handleCommonCrc(have: number, meta: boolean): readonly string[] {
    const caption = meta ? 'META' : 'END';
    const bits = meta ? 8 : this.cfgCrc32 ? 32 : 8;
    const bytes = bits / 8;
    const text = hex(have, bits === 32 ? 8 : 2);
    const data = this.frameBytes!.slice(0, -bytes);
    const wanted = bits === 32 ? calcCrc32(data) : calcCrc8(data);
    if (wanted !== have)
      this.putg(this.annSs, this.annEs, ANN.WARN, [
        `CRC mismatch - want ${hex(wanted, bits === 32 ? 8 : 2)} have ${text}`,
      ]);
    return [`${caption}_CRC ${text}`, `CRC ${text}`, text];
  }

  private handleMetaCrc(values: readonly number[]): readonly string[] {
    return this.handleCommonCrc(values[0]!, true);
  }

  private handleEndCrc(values: readonly number[]): readonly string[] {
    return this.handleCommonCrc(bytesToNumber(values), false);
  }

  private busText(values: readonly number[]): string {
    return values.slice(0, 4).map(String).join('.');
  }

  private handleRxBus(values: readonly number[]): readonly string[] {
    const text = this.busText(values);
    this.frameRxText = `${text} ${this.frameRxText ?? ''}`.trim();
    return [`RX_BUS ${text}`, text];
  }

  private handleTxBus(values: readonly number[]): readonly string[] {
    const text = this.busText(values);
    this.frameTxText = text;
    return [`TX_BUS ${text}`, text];
  }

  private handleTxId(values: readonly number[]): readonly string[] {
    const id = String(values[0]!);
    this.frameTxText = this.frameTxText === null ? id : `${this.frameTxText} ${id}`;
    return [`TX_ID ${id}`, id];
  }

  private handlePayload(values: readonly number[]): readonly string[] {
    const text = values.map((value) => hex(value)).join(' ');
    this.framePayloadText = text;
    return [`PAYLOAD ${text}`, text];
  }

  private handleSyncResponse(value: number): readonly string[] {
    this.frameHasAck = value;
    return [`ACK ${hex(value)}`, hex(value)];
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || data.length !== 2) return;
    const [type, payload] = data as [string, unknown];
    if (type === 'FRAME_INIT') {
      this.frameFlush();
      this.resetFrame();
      this.frameBytes = [];
      this.fieldSeedDesc();
      this.frameSs = ss;
      this.frameEs = es;
      return;
    }
    if (type === 'IDLE' || type === 'FRAME_DATA') {
      this.frameFlush();
      this.resetFrame();
      return;
    }
    if (type === 'SYNC_RESP_WAIT') {
      this.ackBytes = [];
      this.annSs = null;
      this.annEs = null;
      return;
    }
    if (type !== 'DATA_BYTE' || typeof payload !== 'number') return;

    this.frameEs = es;
    if (this.ackBytes !== null) {
      if (this.annSs === null) this.annSs = ss;
      this.ackBytes.push(payload);
      this.annEs = es;
      this.putg(this.annSs, this.annEs, ANN.SYN_RSP, this.handleSyncResponse(payload));
      this.annSs = null;
      this.annEs = null;
      return;
    }
    if (this.frameBytes === null) return;
    if (this.annSs === null) this.annSs = ss;
    this.frameBytes.push(payload);
    this.annEs = es;
    const description = this.fieldGetDesc();
    if (!description || !description.width) return;
    this.fieldDescGot++;
    if (this.fieldDescGot !== description.width) return;
    const values = this.frameBytes.slice(-description.width);
    const texts = description.handler(values);
    if (description.anncls !== null && texts.length) this.putg(this.annSs, this.annEs, description.anncls, texts);
    this.annSs = null;
    this.annEs = null;
    this.fieldDescIndex++;
    this.fieldDescGot = 0;
  }
}

export default PjonDecoder;
