import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { LfastFrame } from '../lfast/generator.js';
import type { LfastRun } from '../lfast/encoder.js';

export interface SipiCase extends RoundtripCase<LfastRun> {}

export const SIPI_CHAIN = [{ decoder: 'lfast', options: {} }] as const;
export const SIPI_CHANNELS = { data: 1 } as const;
export const SIPI_SAMPLE_RATE = 1_000_000;
export const SIPI_BIT_WIDTH = 2;
export const SIPI_IDLE_BITS = 3;

const PAYLOAD_SIZE_IDS: Readonly<Record<number, number>> = {
  1: 0,
  4: 1,
  8: 2,
  12: 3,
  16: 4,
  32: 5,
  64: 6,
  36: 7,
};

interface PlannedFrame {
  readonly frame: LfastFrame;
  readonly payloadStart: bigint;
  readonly payloadEnd: bigint;
  readonly bits: number;
}

interface Plan {
  readonly runs: LfastRun[];
  readonly frames: PlannedFrame[];
  readonly endSample: bigint;
}

function crc16CcittFalse(bytes: readonly number[]): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= (byte & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function sipiFrame(
  command: number,
  tag = 0,
  channel = 4,
  address: readonly number[] = [],
  data: readonly number[] = [],
  reserved = 0,
  reservedBit0 = 0,
  corruptCrc = false,
): number[] {
  const header =
    ((tag & 7) << 13) | ((command & 0x1f) << 8) | ((reserved & 0x0f) << 4) | ((channel & 7) << 1) | (reservedBit0 & 1);
  const bytes = [(header >>> 8) & 0xff, header & 0xff, ...address, ...data];
  let crc = crc16CcittFalse(bytes);
  if (corruptCrc) crc ^= 0xffff;
  bytes.push((crc >>> 8) & 0xff, crc & 0xff);
  return bytes;
}

function frameBits(frame: LfastFrame): number[] {
  const sizeId = PAYLOAD_SIZE_IDS[frame.data.length];
  if (sizeId === undefined) throw new RangeError(`Unsupported LFAST payload length: ${frame.data.length}`);
  const bits: number[] = [];
  const append = (value: number, width: number): void => {
    for (let shift = width - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1);
  };
  append(0xa84b, 16);
  append((sizeId << 5) | ((frame.channelType & 0x0f) << 1) | (frame.cts & 1), 8);
  for (const value of frame.data) append(value, 8);
  bits.push(frame.sleep & 1);
  return bits;
}

function plan(frames: readonly LfastFrame[], startSample: bigint): Plan {
  const runs: LfastRun[] = [];
  const planned: PlannedFrame[] = [];
  let level: 0 | 1 = 0;
  let cursor = startSample;

  const append = (value: 0 | 1, samples: number): void => {
    if (value === level && runs.length) {
      const last = runs.at(-1)!;
      runs[runs.length - 1] = { data: value, samples: last.samples + samples };
    } else {
      runs.push({ data: value, samples });
      level = value;
    }
    cursor += BigInt(samples);
  };

  for (const frame of frames) {
    append(0, SIPI_IDLE_BITS * SIPI_BIT_WIDTH);
    const frameStart = cursor;
    const bits = frameBits(frame);
    for (const bit of bits) append(bit as 0 | 1, SIPI_BIT_WIDTH);
    append(0, SIPI_IDLE_BITS * SIPI_BIT_WIDTH);
    const payloadStart = frameStart + BigInt(24 * SIPI_BIT_WIDTH);
    const payloadEnd = payloadStart + BigInt(frame.data.length * 8 * SIPI_BIT_WIDTH);
    planned.push({ frame, payloadStart, payloadEnd, bits: bits.length });
  }
  return { runs, frames: planned, endSample: cursor };
}

function frameAnnotationCount(bytes: readonly number[]): number {
  if (bytes.length === 1) return 1;
  const header = (bytes[0]! << 8) | bytes[1]!;
  const command = (header & 0x1f00) >>> 8;
  const info =
    command === 0b00000
      ? [4, 0]
      : command === 0b00001
        ? [4, 0]
        : command === 0b00010
          ? [4, 0]
          : command === 0b00100 || command === 0b00101 || command === 0b00110
            ? [4, 4]
            : command === 0b01010
              ? [4, 4]
              : command === 0b10111
                ? [0, 32]
                : [0, 0];
  let count = 3 + Math.max(0, bytes.length - 4);
  if ((header & 0x00f0) !== 0) count++;
  if ((header & 1) !== 0) count++;
  const expectedLength = 4 + info[0]! + info[1]!;
  if (bytes.length === expectedLength) {
    count++;
    const crc = (bytes.at(-2)! << 8) | bytes.at(-1)!;
    if (crc16CcittFalse(bytes.slice(0, -2)) !== crc) count++;
  } else {
    count++;
  }
  return count;
}

function lfastFrame(data: readonly number[], channelType = 4): LfastFrame {
  return { channelType, cts: 0, sleep: 1, data };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53495049,
}: GenerationOptions = {}): Iterable<SipiCase> {
  const writeData = sipiFrame(0b00110, 1, 5, [0x00, 0x00, 0x10, 0x00], [1, 2, 3, 4]);
  const badCrc = sipiFrame(0b00110, 2, 6, [0x00, 0x00, 0x10, 0x00], [1, 2, 3, 4], 0, 0, true);
  const reserved = sipiFrame(0b00001, 7, 7, [0, 0, 0, 0], [], 0x0f, 1);
  const shortHeader = [0x00];
  const incomplete = writeData.slice(0, 4);
  const unknown = sipiFrame(0b00011, 3, 4);
  const frames = [
    lfastFrame(shortHeader),
    lfastFrame(writeData),
    lfastFrame(badCrc),
    lfastFrame(reserved),
    lfastFrame(incomplete),
    lfastFrame(unknown),
  ];
  const startSample = 9_007_199_254_740_990n;
  const boundaryPlan = plan(frames, startSample);
  yield {
    name: 'header-crc-and-warning-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: SIPI_SAMPLE_RATE,
    startSample,
    channels: SIPI_CHANNELS,
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: SIPI_CHAIN,
    *generate() {
      const expectedAnnotations: ExpectedFrame[] = [
        { classIndex: 6, texts: ['Header too short'] },
        { classIndex: 0, texts: ['01'] },
        { classIndex: 1, texts: ['Write 4 byte with ACK'] },
        { classIndex: 5, texts: ['CRC OK'] },
        { classIndex: 5 },
        { classIndex: 6, texts: ['CRC mismatch'] },
        { classIndex: 6, texts: ['Reserved bits #4..7 should be 0'] },
        { classIndex: 6, texts: ['Reserved bit #0 should be 0'] },
      ];
      yield {
        data: boundaryPlan.runs,
        expected: [{ protoId: 'sipi', kind: 'summary' }],
        expectedAnnotations,
        annotationCount: frames.reduce((sum, frame) => sum + frameAnnotationCount(frame.data), 0),
        payloadBits: boundaryPlan.frames.reduce((sum, frame) => sum + frame.bits, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerFrame = 16 + 8 + 36 * 8 + 1;
  const count = Math.ceil(required / bitsPerFrame);
  const perBlock = 128;
  yield {
    name: 'seeded-long-stream32',
    kind: 'long',
    seed,
    sampleRate: SIPI_SAMPLE_RATE,
    startSample: 0n,
    channels: SIPI_CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: SIPI_CHAIN,
    *generate() {
      const random = randomWords(seed);
      let sample = 0n;
      for (let offset = 0; offset < count; offset += perBlock) {
        const frames: LfastFrame[] = [];
        for (let index = offset; index < Math.min(count, offset + perBlock); index++) {
          const data = Array.from({ length: 32 }, () => random() & 0xff);
          const bytes = sipiFrame(0b10111, index & 7, 4 + (index & 7), [], data);
          frames.push(lfastFrame(bytes, 4 + (index & 7)));
        }
        const blockPlan = plan(frames, sample);
        sample = blockPlan.endSample;
        const first = blockPlan.frames[0]!;
        yield {
          data: blockPlan.runs,
          expected: offset === 0 ? [{ protoId: 'sipi', kind: 'summary' }] : [],
          expectedAnnotations:
            offset === 0
              ? [
                  {
                    classIndex: 0,
                    texts: ['00'],
                    ss: first.payloadStart,
                    es: first.payloadStart + BigInt(3 * SIPI_BIT_WIDTH),
                  },
                  {
                    classIndex: 1,
                    texts: ['Stream 32 byte with ACK'],
                    ss: first.payloadStart + BigInt(3 * SIPI_BIT_WIDTH),
                    es: first.payloadStart + BigInt(8 * SIPI_BIT_WIDTH),
                  },
                  {
                    classIndex: 5,
                    texts: ['CRC OK'],
                    ss: first.payloadEnd - BigInt(16 * SIPI_BIT_WIDTH),
                    es: first.payloadEnd,
                  },
                ]
              : [{ classIndex: 5, texts: ['CRC OK'] }],
          annotationCount: frames.length * 36,
          payloadBits: frames.length * bitsPerFrame,
        };
      }
    },
  };
}
