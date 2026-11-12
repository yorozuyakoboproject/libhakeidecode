import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { RC5_BITS, rc5Fields, rc5FrameBits, rc5HalfBit, type Rc5Frame } from './index.js';

export interface Rc5Case extends RoundtripCase<Rc5Frame> {}

export const RC5_LEAD_HALF_BITS = 2;
export const RC5_GAP_HALF_BITS = 2;
export const RC5_TRAIL_HALF_BITS = 4;

export function rc5FrameAnnotations(
  frame: Rc5Frame,
  frameStart: bigint,
  halfbit: number,
  extended: boolean,
): ExpectedFrame[] {
  const bits = rc5FrameBits(frame, extended);
  const fields = rc5Fields(bits, extended);
  const half = BigInt(halfbit);
  const bitStart = (index: number): bigint => frameStart + BigInt(index * 2) * half;
  const bitEnd = (index: number): bigint => frameStart + BigInt((index + 1) * 2) * half;
  const annotations: ExpectedFrame[] = bits.map((bit, index) => ({
    classIndex: 0,
    texts: [String(bit)],
    ss: bitStart(index),
    es: bitEnd(index),
  }));

  const second = bits[1]!;
  annotations.push({
    classIndex: 1,
    texts: [`Startbit1: 1`, 'SB1: 1', 'SB1', 'S1', 'S'],
    ss: bitStart(0),
    es: bitEnd(0),
  });
  annotations.push(
    extended
      ? {
          classIndex: 6,
          texts: [`CMD[6]#: ${second}`, `C6#: ${second}`, 'C6#', 'C#', 'C'],
          ss: bitStart(1),
          es: bitEnd(1),
        }
      : {
          classIndex: 2,
          texts: [`Startbit2: ${second}`, `SB2: ${second}`, 'SB2', 'S2', 'S'],
          ss: bitStart(1),
          es: bitEnd(1),
        },
  );
  annotations.push({
    classIndex: bits[2] === 0 ? 3 : 4,
    texts: [`Togglebit: ${bits[2]}`, `Toggle: ${bits[2]}`, `TB: ${bits[2]}`, 'TB', 'T'],
    ss: bitStart(2),
    es: bitEnd(2),
  });
  annotations.push({
    classIndex: 5,
    texts: [
      `Address: ${fields.address} (${fields.system[0]})`,
      `Addr: ${fields.address} (${fields.system[1]})`,
      `Addr: ${fields.address}`,
      `A: ${fields.address}`,
      'A',
    ],
    ss: bitStart(3),
    es: bitEnd(7),
  });
  annotations.push({
    classIndex: 6,
    texts: [
      `Command: ${fields.command} (${fields.commandLabel[0]})`,
      `Cmd: ${fields.command} (${fields.commandLabel[1]})`,
      `Cmd: ${fields.command}`,
      `C: ${fields.command}`,
      'C',
    ],
    ss: bitStart(8),
    es: bitEnd(13),
  });
  return annotations;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x524335,
}: GenerationOptions = {}): Iterable<Rc5Case> {
  const boundaries = [
    {
      name: 'standard-low-boundaries',
      polarity: 'active-low' as const,
      protocol: 'standard' as const,
      sampleRate: 100_000,
      startSample: 5n,
      frames: [
        { address: 0, command: 0, toggle: 0 as const },
        { address: 31, command: 63, toggle: 1 as const },
      ],
    },
    {
      name: 'standard-high-boundaries',
      polarity: 'active-high' as const,
      protocol: 'standard' as const,
      sampleRate: 100_000,
      startSample: 9_007_199_254_740_990n,
      frames: [
        { address: 5, command: 53, toggle: 1 as const },
        { address: 6, command: 54, toggle: 0 as const },
      ],
    },
    {
      name: 'extended-boundaries',
      polarity: 'active-low' as const,
      protocol: 'extended' as const,
      sampleRate: 100_000,
      startSample: 17n,
      frames: [
        { address: 20, command: 0, toggle: 0 as const },
        { address: 5, command: 64, toggle: 1 as const },
        { address: 31, command: 127, toggle: 0 as const },
      ],
    },
  ];

  for (const item of boundaries) {
    const options = { polarity: item.polarity, protocol: item.protocol };
    const halfbit = rc5HalfBit(item.sampleRate);
    const frameSamples = BigInt(RC5_BITS * 2 * halfbit);
    const gap = BigInt(RC5_GAP_HALF_BITS * halfbit);
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: item.sampleRate,
      startSample: item.startSample,
      channels: { ir: 2 },
      options,
      chunkSamples: [7, 31, 257, 4093],
      minimumPayloadBits: 0,
      *generate() {
        let cursor = item.startSample + BigInt(RC5_LEAD_HALF_BITS * halfbit);
        const expectedAnnotations: ExpectedFrame[] = [];
        for (const frame of item.frames) {
          expectedAnnotations.push(...rc5FrameAnnotations(frame, cursor, halfbit, item.protocol === 'extended'));
          cursor += frameSamples + gap;
        }
        yield {
          data: item.frames,
          expected: [{ protoId: 'ir_rc5', kind: 'summary' }],
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits: item.frames.length * RC5_BITS,
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const frameCount = Math.ceil(required / RC5_BITS);
  const perBlock = 1024;
  const sampleRate = 10_000;
  const halfbit = rc5HalfBit(sampleRate);
  const frameSamples = BigInt(RC5_BITS * 2 * halfbit);
  const gap = BigInt(RC5_GAP_HALF_BITS * halfbit);
  yield {
    name: 'seeded-long-standard',
    kind: 'long',
    seed,
    sampleRate,
    startSample: 0n,
    channels: { ir: 0 },
    options: { polarity: 'active-low', protocol: 'standard' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let cursor = BigInt(RC5_LEAD_HALF_BITS * halfbit);
      for (let offset = 0; offset < frameCount; offset += perBlock) {
        const count = Math.min(perBlock, frameCount - offset);
        const data: Rc5Frame[] = [];
        let firstLayout: ExpectedFrame[] | null = null;
        let lastLayout: ExpectedFrame[] | null = null;
        for (let index = 0; index < count; index++) {
          const word = random();
          const frame: Rc5Frame = {
            address: word & 0x1f,
            command: (word >>> 5) & 0x3f,
            toggle: ((word >>> 11) & 1) as 0 | 1,
          };
          data.push(frame);
          const layout = rc5FrameAnnotations(frame, cursor, halfbit, false);
          firstLayout ??= layout;
          lastLayout = layout;
          cursor += frameSamples + gap;
        }
        const expectedAnnotations = [
          firstLayout![0]!,
          firstLayout![17]!,
          firstLayout![18]!,
          lastLayout![17]!,
          lastLayout![18]!,
        ];
        yield {
          data,
          expected: offset === 0 ? [{ protoId: 'ir_rc5', kind: 'summary' }] : [],
          expectedAnnotations,
          annotationCount: count * 19,
          payloadBits: count * RC5_BITS,
        };
      }
    },
  };
}
