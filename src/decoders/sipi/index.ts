import { Decoder, OUTPUT_ANN, OUTPUT_BINARY } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const SIPI_ANN = Object.freeze({
  TAG: 0,
  COMMAND: 1,
  CHANNEL: 2,
  ADDRESS: 3,
  DATA: 4,
  CRC: 5,
  WARNING: 6,
});

interface ByteSpan {
  readonly ss: bigint;
  readonly es: bigint;
  readonly value: number;
}

interface CommandInfo {
  readonly name: string;
  readonly addressBytes: number;
  readonly dataBytes: number;
}

const COMMANDS: Readonly<Record<number, CommandInfo>> = {
  0b00000: { name: 'Read byte', addressBytes: 4, dataBytes: 0 },
  0b00001: { name: 'Read 2 byte', addressBytes: 4, dataBytes: 0 },
  0b00010: { name: 'Read 4 byte', addressBytes: 4, dataBytes: 0 },
  0b00100: { name: 'Write byte with ACK', addressBytes: 4, dataBytes: 4 },
  0b00101: { name: 'Write 2 byte with ACK', addressBytes: 4, dataBytes: 4 },
  0b00110: { name: 'Write 4 byte with ACK', addressBytes: 4, dataBytes: 4 },
  0b01000: { name: 'ACK', addressBytes: 0, dataBytes: 0 },
  0b01001: { name: 'NACK (Target Error)', addressBytes: 0, dataBytes: 0 },
  0b01010: { name: 'Read Answer with ACK', addressBytes: 4, dataBytes: 4 },
  0b01100: { name: 'Trigger with ACK', addressBytes: 0, dataBytes: 0 },
  0b10010: { name: 'Read 4-byte JTAG ID', addressBytes: 0, dataBytes: 0 },
  0b10111: { name: 'Stream 32 byte with ACK', addressBytes: 0, dataBytes: 32 },
};

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function crc16CcittFalse(bytes: readonly number[]): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= (byte & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function normalizeBytes(data: unknown): ByteSpan[] {
  const packet = data as unknown;
  if (!Array.isArray(packet)) return [];
  const payload = typeof packet[0] === 'string' ? (packet[1] ?? packet.at(-1)) : packet;
  if (!Array.isArray(payload)) return [];
  return payload
    .filter(
      (item): item is readonly [bigint | number, bigint | number, number] => Array.isArray(item) && item.length >= 3,
    )
    .map((item) => ({ ss: BigInt(item[0]), es: BigInt(item[1]), value: Number(item[2]) & 0xff }));
}

export class SipiDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outBinary = -1;
  private bitLength = 0;
  private addressLength = 0;
  private dataLength = 0;
  private frameLength = 0;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.bitLength = 0;
    this.addressLength = 0;
    this.dataLength = 0;
    this.frameLength = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private putHeader(ssHeader: bigint, value: number): void {
    let ss = ssHeader;
    let es = ss + BigInt(Math.trunc(3 * this.bitLength));
    const tag = (value & 0xe000) >>> 13;
    this.annotate(ss, es, SIPI_ANN.TAG, [hex(tag)]);

    ss = es;
    es = ss + BigInt(Math.trunc(5 * this.bitLength));
    const commandCode = (value & 0x1f00) >>> 8;
    const command = COMMANDS[commandCode] ?? { name: `Reserved (${hex(commandCode)})`, addressBytes: 0, dataBytes: 0 };
    this.addressLength = command.addressBytes;
    this.dataLength = command.dataBytes;
    this.frameLength = 4 + this.addressLength + this.dataLength;
    this.annotate(ss, es, SIPI_ANN.COMMAND, [command.name]);

    ss = es;
    es = ss + BigInt(Math.trunc(4 * this.bitLength));
    if ((value & 0x00f0) >>> 4 !== 0) this.annotate(ss, es, SIPI_ANN.WARNING, ['Reserved bits #4..7 should be 0']);

    ss = es;
    es = ss + BigInt(Math.trunc(3 * this.bitLength));
    this.annotate(ss, es, SIPI_ANN.CHANNEL, [String((value & 0x000e) >>> 1)]);

    if ((value & 1) !== 0) {
      ss = es;
      es = ss + BigInt(Math.trunc(this.bitLength));
      this.annotate(ss, es, SIPI_ANN.WARNING, ['Reserved bit #0 should be 0']);
    }
  }

  private putPayload(data: readonly ByteSpan[]): void {
    let index = 0;
    for (; index < this.addressLength && index < data.length; index++)
      this.annotate(data[index]!.ss, data[index]!.es, SIPI_ANN.ADDRESS, [hex(data[index]!.value)]);
    for (; index < data.length; index++)
      this.annotate(data[index]!.ss, data[index]!.es, SIPI_ANN.DATA, [hex(data[index]!.value)]);
  }

  private putCrc(ss: bigint, es: bigint, received: number, payload: readonly ByteSpan[]): void {
    const calculated = crc16CcittFalse(payload.map((item) => item.value));
    if (calculated === received) {
      this.annotate(ss, es, SIPI_ANN.CRC, ['CRC OK']);
    } else {
      this.annotate(ss, es, SIPI_ANN.CRC, [`Have ${hex(received)} but calculated ${hex(calculated)}`]);
      this.annotate(ss, es, SIPI_ANN.WARNING, ['CRC mismatch']);
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const bytes = normalizeBytes(data);
    if (!bytes.length) {
      this.annotate(ss, es, SIPI_ANN.WARNING, ['Header too short']);
      return;
    }
    this.put(bytes[0]!.ss, bytes.at(-1)!.es, this.outBinary, [0, Uint8Array.from(bytes.map((item) => item.value))]);
    if (bytes.length === 1) {
      this.annotate(ss, es, SIPI_ANN.WARNING, ['Header too short']);
      return;
    }

    this.bitLength = Number(bytes[0]!.es - bytes[0]!.ss) / 8;
    const header = (bytes[0]!.value << 8) + bytes[1]!.value;
    this.putHeader(bytes[0]!.ss, header);

    let index = 2;
    const payloadLength = this.frameLength - 4;
    if (payloadLength > 0) {
      this.putPayload(bytes.slice(2, -2));
      index += payloadLength;
    }
    if (index + 1 >= bytes.length) {
      this.annotate(bytes.at(-1)!.ss, bytes.at(-1)!.es, SIPI_ANN.WARNING, ['CRC incomplete or missing']);
      return;
    }
    const crcStart = bytes[index]!.ss;
    const crcEnd = bytes[index + 1]!.es;
    const received = (bytes[index]!.value << 8) + bytes[index + 1]!.value;
    if (index === bytes.length - 2) this.putCrc(crcStart, crcEnd, received, bytes.slice(0, -2));
    else this.annotate(crcStart, crcEnd, SIPI_ANN.WARNING, ['CRC incomplete or missing']);
  }
}

export default SipiDecoder;
