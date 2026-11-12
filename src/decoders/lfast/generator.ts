import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { LfastRun } from './encoder.js';

export interface LfastFrame {
  readonly channelType: number;
  readonly cts: 0 | 1;
  readonly sleep: 0 | 1;
  readonly data: readonly number[];
}

export interface LfastCase extends RoundtripCase<LfastRun> {}

const PAYLOAD_SIZES: Readonly<Record<number, readonly [id: number, bits: number]>> = {
  1: [0, 8],
  4: [1, 32],
  8: [2, 64],
  12: [3, 96],
  16: [4, 128],
  32: [5, 256],
  64: [6, 512],
  36: [7, 288],
};

const SIZE_TEXT: Readonly<Record<number, string>> = {
  0: '8 bit',
  1: '32 bit / 4 byte',
  2: '64 bit / 8 byte',
  3: '96 bit / 12 byte',
  4: '128 bit / 16 byte',
  5: '256 bit / 32 byte',
  6: '512 bit / 64 byte',
  7: '288 bit / 36 byte',
};

const CHANNEL_TEXT: Readonly<Record<number, string>> = {
  0: 'Interface Control / PING',
  1: 'Unsolicited Status (32 bit)',
  2: 'Slave Interface Control / Read',
  3: 'CTS Transfer',
  4: 'Data Channel A',
  5: 'Data Channel B',
  6: 'Data Channel C',
  7: 'Data Channel D',
  8: 'Data Channel E',
  9: 'Data Channel F',
  10: 'Data Channel G',
  11: 'Data Channel H',
  12: 'Reserved',
  13: 'Reserved',
  14: 'Reserved',
  15: 'Reserved',
};

const CONTROL_TEXT: Readonly<Record<number, string>> = {
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

interface PlannedFrame {
  readonly frame: LfastFrame;
  readonly frameStart: bigint;
  readonly payloadStart: bigint;
  readonly payloadEnd: bigint;
  readonly sleepStart: bigint;
  readonly bits: number;
  readonly protocol: readonly (readonly [bigint, bigint, number])[] | null;
}

interface LfastPlan {
  readonly runs: LfastRun[];
  readonly frames: PlannedFrame[];
  readonly endSample: bigint;
}

function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function appendBits(bits: number[], value: number, width: number): void {
  for (let shift = width - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1);
}

function frameBits(frame: LfastFrame): number[] {
  const size = PAYLOAD_SIZES[frame.data.length];
  if (!size) throw new RangeError(`Unsupported LFAST payload byte count: ${frame.data.length}`);
  if (!Number.isInteger(frame.channelType) || frame.channelType < 0 || frame.channelType > 15)
    throw new RangeError('LFAST channel type must be an integer from 0 through 15.');
  if (frame.data.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff))
    throw new RangeError('LFAST payload bytes must be integers from 0 through 255.');

  const bits: number[] = [];
  appendBits(bits, 0xa84b, 16);
  appendBits(bits, (size[0] << 5) | (frame.channelType << 1) | frame.cts, 8);
  for (const value of frame.data) appendBits(bits, value, 8);
  bits.push(frame.sleep);
  return bits;
}

function normalizeFrame(frame: LfastFrame): LfastFrame {
  const data = [...frame.data];
  data[0] = (data[0]! & 0x7f) | ((frame.cts ^ 1) << 7);
  const last = data.length - 1;
  const lowBits = frame.sleep === 0 ? 0b01 : 0b10;
  data[last] = (data[last]! & 0xfc) | lowBits;
  return { ...frame, data };
}

function planFrames(frames: readonly LfastFrame[], startSample: bigint, bitWidth: number): LfastPlan {
  if (!Number.isSafeInteger(bitWidth) || bitWidth < 1)
    throw new RangeError('LFAST bit width must be a positive integer.');
  const runs: LfastRun[] = [];
  const planned: PlannedFrame[] = [];
  const idle = bitWidth * 3;
  let level: 0 | 1 = 0;
  let cursor = startSample;

  const append = (value: 0 | 1, samples: number): void => {
    if (value === level && runs.length) {
      const last = runs[runs.length - 1]!;
      runs[runs.length - 1] = { data: value, samples: last.samples + samples };
    } else {
      runs.push({ data: value, samples });
      level = value;
    }
    cursor += BigInt(samples);
  };

  for (const input of frames) {
    const frame = normalizeFrame(input);
    append(0, idle);
    const frameStart = cursor;
    const bits = frameBits(frame);
    for (const bit of bits) append(bit as 0 | 1, bitWidth);
    append(0, idle);

    const payloadStart = frameStart + BigInt(24 * bitWidth);
    const payloadEnd = payloadStart + BigInt(frame.data.length * 8 * bitWidth);
    const protocol =
      frame.channelType >= 4 && frame.channelType <= 11
        ? frame.data.map((value, index): readonly [bigint, bigint, number] => [
            payloadStart + BigInt(index * 8 * bitWidth),
            payloadStart + BigInt((index + 1) * 8 * bitWidth),
            value,
          ])
        : null;
    planned.push({
      frame,
      frameStart,
      payloadStart,
      payloadEnd,
      sleepStart: payloadEnd,
      bits: bits.length,
      protocol,
    });
  }

  return { runs, frames: planned, endSample: cursor };
}

function frameAnnotations(plan: PlannedFrame, bitWidth: number): ExpectedFrame[] {
  const sizeId = PAYLOAD_SIZES[plan.frame.data.length]![0];
  const dataChannel = plan.frame.channelType >= 4 && plan.frame.channelType <= 11;
  const annotations: ExpectedFrame[] = [
    {
      ss: plan.frameStart,
      es: plan.frameStart + BigInt(16 * bitWidth),
      classIndex: 1,
      texts: ['Sync OK'],
    },
    {
      ss: plan.frameStart + BigInt(16 * bitWidth),
      es: plan.frameStart + BigInt(19 * bitWidth),
      classIndex: 2,
      texts: [SIZE_TEXT[sizeId]!],
    },
    {
      ss: plan.frameStart + BigInt(19 * bitWidth),
      es: plan.frameStart + BigInt(23 * bitWidth),
      classIndex: 3,
      texts: [CHANNEL_TEXT[plan.frame.channelType]!],
    },
    {
      ss: plan.frameStart + BigInt(23 * bitWidth),
      es: plan.frameStart + BigInt(24 * bitWidth),
      classIndex: 4,
      texts: [String(plan.frame.cts)],
    },
  ];

  for (let index = 0; index < plan.frame.data.length; index++) {
    const value = plan.frame.data[index]!;
    annotations.push({
      ss: plan.payloadStart + BigInt(index * 8 * bitWidth),
      es: plan.payloadStart + BigInt((index + 1) * 8 * bitWidth),
      classIndex: dataChannel ? 5 : 6,
      texts: [dataChannel || index > 0 ? hex2(value) : (CONTROL_TEXT[value] ?? hex2(value))],
    });
  }

  annotations.push({
    ss: plan.sleepStart,
    es: plan.sleepStart + BigInt(bitWidth),
    classIndex: 7,
    texts:
      plan.frame.sleep === 1
        ? ['LVDS sleep mode request', 'Sleep', 'Y']
        : ['No LVDS sleep mode request', 'No sleep', 'N'],
  });
  return annotations;
}

function protocolFrames(plan: LfastPlan): ExpectedFrame[] {
  return plan.frames.flatMap((item) =>
    item.protocol
      ? [
          {
            ss: item.payloadStart,
            es: item.payloadEnd,
            protoId: 'lfast',
            kind: 'protocol',
            data: item.protocol,
          } satisfies ExpectedFrame,
        ]
      : [],
  );
}

function annotationCount(plan: LfastPlan): number {
  return plan.frames.reduce(
    (sum, item) => sum + item.bits + item.frame.data.length + 5 - (item.frame.sleep === 0 ? 1 : 0),
    0,
  );
}

function payloadBits(plan: LfastPlan): number {
  return plan.frames.reduce((sum, item) => sum + item.bits, 0);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4c464153,
}: GenerationOptions = {}): Iterable<LfastCase> {
  const boundaryFrames: LfastFrame[] = [
    { channelType: 4, cts: 0, sleep: 0, data: [0x00] },
    { channelType: 5, cts: 1, sleep: 1, data: [0xff, 0x00, 0xaa, 0x55] },
    { channelType: 6, cts: 0, sleep: 0, data: [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80] },
    {
      channelType: 7,
      cts: 1,
      sleep: 1,
      data: [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb],
    },
    { channelType: 8, cts: 0, sleep: 0, data: Array.from({ length: 16 }, (_, index) => index * 17) },
    { channelType: 9, cts: 1, sleep: 1, data: Array.from({ length: 32 }, (_, index) => index * 7) },
    { channelType: 10, cts: 0, sleep: 0, data: Array.from({ length: 64 }, (_, index) => index * 3) },
    { channelType: 11, cts: 1, sleep: 1, data: Array.from({ length: 36 }, (_, index) => index * 5) },
    { channelType: 0, cts: 1, sleep: 0, data: [0x00] },
    { channelType: 0, cts: 1, sleep: 1, data: [0x31] },
    { channelType: 2, cts: 1, sleep: 0, data: [0x02] },
    { channelType: 12, cts: 1, sleep: 0, data: [0x55] },
  ];
  const boundaryStart = 9_007_199_254_740_990n;
  const boundaryPlan = planFrames(boundaryFrames, boundaryStart, 2);
  yield {
    name: 'payload-size-channel-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: boundaryStart,
    channels: { data: 3 },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: boundaryPlan.runs,
        expected: protocolFrames(boundaryPlan),
        expectedAnnotations: boundaryPlan.frames.flatMap((frame) => frameAnnotations(frame, 2)),
        annotationCount: annotationCount(boundaryPlan),
        payloadBits: payloadBits(boundaryPlan),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const framesPerBlock = 1024;
  const bitWidth = 2;
  const bitsPerFrame = 16 + 8 + 64 * 8 + 1;
  const blockCount = Math.max(2, Math.ceil(required / (framesPerBlock * bitsPerFrame)));
  const random = randomWords(seed);
  const longCase: LfastCase = {
    name: 'seeded-long-data-transfers',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { data: 0 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      let sample = longCase.startSample;
      for (let block = 0; block < blockCount; block++) {
        const frames: LfastFrame[] = [];
        for (let index = 0; index < framesPerBlock; index++) {
          const data = Array.from({ length: 64 }, () => random() & 0xff);
          frames.push({
            channelType: 4 + (random() & 7),
            cts: (random() & 1) as 0 | 1,
            sleep: (random() & 1) as 0 | 1,
            data,
          });
        }

        const plan = planFrames(frames, sample, bitWidth);
        sample = plan.endSample;
        yield {
          data: plan.runs,
          expected: protocolFrames(plan),
          expectedAnnotations: frameAnnotations(plan.frames[0]!, bitWidth).slice(0, 6),
          annotationCount: annotationCount(plan),
          payloadBits: payloadBits(plan),
        };
      }
    },
  };
  yield longCase;
}
