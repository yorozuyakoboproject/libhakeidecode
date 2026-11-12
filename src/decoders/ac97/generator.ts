import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export const AC97_LEAD_BITS = 4;
export const AC97_INITIAL_LOW_SAMPLES = 1;
export const AC97_FINAL_HIGH_SAMPLES = 1;
export const AC97_BIT_SAMPLES = 2;
export const AC97_FRAME_BITS = 256;
export const AC97_FRAME_SAMPLES = AC97_FRAME_BITS * AC97_BIT_SAMPLES;
export const AC97_SLOT_BITS = [16, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20] as const;
export const AC97_SLOT_STARTS = [0, 16, 36, 56, 76, 96, 116, 136, 156, 176, 196, 216, 236, 256] as const;

export interface AC97Frame {
  readonly out: readonly number[];
  readonly in: readonly number[];
}

export interface AC97Case extends RoundtripCase<AC97Frame> {}

const ANN = {
  BITS_OUT: 0,
  BITS_IN: 1,
  SLOT_RAW_OUT: 2,
  SLOT_RAW_IN: 3,
  ERROR: 5,
  SLOT_OUT_TAG: 6,
  SLOT_OUT_IO_CTRL: 18,
  SLOT_IN_TAG: 19,
  SLOT_IN_IO_STS: 31,
} as const;

const ERROR_TEXTS = ['reserved bit error', 'rsv error', 'rsv'];

function channels(out: boolean, input: boolean): Record<string, number> {
  return { sync: 5, clk: 1, ...(out ? { out: 7 } : {}), ...(input ? { in: 3 } : {}) };
}

function tag(valid: number, ready: number, reserved: number, codec: number): number {
  return ((ready & 1) << 15) | ((valid & 0xfff) << 3) | ((reserved & 1) << 2) | (codec & 3);
}

function commandAddress(read: number, address: number, reserved: number): number {
  return ((read & 1) << 19) | ((address & 0x7f) << 12) | (reserved & 0xfff);
}

function statusAddress(reserved: number, address: number, request: number, trailer: number): number {
  return ((reserved & 1) << 19) | ((address & 0x7f) << 12) | ((request & 0x3ff) << 2) | (trailer & 3);
}

function commandData(value: number, reserved: number): number {
  return ((value & 0xffff) << 4) | (reserved & 0xf);
}

function frameStartSample(config: Pick<AC97Case, 'startSample'>, frameIndex: number): bigint {
  return (
    config.startSample +
    BigInt(AC97_INITIAL_LOW_SAMPLES + (AC97_LEAD_BITS + frameIndex * AC97_FRAME_BITS) * AC97_BIT_SAMPLES)
  );
}

function slotSample(config: Pick<AC97Case, 'startSample'>, frameIndex: number, slot: number): bigint {
  return frameStartSample(config, frameIndex) + BigInt(AC97_SLOT_STARTS[slot]! * AC97_BIT_SAMPLES);
}

function text(value: number, minimumBits: number): string {
  return value.toString(16).padStart(Math.ceil(minimumBits / 4), '0');
}

function fieldText(value: number, width: number): string {
  return value.toString(16).padStart(width, ' ');
}

function directionAnnotations(frame: AC97Frame, out: boolean): number {
  const slots = out ? frame.out : frame.in;
  let count = AC97_FRAME_BITS + 13 + 3;
  const tagValue = slots[0]!;
  if ((tagValue >> 2) & 1) count++;
  const valid = (tagValue >> 3) & 0xfff;
  for (let slot = 1; slot <= 12; slot++) {
    if (!(valid & (1 << (12 - slot)))) continue;
    const value = slots[slot]!;
    if (slot === 1) {
      count += 2;
      if ((value >> 12) & 0x7f & 1) count++;
      if (out) {
        if ((value & 0xffc) !== 0) count++;
        if ((value & 3) !== 0) count++;
      } else {
        if ((value >> 19) & 1) count++;
        if ((value & 3) !== 0) count++;
      }
    } else if (slot === 2) {
      count++;
      if ((value & 0xf) !== 0) count++;
    } else count++;
  }
  return count;
}

function frameAnnotations(frame: AC97Frame, out: boolean, input: boolean): number {
  return (out ? directionAnnotations(frame, true) : 0) + (input ? directionAnnotations(frame, false) : 0);
}

function blockAnnotationCount(
  frames: readonly AC97Frame[],
  out: boolean,
  input: boolean,
  includeLead: boolean,
): number {
  let count = includeLead ? AC97_LEAD_BITS * Number(out) + AC97_LEAD_BITS * Number(input) : 0;
  for (const frame of frames) count += frameAnnotations(frame, out, input);
  return count;
}

function frameExpectations(
  config: Pick<AC97Case, 'startSample'>,
  frame: AC97Frame,
  index: number,
  out: boolean,
  input: boolean,
): ExpectedFrame[] {
  const expected: ExpectedFrame[] = [];
  const start = frameStartSample(config, index);
  const outTag = frame.out[0]!;
  const inTag = frame.in[0]!;

  if (out)
    expected.push({
      ss: start,
      es: slotSample(config, index, 1),
      classIndex: ANN.SLOT_RAW_OUT,
      texts: [text(outTag, 16)],
    });
  if (input)
    expected.push({
      ss: start,
      es: slotSample(config, index, 1),
      classIndex: ANN.SLOT_RAW_IN,
      texts: [text(inTag, 16)],
    });

  if (out) {
    expected.push({
      ss: start,
      es: start + 2n,
      classIndex: ANN.SLOT_OUT_TAG,
      texts: outTag & 0x8000 ? ['READY: 1', 'READY', 'RDY', 'R'] : ['ready: 0', 'rdy', '-'],
    });
    const valid = (outTag >> 3) & 0xfff;
    expected.push({
      ss: start + 2n,
      es: start + 26n,
      classIndex: ANN.SLOT_OUT_TAG,
      texts: [`VALID: ${fieldText(valid, 3)}`, fieldText(valid, 3)],
    });
    if ((outTag >> 2) & 1)
      expected.push({
        ss: start + 26n,
        es: start + 28n,
        classIndex: ANN.ERROR,
        texts: ERROR_TEXTS,
      });
  }

  if (input) {
    expected.push({
      ss: start,
      es: start + 2n,
      classIndex: ANN.SLOT_IN_TAG,
      texts: inTag & 0x8000 ? ['READY: 1', 'READY', 'RDY', 'R'] : ['ready: 0', 'rdy', '-'],
    });
    const valid = (inTag >> 3) & 0xfff;
    expected.push({
      ss: start + 2n,
      es: start + 26n,
      classIndex: ANN.SLOT_IN_TAG,
      texts: [`VALID: ${fieldText(valid, 3)}`, fieldText(valid, 3)],
    });
    if ((inTag >> 2) & 1)
      expected.push({
        ss: start + 26n,
        es: start + 28n,
        classIndex: ANN.ERROR,
        texts: ERROR_TEXTS,
      });
  }

  if (out && (outTag >> 3) & 1)
    expected.push({
      ss: slotSample(config, index, 12),
      es: start + BigInt(AC97_FRAME_BITS * AC97_BIT_SAMPLES),
      classIndex: ANN.SLOT_OUT_IO_CTRL,
      texts: [text(frame.out[12]!, 20)],
    });
  if (input && (inTag >> 3) & 1)
    expected.push({
      ss: slotSample(config, index, 12),
      es: start + BigInt(AC97_FRAME_BITS * AC97_BIT_SAMPLES),
      classIndex: ANN.SLOT_IN_IO_STS,
      texts: [text(frame.in[12]!, 20)],
    });

  return expected;
}

function leadExpectations(config: Pick<AC97Case, 'startSample'>, out: boolean, input: boolean): ExpectedFrame[] {
  const expected: ExpectedFrame[] = [];
  const start = config.startSample + BigInt(AC97_INITIAL_LOW_SAMPLES);
  if (out)
    expected.push({
      ss: start,
      es: start + BigInt(AC97_BIT_SAMPLES),
      classIndex: ANN.BITS_OUT,
      texts: ['0'],
    });
  if (input)
    expected.push({
      ss: start,
      es: start + BigInt(AC97_BIT_SAMPLES),
      classIndex: ANN.BITS_IN,
      texts: ['0'],
    });
  return expected;
}

function* blocks(
  config: Pick<AC97Case, 'startSample'>,
  frames: readonly AC97Frame[],
  out: boolean,
  input: boolean,
  perBlock: number,
): Iterable<{
  data: readonly AC97Frame[];
  expected: readonly ExpectedFrame[];
  expectedAnnotations: readonly ExpectedFrame[];
  annotationCount: number;
  payloadBits: number;
}> {
  const totalAnnotations = blockAnnotationCount(frames, out, input, true);
  const summary: ExpectedFrame = {
    ss: config.startSample,
    es: frameStartSample(config, Math.max(0, frames.length - 1)) + BigInt(AC97_FRAME_SAMPLES + AC97_FINAL_HIGH_SAMPLES),
    protoId: 'ac97',
    kind: 'summary',
    annotations: totalAnnotations,
  };

  for (let offset = 0; offset < frames.length; offset += perBlock) {
    const data = frames.slice(offset, offset + perBlock);
    const expectedAnnotations = [
      ...(offset === 0 ? leadExpectations(config, out, input) : []),
      ...frameExpectations(config, data[0]!, offset, out, input),
    ];
    yield {
      data,
      expected: offset === 0 ? [summary] : [],
      expectedAnnotations,
      annotationCount: blockAnnotationCount(data, out, input, offset === 0),
      payloadBits: data.length * AC97_FRAME_BITS,
    };
  }
}

function legalFrame(index: number, outValid = 0xfff, inValid = 0xfff): AC97Frame {
  const out = [
    tag(outValid, 1, 0, index & 3),
    commandAddress(index & 1, (index * 2) & 0x7e, 0),
    commandData(0x1000 + index, 0),
    ...Array.from({ length: 10 }, (_, slot) => ((index + 1) * (slot + 3)) & 0xfffff),
  ];
  const input = [
    tag(inValid, 1, 0, (index + 1) & 3),
    statusAddress(0, ((index + 1) * 2) & 0x7e, (index * 0x2a5) & 0x3ff, 0),
    commandData(0x8000 + index, 0),
    ...Array.from({ length: 10 }, (_, slot) => ((index + 2) * (slot + 5)) & 0xfffff),
  ];
  return { out, in: input };
}

function minimalFrame(): AC97Frame {
  return { out: [0, 0, 0, ...Array(10).fill(0)], in: [0, 0, 0, ...Array(10).fill(0)] };
}

function maximalFrame(): AC97Frame {
  return {
    out: [tag(0xfff, 1, 0, 3), commandAddress(1, 126, 0), commandData(0xffff, 0), ...Array(10).fill(0xfffff)],
    in: [tag(0xfff, 1, 0, 3), statusAddress(0, 126, 0x3ff, 0), commandData(0xffff, 0), ...Array(10).fill(0xfffff)],
  };
}

function errorFrame(): AC97Frame {
  return {
    out: [
      tag(0xfff, 1, 1, 3),
      commandAddress(1, 127, 0xfff),
      commandData(0xabcd, 0xf),
      ...Array.from({ length: 10 }, (_, slot) => 0xf0000 | (slot << 12) | 0xabc),
    ],
    in: [
      tag(0xfff, 0, 1, 2),
      statusAddress(1, 127, 0x3ff, 3),
      commandData(0x1234, 0xf),
      ...Array.from({ length: 10 }, (_, slot) => 0x0f000 | (slot << 10) | 0x155),
    ],
  };
}

function randomLegalFrame(random: () => number): AC97Frame {
  return {
    out: [
      tag(random() & 0xfff, 1, 0, random() & 3),
      commandAddress(random(), random() & 0x7e, 0),
      commandData(random(), 0),
      ...Array.from({ length: 10 }, () => random() & 0xfffff),
    ],
    in: [
      tag(random() & 0xfff, 1, 0, random() & 3),
      statusAddress(0, random() & 0x7e, random(), 0),
      commandData(random(), 0),
      ...Array.from({ length: 10 }, () => random() & 0xfffff),
    ],
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x41433937,
}: GenerationOptions = {}): Iterable<AC97Case> {
  const boundaries: Array<{
    name: string;
    out: boolean;
    input: boolean;
    startSample: bigint;
    frames: readonly AC97Frame[];
  }> = [
    {
      name: 'duplex-min-max-patterns',
      out: true,
      input: true,
      startSample: 13n,
      frames: [minimalFrame(), maximalFrame(), legalFrame(2, 0x555, 0xaaa), legalFrame(3, 0xfff, 0)],
    },
    {
      name: 'output-only',
      out: true,
      input: false,
      startSample: 7n,
      frames: [maximalFrame()],
    },
    {
      name: 'input-only',
      out: false,
      input: true,
      startSample: 11n,
      frames: [maximalFrame()],
    },
    {
      name: 'reserved-field-errors',
      out: true,
      input: true,
      startSample: 3n,
      frames: [errorFrame()],
    },
    {
      name: 'invalid-tags',
      out: true,
      input: true,
      startSample: 5n,
      frames: [minimalFrame()],
    },
    {
      name: 'large-sample-position',
      out: true,
      input: true,
      startSample: 9_007_199_254_740_990n,
      frames: [minimalFrame(), maximalFrame()],
    },
  ];

  for (const item of boundaries) {
    const config = {
      name: item.name,
      kind: 'boundary' as const,
      seed,
      sampleRate: 24_576_000,
      startSample: item.startSample,
      channels: channels(item.out, item.input),
      options: {},
      chunkSamples: [1, 7, 127, 4093],
      minimumPayloadBits: 0,
    };
    const testCase: AC97Case = {
      ...config,
      *generate() {
        yield* blocks(config, item.frames, item.out, item.input, item.frames.length);
      },
    };
    yield testCase;
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const frameCount = Math.ceil(required / AC97_FRAME_BITS);
  const random = randomWords(seed);
  const frames = Array.from({ length: frameCount }, () => randomLegalFrame(random));
  const config = {
    name: 'seeded-long-duplex',
    kind: 'long' as const,
    seed,
    sampleRate: 24_576_000,
    startSample: 0n,
    channels: channels(true, true),
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
  };
  yield {
    ...config,
    *generate() {
      yield* blocks(config, frames, true, true, 256);
    },
  };
}
