import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface QiPacket {
  readonly bytes: readonly number[];
}

export interface QiCase extends RoundtripCase<QiPacket> {}

export const QI_BIT_WIDTH = 4;
export const QI_SAMPLE_RATE = 8_000;
export const QI_PACKET_GAP_BITS = 3;

export function qiSymbols(bytes: readonly number[]): number[] {
  if (!bytes.length) throw new RangeError('Qi packet cannot be empty');
  const symbols = [1, 1, 1, 1, 0];
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
    const value = bytes[byteIndex]! & 0xff;
    if (byteIndex > 0) symbols.push(0);
    const data: number[] = [];
    for (let bit = 0; bit < 8; bit++) data.push((value >>> bit) & 1);
    const parity = data.reduce((sum, bit) => (sum + bit) % 2, 1);
    symbols.push(...data, parity, 1);
  }
  return symbols;
}

export function qiChecksum(bytes: readonly number[]): number {
  let value = 0;
  for (let index = 0; index < bytes.length - 1; index++) value ^= bytes[index]!;
  return value;
}

function packet(type: number, data: readonly number[]): QiPacket {
  const bytes = [type, ...data, 0];
  bytes[bytes.length - 1] = qiChecksum(bytes);
  return { bytes };
}

function makePacket(type: number, totalBytes: number, random: () => number): QiPacket {
  const data = Array.from({ length: totalBytes - 2 }, () => random() & 0xff);
  return packet(type, data);
}

function annotationCount(packets: readonly QiPacket[]): number {
  return packets.reduce((total, item) => total + 15 * item.bytes.length + 2, 0);
}

function payloadBits(packets: readonly QiPacket[]): number {
  return packets.reduce((total, item) => total + 11 * item.bytes.length + 4, 0);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x51493137,
}: GenerationOptions = {}): Iterable<QiCase> {
  const boundaries: readonly { name: string; packets: readonly QiPacket[]; startSample: bigint }[] = [
    {
      name: 'charge-status-max-min',
      startSample: 11n,
      packets: [packet(0x05, [0x00]), packet(0x05, [0xff]), packet(0x01, [0x7f])],
    },
    {
      name: 'configuration-identification',
      startSample: 0n,
      packets: [packet(0x51, [0xc7, 0x55, 0x8b, 0x3d, 0x21]), packet(0x71, [0x12, 0x34, 0x56, 0x7a, 0x9b, 0xcd, 0xef])],
    },
    {
      name: 'extended-and-end-transfer',
      startSample: 9_007_199_254_740_990n,
      packets: [packet(0x81, [1, 2, 3, 4, 5, 6, 7, 8]), packet(0x02, [8]), packet(0x06, [0x2a])],
    },
  ];

  for (const item of boundaries) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: QI_SAMPLE_RATE,
      startSample: item.startSample,
      channels: { qi: 2 },
      options: {},
      chunkSamples: [1, 7, 127, 4093],
      minimumPayloadBits: 0,
      *generate() {
        const expected: ExpectedFrame[] = [{ protoId: 'qi', kind: 'summary' }];
        const expectedAnnotations: ExpectedFrame[] = [
          { classIndex: 2, texts: ['Start bit', 'Start', 'S'] },
          { classIndex: 4, texts: [item.packets[0]!.bytes[0]!.toString(16).padStart(2, '0')] },
          { classIndex: 5 },
          { classIndex: 6, texts: ['Checksum OK', 'OK'] },
        ];
        yield {
          data: item.packets,
          expected,
          expectedAnnotations,
          annotationCount: annotationCount(item.packets),
          payloadBits: payloadBits(item.packets),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalBytes = 22;
  const bitsPerPacket = 11 * totalBytes + 4;
  const count = Math.ceil(required / bitsPerPacket);
  const perBlock = 64;
  yield {
    name: 'seeded-long-extended-packets',
    kind: 'long',
    seed,
    sampleRate: QI_SAMPLE_RATE,
    startSample: 0n,
    channels: { qi: 0 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < count; offset += perBlock) {
        const packets = Array.from({ length: Math.min(perBlock, count - offset) }, () =>
          makePacket(0xe3, totalBytes, random),
        );
        const expectedAnnotations: ExpectedFrame[] =
          offset === 0
            ? [
                { classIndex: 2, texts: ['Start bit', 'Start', 'S'] },
                { classIndex: 5, texts: ['Unknown', '?'] },
                { classIndex: 6, texts: ['Checksum OK', 'OK'] },
              ]
            : [{ classIndex: 6, texts: ['Checksum OK', 'OK'] }];
        yield {
          data: packets,
          expected: offset === 0 ? [{ protoId: 'qi', kind: 'summary' }] : [],
          expectedAnnotations,
          annotationCount: annotationCount(packets),
          payloadBits: payloadBits(packets),
        };
      }
    },
  };
}
