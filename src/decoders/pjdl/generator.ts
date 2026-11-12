import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export const PJDL_MODE = 4;
export const PJDL_IDLE_ADD_US = 4;
export const PJDL_DATA_SAMPLES = 26;
export const PJDL_PAD_SAMPLES = 60;
export const PJDL_SLOT_SAMPLES = PJDL_DATA_SAMPLES + PJDL_PAD_SAMPLES;
export const PJDL_BYTE_SAMPLES = PJDL_PAD_SAMPLES + 9 * PJDL_DATA_SAMPLES;
const INITIAL_SAMPLES = 600;
const IDLE_SAMPLES = 600;

export interface PjdlFrame {
  readonly bytes: readonly number[];
}

export interface PjdlCase extends RoundtripCase<PjdlFrame> {
  readonly initialSamples: number;
  readonly idleSamples: number;
}

interface FramePlan {
  readonly annotations: ExpectedFrame[];
  readonly frames: ExpectedFrame[];
  readonly annotationCount: number;
  readonly payloadBits: number;
  readonly end: bigint;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function planFrame(frame: PjdlFrame, start: bigint): FramePlan {
  if (!frame.bytes.length || frame.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff))
    throw new Error('PJDL frames require at least one byte in the range 0..255');
  const annotations: ExpectedFrame[] = [];
  const frames: ExpectedFrame[] = [];
  let cursor = start;
  for (let index = 0; index < 3; index++) {
    const slotStart = cursor;
    const slotMiddle = cursor + BigInt(PJDL_PAD_SAMPLES);
    const slotEnd = cursor + BigInt(PJDL_SLOT_SAMPLES);
    annotations.push(
      { ss: slotStart, es: slotMiddle, classIndex: 2, texts: ['PAD', '1'] },
      {
        ss: slotMiddle,
        es: slotEnd,
        classIndex: 3,
        texts: ['ZERO', '0'],
      },
    );
    frames.push(
      { ss: slotStart, es: slotMiddle, protoId: 'pjon_link', kind: 'protocol', data: ['PAD_BIT', 1] },
      { ss: slotMiddle, es: slotEnd, protoId: 'pjon_link', kind: 'protocol', data: ['DATA_BIT', 0] },
      { ss: slotStart, es: slotEnd, protoId: 'pjon_link', kind: 'protocol', data: ['SYNC_PAD', true] },
    );
    cursor += BigInt(PJDL_SLOT_SAMPLES);
  }
  annotations.push({ ss: start, es: cursor, classIndex: 8, texts: ['FRAME INIT', 'INIT', 'I'] });
  frames.push({ ss: start, es: cursor, protoId: 'pjon_link', kind: 'protocol', data: ['FRAME_INIT', true] });

  for (const byte of frame.bytes) {
    const byteStart = cursor;
    const syncEnd = byteStart + BigInt(PJDL_SLOT_SAMPLES);
    annotations.push(
      {
        ss: byteStart,
        es: byteStart + BigInt(PJDL_PAD_SAMPLES),
        classIndex: 2,
        texts: ['PAD', '1'],
      },
      {
        ss: byteStart + BigInt(PJDL_PAD_SAMPLES),
        es: byteStart + BigInt(PJDL_SLOT_SAMPLES),
        classIndex: 3,
        texts: ['ZERO', '0'],
      },
    );
    frames.push(
      {
        ss: byteStart,
        es: byteStart + BigInt(PJDL_PAD_SAMPLES),
        protoId: 'pjon_link',
        kind: 'protocol',
        data: ['PAD_BIT', 1],
      },
      {
        ss: byteStart + BigInt(PJDL_PAD_SAMPLES),
        es: syncEnd,
        protoId: 'pjon_link',
        kind: 'protocol',
        data: ['DATA_BIT', 0],
      },
      { ss: byteStart, es: syncEnd, protoId: 'pjon_link', kind: 'protocol', data: ['SYNC_PAD', true] },
    );
    for (let bit = 0; bit < 8; bit++) {
      const ss = byteStart + BigInt(PJDL_SLOT_SAMPLES + bit * PJDL_DATA_SAMPLES);
      const es = ss + BigInt(PJDL_DATA_SAMPLES);
      annotations.push({
        ss,
        es,
        classIndex: 4,
        texts: [String((byte >>> bit) & 1)],
      });
      frames.push({
        ss,
        es,
        protoId: 'pjon_link',
        kind: 'protocol',
        data: ['DATA_BIT', (byte >>> bit) & 1],
      });
    }
    cursor = byteStart + BigInt(PJDL_BYTE_SAMPLES);
    annotations.push({ ss: byteStart, es: cursor, classIndex: 7, texts: [hex(byte)] });
    frames.push({
      ss: byteStart,
      es: cursor,
      protoId: 'pjon_link',
      kind: 'protocol',
      data: ['DATA_BYTE', byte],
    });
  }

  annotations.push({
    ss: start,
    es: cursor,
    classIndex: 9,
    texts: [`INIT ${frame.bytes.map(hex).join(' ')}`],
  });
  frames.push({
    ss: start,
    es: cursor,
    protoId: 'pjon_link',
    kind: 'protocol',
    data: ['FRAME_DATA', ['INIT', ...frame.bytes]],
  });
  return {
    annotations,
    frames,
    annotationCount: 11 * frame.bytes.length + 8,
    payloadBits: 9 * frame.bytes.length + 3,
    end: cursor,
  };
}

function boundary(name: string, frames: readonly PjdlFrame[], startSample: bigint): PjdlCase {
  return {
    name,
    kind: 'boundary',
    seed: 0x504a444c,
    sampleRate: 1_000_000,
    startSample,
    channels: { data: 0 },
    options: { mode: PJDL_MODE, idle_add_us: PJDL_IDLE_ADD_US },
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    initialSamples: INITIAL_SAMPLES,
    idleSamples: IDLE_SAMPLES,
    *generate() {
      const annotations: ExpectedFrame[] = [];
      const expected: ExpectedFrame[] = [];
      let sample = startSample + BigInt(INITIAL_SAMPLES);
      let payloadBits = 0;
      for (const frame of frames) {
        const plan = planFrame(frame, sample);
        annotations.push(...plan.annotations);
        expected.push(...plan.frames);
        payloadBits += plan.payloadBits;
        sample = plan.end + BigInt(IDLE_SAMPLES);
      }
      yield {
        data: frames,
        expected,
        expectedAnnotations: annotations,
        annotationCount: annotations.length,
        payloadBits,
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x504a444c,
}: GenerationOptions = {}): Iterable<PjdlCase> {
  yield boundary('single-frame', [{ bytes: [0x00, 0x02, 0x54, 0x2a] }], 17n);
  yield boundary('consecutive-frames', [{ bytes: [0x12, 0x34, 0x56] }, { bytes: [0x00, 0x20, 0x7e, 0x10] }], 31n);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bytesPerFrame = 256;
  const bitsPerFrame = 9 * bytesPerFrame + 3;
  const blocks = Math.ceil(required / bitsPerFrame);
  yield {
    name: 'seeded-long-frames',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { data: 0 },
    options: { mode: PJDL_MODE, idle_add_us: PJDL_IDLE_ADD_US },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    initialSamples: INITIAL_SAMPLES,
    idleSamples: IDLE_SAMPLES,
    *generate() {
      const random = randomWords(seed);
      let sample = BigInt(INITIAL_SAMPLES);
      for (let block = 0; block < blocks; block++) {
        const bytes = Array.from({ length: bytesPerFrame }, () => random() & 0xff);
        bytes[bytes.length - 1] ||= 1;
        const frame = { bytes };
        const plan = planFrame(frame, sample);
        yield {
          data: [frame],
          expected: plan.frames,
          expectedAnnotations: [plan.annotations[6]!, plan.annotations.at(-1)!],
          annotationCount: plan.annotationCount,
          payloadBits: plan.payloadBits,
        };
        sample = plan.end + BigInt(IDLE_SAMPLES);
      }
    },
  };
}
