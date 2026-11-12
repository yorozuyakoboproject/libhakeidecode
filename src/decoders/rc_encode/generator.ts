import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { RC_BIT_VALUES, decodeBit, decodeModel, pinLabel, type RcBit, type RcBitRecord } from './index.js';

export interface RcPacket {
  readonly bits: readonly RcBit[];
}

export interface RcCase extends RoundtripCase<RcPacket> {}

export const RC_SHORT_SAMPLES = 2;
export const RC_SYNC_SAMPLES = 2;

const PATTERNS: Readonly<Record<'12' | '24', Readonly<Record<string, readonly number[]>>>> = {
  '12': {
    '0': [1, 3, 1, 3],
    '1': [3, 1, 3, 1],
    f: [1, 3, 3, 1],
    U: [1, 1, 1, 1],
  },
  '24': {
    '0': [1, 3],
    '1': [3, 1],
    f: [1, 1],
    U: [1, 1],
  },
};

export interface RcPacketLayout {
  readonly firstEdge: bigint;
  readonly bits: readonly RcBitRecord[];
  readonly durations: readonly number[];
  readonly syncSs: bigint;
  readonly syncEs: bigint;
  readonly end: bigint;
}

function modelFor(options: Record<string, string | number | boolean>): string {
  return options.linecoding === 'xx1527' ? 'xx1527' : String(options.remote);
}

export function layoutPacket(packet: RcPacket, packetBits: number, packetStart: bigint): RcPacketLayout {
  if (packet.bits.length !== packetBits) throw new RangeError('RC packet has the wrong bit count.');
  const firstEdge = packetStart + 1n;
  let cursor = firstEdge;
  const durations: number[] = [];
  const bits: RcBitRecord[] = [];
  for (const value of packet.bits) {
    const multipliers = PATTERNS[String(packetBits) as '12' | '24'][value];
    if (!multipliers) throw new RangeError('Invalid RC bit value.');
    const ss = cursor;
    const pulseWidths = multipliers.map((multiplier) => multiplier * RC_SHORT_SAMPLES);
    const decoded = decodeBit(pulseWidths, pulseWidths.length);
    if (decoded !== value) throw new RangeError('RC pulse pattern is not decodable.');
    durations.push(...pulseWidths);
    cursor += BigInt(pulseWidths.reduce((sum, width) => sum + width, 0));
    bits.push({ value, ss, es: cursor });
  }
  const syncSs = cursor;
  cursor += BigInt(RC_SYNC_SAMPLES);
  const syncEs = cursor + BigInt(8 * RC_SYNC_SAMPLES);
  return {
    firstEdge,
    bits,
    durations,
    syncSs,
    syncEs,
    end: syncEs + 1n,
  };
}

export function packetAnnotations(
  layout: RcPacketLayout,
  packetBits: number,
  options: Record<string, string | number | boolean>,
): ExpectedFrame[] {
  const annotations: ExpectedFrame[] = [];
  for (let index = 0; index < packetBits; index++) {
    const bit = layout.bits[index]!;
    annotations.push({
      classIndex: RC_BIT_VALUES.indexOf(bit.value),
      texts: [bit.value],
      ss: bit.ss,
      es: bit.es,
    });
    annotations.push({
      classIndex: 5,
      texts: [pinLabel(index + 1, packetBits)!],
      ss: bit.ss,
      es: bit.es,
    });
  }
  const labels = decodeModel(modelFor(options), layout.bits);
  if (labels) {
    annotations.push({ classIndex: 6, texts: [labels[0]], ss: labels[1], es: labels[2] });
    annotations.push({ classIndex: 7, texts: [labels[3]], ss: labels[4], es: labels[5] });
  }
  annotations.push({ classIndex: 4, texts: ['Sync'], ss: layout.syncSs, es: layout.syncEs });
  return annotations;
}

export function packetAnnotationCount(packetBits: number, options: Record<string, string | number | boolean>): number {
  return 2 * packetBits + 1 + (modelFor(options) === 'none' ? 0 : 2);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x5243454e,
}: GenerationOptions = {}): Iterable<RcCase> {
  const sampleRate = 1_000_000;
  const boundaries: readonly {
    name: string;
    bits: readonly RcBit[];
    linecoding: 'SC52x2/HX22x2' | 'xx1527';
    remote: 'none' | 'maplin_l95ar';
    startSample: bigint;
    expectedAddress?: string;
  }[] = [
    {
      name: 'sc52x2-all-bits',
      bits: ['0', '1', 'f', 'U', '0', '1', '0', '1', 'f', 'U', '1', '0'],
      linecoding: 'SC52x2/HX22x2',
      remote: 'none',
      startSample: 5n,
    },
    {
      name: 'maplin-button-a',
      bits: ['0', '1', '0', '0', '1', '0', '0', '1', '1', '1', '1', '0'],
      linecoding: 'SC52x2/HX22x2',
      remote: 'maplin_l95ar',
      startSample: 11n,
    },
    {
      name: 'xx1527-address-and-keys',
      bits: [
        '0',
        '1',
        '0',
        '1',
        '1',
        '0',
        '1',
        '0',
        '0',
        '1',
        '0',
        '1',
        '1',
        '0',
        '1',
        '0',
        '0',
        '1',
        '0',
        '1',
        '1',
        '0',
        '1',
        '0',
      ],
      linecoding: 'xx1527',
      remote: 'none',
      startSample: 0n,
    },
    {
      name: 'xx1527-address-byte-order',
      bits: [
        '1',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '0',
        '1',
        '0',
        '1',
        '1',
        '0',
        '0',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '1',
        '1',
      ],
      linecoding: 'xx1527',
      remote: 'none',
      startSample: 4_096n,
      expectedAddress: 'Address 0x5 34 AB',
    },
    {
      name: 'xx1527-invalid-address',
      bits: [
        '0',
        '1',
        '0',
        '1',
        '0',
        'U',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
      ],
      linecoding: 'xx1527',
      remote: 'maplin_l95ar',
      startSample: 9_007_199_254_740_990n,
    },
  ];

  for (const item of boundaries) {
    const packetBits = item.bits.length;
    const options = { linecoding: item.linecoding, remote: item.remote };
    const packet: RcPacket = { bits: item.bits };
    const layout = layoutPacket(packet, packetBits, item.startSample);
    const expectedAnnotations = packetAnnotations(layout, packetBits, options).map((annotation) =>
      annotation.classIndex === 6 && item.expectedAddress
        ? { ...annotation, texts: [item.expectedAddress] }
        : annotation,
    );
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate,
      startSample: item.startSample,
      channels: { data: 4 },
      options,
      chunkSamples: [1, 7, 257, 4093],
      minimumPayloadBits: 0,
      *generate() {
        yield {
          data: [packet],
          expected: [{ protoId: 'rc_encode', kind: 'summary' }],
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits: packetBits,
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const packetBits = 24;
  const packetCount = Math.ceil(required / packetBits);
  const perBlock = 512;
  const options = { linecoding: 'xx1527', remote: 'none' } as const;
  yield {
    name: 'seeded-long-xx1527',
    kind: 'long',
    seed,
    sampleRate,
    startSample: 0n,
    channels: { data: 6 },
    options,
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let cursor = 0n;
      for (let offset = 0; offset < packetCount; offset += perBlock) {
        const data: RcPacket[] = [];
        const count = Math.min(perBlock, packetCount - offset);
        const layouts: RcPacketLayout[] = [];
        for (let index = 0; index < count; index++) {
          const word = random();
          const bits = Array.from({ length: packetBits }, (_, bit): RcBit => ((word >>> (bit % 32)) & 1 ? '1' : '0'));
          const packet = { bits };
          data.push(packet);
          const layout = layoutPacket(packet, packetBits, cursor);
          layouts.push(layout);
          cursor = layout.end;
        }
        const first = layouts[0]!.bits[0]!;
        const last = layouts[layouts.length - 1]!;
        yield {
          data,
          expected: offset === 0 ? [{ protoId: 'rc_encode', kind: 'summary' }] : [],
          expectedAnnotations: [
            {
              classIndex: RC_BIT_VALUES.indexOf(first.value),
              texts: [first.value],
              ss: first.ss,
              es: first.es,
            },
            { classIndex: 4, texts: ['Sync'], ss: last.syncSs, es: last.syncEs },
          ],
          annotationCount: data.length * packetAnnotationCount(packetBits, options),
          payloadBits: data.length * packetBits,
        };
      }
    },
  };
}
