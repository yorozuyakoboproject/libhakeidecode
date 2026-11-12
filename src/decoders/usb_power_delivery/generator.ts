import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { DEC4B5B, PD_EOP, SOP_SEQUENCES, START_OF_PACKETS, SYM_NAME } from './index.js';

export const PD_SAMPLE_RATE = 7_200_000;
export const PD_INITIAL_IDLE_SAMPLES = 96;
export const PD_PACKET_GAP_SAMPLES = 96;
export const PD_TRAILING_SAMPLES = 24;

export interface UsbPowerDeliveryPacket {
  readonly header: number;
  readonly data?: readonly number[];
  readonly preambleBits?: number;
  readonly sop?: number;
  readonly corruptCrcBit?: number;
}

export interface UsbPowerDeliveryCase extends RoundtripCase<UsbPowerDeliveryPacket> {}

export interface BuiltPdPacket {
  readonly bits: readonly number[];
  readonly header: number;
  readonly data: readonly number[];
  readonly crc: number;
  readonly actualCrc: number;
  readonly sop: number;
}

function symbolBits(code: number): number[] {
  const index = DEC4B5B.indexOf(code);
  if (index < 0) throw new RangeError(`Unknown 4b5b symbol: ${code}`);
  return [index & 1, (index >>> 1) & 1, (index >>> 2) & 1, (index >>> 3) & 1, (index >>> 4) & 1];
}

function wordBits(value: number): number[] {
  const bits: number[] = [];
  for (let nibble = 0; nibble < 8; nibble++) bits.push(...symbolBits((value >>> (nibble * 4)) & 0xf));
  return bits;
}

function headerBits(header: number): number[] {
  const bits: number[] = [];
  for (let nibble = 0; nibble < 4; nibble++) bits.push(...symbolBits((header >>> (nibble * 4)) & 0xf));
  return bits;
}

function crc32(header: number, data: readonly number[]): number {
  const bytes = new Uint8Array(2 + data.length * 4);
  bytes[0] = header & 0xff;
  bytes[1] = (header >>> 8) & 0xff;
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < data.length; index++) view.setUint32(2 + index * 4, data[index]! >>> 0, true);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildPdPacket(packet: UsbPowerDeliveryPacket): BuiltPdPacket {
  const data = [...(packet.data ?? [])];
  const sop = packet.sop ?? 0;
  const preamble = packet.preambleBits ?? 64;
  const bits = Array.from({ length: preamble }, () => 0);
  for (const code of SOP_SEQUENCES[sop] ?? SOP_SEQUENCES[0]!) bits.push(...symbolBits(code));
  bits.push(...headerBits(packet.header));
  for (const word of data) bits.push(...wordBits(word));
  const crc = crc32(packet.header, data);
  let actualCrc = crc;
  if (packet.corruptCrcBit !== undefined && packet.corruptCrcBit >= 0 && packet.corruptCrcBit < 32) {
    actualCrc = (crc ^ (1 << packet.corruptCrcBit)) >>> 0;
  }
  bits.push(...wordBits(actualCrc));
  bits.push(...symbolBits(PD_EOP));
  return { bits, header: packet.header, data, crc, actualCrc, sop };
}

function hex(value: number, digits: number): string {
  return (value >>> 0).toString(16).padStart(digits, '0');
}

function glyph(code: number): readonly string[] {
  return SYM_NAME[code] ?? ['ERROR', 'X'];
}

function headerTypeText(header: number): { classIndex: number; long: string; short: string } {
  const source = (header >>> 8) & 1;
  const dataRole = (header >>> 5) & 1;
  const revision = ((header >>> 6) & 3) + 1;
  const id = (header >>> 9) & 7;
  const count = (header >>> 12) & 7;
  const type = revision === 3 ? header & 0x1f : header & 0x0f;
  let role = source ? 'SRC' : 'SNK';
  if (dataRole !== source) role += dataRole ? '/DFP' : '/UFP';
  const control: Readonly<Record<number, string>> = {
    0: 'reserved',
    1: 'GOOD CRC',
    2: 'GOTO MIN',
    3: 'ACCEPT',
    4: 'REJECT',
    5: 'PING',
    6: 'PS RDY',
    7: 'GET SOURCE CAP',
    8: 'GET SINK CAP',
    9: 'DR SWAP',
    10: 'PR SWAP',
    11: 'VCONN SWAP',
    12: 'WAIT',
    13: 'SOFT RESET',
    16: 'Not Supported',
    17: 'Get_Source_Cap_Extended',
    18: 'Get_Status',
    19: 'FR_Swap',
    20: 'Get_PPS_Status',
    21: 'Get_Country_Codes',
  };
  const messages: Readonly<Record<number, string>> = {
    1: 'SOURCE CAP',
    2: 'REQUEST',
    3: 'BIST',
    4: 'SINK CAP',
    5: 'Battery_Status',
    6: 'Alert',
    7: 'Get_Country_Info',
    15: 'VDM',
  };
  const short = count === 0 ? (control[type] ?? 'reserved') : (messages[type] ?? 'DAT???');
  return {
    classIndex: source ? 9 : 10,
    long: `(r${revision}) ${role}[${id}]: ${short}`,
    short,
  };
}

function packetAnnotationCount(packet: UsbPowerDeliveryPacket, fulltext: boolean): number {
  return 23 + 10 * (packet.data?.length ?? 0) + (packet.corruptCrcBit === undefined ? 0 : 1) + (fulltext ? 1 : 0);
}

function boundaryAnnotations(packet: UsbPowerDeliveryPacket): ExpectedFrame[] {
  const built = buildPdPacket(packet);
  const sequence = SOP_SEQUENCES[built.sop] ?? SOP_SEQUENCES[0]!;
  const type = headerTypeText(built.header);
  const annotations: ExpectedFrame[] = [{ classIndex: 1, texts: ['Preamble', '...'] }];
  for (const code of sequence) annotations.push({ classIndex: 7, texts: [...glyph(code)] });
  annotations.push({
    classIndex: 2,
    texts: [START_OF_PACKETS.get(sequence.join(',')) ?? 'SOP', 'S'],
  });
  for (let nibble = 0; nibble < 4; nibble++)
    annotations.push({ classIndex: 7, texts: [...glyph((built.header >>> (nibble * 4)) & 0xf)] });
  annotations.push({ classIndex: 3, texts: [`H:${hex(built.header, 4)}`, 'HD'] });
  annotations.push({ classIndex: type.classIndex, texts: [type.long, type.short] });
  for (let byte = 0; byte < 8; byte++)
    annotations.push({ classIndex: 7, texts: [...glyph((built.actualCrc >>> (byte * 4)) & 0xf)] });
  annotations.push({ classIndex: 5, texts: [`CRC:${hex(built.actualCrc, 8)}`, 'CRC'] });
  annotations.push({ classIndex: 7, texts: [...glyph(PD_EOP)] });
  annotations.push({ classIndex: 6, texts: ['EOP', 'E'] });
  return annotations;
}

function summary(): ExpectedFrame {
  return { protoId: 'usb_power_delivery', kind: 'summary' };
}

function boundaryCase(
  name: string,
  seed: number,
  packet: UsbPowerDeliveryPacket,
  annotations: ExpectedFrame[],
): UsbPowerDeliveryCase {
  return {
    name,
    kind: 'boundary',
    seed,
    sampleRate: PD_SAMPLE_RATE,
    startSample: 17n,
    channels: { cc1: 2 },
    options: { fulltext: 'no' },
    chunkSamples: [1, 7, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: [packet],
        expected: [summary()],
        expectedAnnotations: annotations,
        annotationCount: packetAnnotationCount(packet, false),
        payloadBits: buildPdPacket(packet).bits.length,
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x55534250,
}: GenerationOptions = {}): Iterable<UsbPowerDeliveryCase> {
  const goodHeader = (1 << 8) | (1 << 6) | (1 << 5) | 1;
  const good: UsbPowerDeliveryPacket = { header: goodHeader };
  yield boundaryCase('good-crc-control', seed, good, boundaryAnnotations(good));

  const requestHeader = (1 << 12) | (1 << 9) | (1 << 8) | (1 << 6) | (1 << 5) | 2;
  const request: UsbPowerDeliveryPacket = { header: requestHeader, data: [0x12345678], corruptCrcBit: 0 };
  const built = buildPdPacket(request);
  yield boundaryCase('bad-crc-request', seed ^ 1, request, [
    { classIndex: 8, texts: [`Bad CRC ${hex(built.actualCrc, 8)} != ${hex(built.crc, 8)}`, 'CRC!'] },
  ]);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 64;
  yield {
    name: 'seeded-long-request-packets',
    kind: 'long',
    seed,
    sampleRate: PD_SAMPLE_RATE,
    startSample: 0n,
    channels: { cc1: 1 },
    options: { fulltext: 'no' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let total = 0;
      let first = true;
      let messageId = 0;
      while (total < required) {
        const packets: UsbPowerDeliveryPacket[] = [];
        let payloadBits = 0;
        for (let index = 0; index < perBlock; index++) {
          const header = (1 << 12) | ((messageId++ & 7) << 9) | (1 << 8) | (1 << 6) | (1 << 5) | 2;
          const packet: UsbPowerDeliveryPacket = { header, data: [random()] };
          packets.push(packet);
          payloadBits += buildPdPacket(packet).bits.length;
        }
        total += payloadBits;
        const firstType = headerTypeText(packets[0]!.header);
        yield {
          data: packets,
          expected: first ? [summary()] : [],
          expectedAnnotations: [{ classIndex: firstType.classIndex, texts: [firstType.long, firstType.short] }],
          annotationCount: packets.length * packetAnnotationCount(packets[0]!, false),
          payloadBits,
        };
        first = false;
      }
    },
  };
}
