import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { CAN_INITIAL_IDLE_SAMPLES, CAN_SAMPLE_POINT_PERCENT, canFrameBits } from './encoder.js';

export interface CanFrame {
  readonly extended: boolean;
  readonly id: number;
  readonly rtr: boolean;
  readonly dlc: number;
  readonly data: readonly number[];
}

export interface CanCase extends RoundtripCase<CanFrame> {}

const SAMPLE_RATE = 8_000_000;
const BITRATE = 1_000_000;
const BIT_WIDTH = SAMPLE_RATE / BITRATE;
const IDLE_SAMPLES = Math.max(4, Math.ceil(BIT_WIDTH * 2.5));
const OPTIONS = {
  nominal_bitrate: BITRATE,
  fast_bitrate: 2_000_000,
  sample_point: CAN_SAMPLE_POINT_PERCENT,
} as const;

function packet(frame: CanFrame, start: bigint): { expected: ExpectedFrame; end: bigint } {
  const wire = canFrameBits(frame);
  const point = BigInt(Math.trunc((BIT_WIDTH * CAN_SAMPLE_POINT_PERCENT) / 100));
  const sample = start + BigInt((wire.length - 1) * BIT_WIDTH) + point;
  return {
    expected: {
      ss: start + point,
      es: sample,
      protoId: 'can',
      kind: 'protocol',
      data: [
        frame.extended ? 'extended' : 'standard',
        frame.id,
        frame.rtr ? 'remote' : 'data',
        frame.dlc,
        [...frame.data],
      ],
    },
    end: start + BigInt(wire.length * BIT_WIDTH + IDLE_SAMPLES),
  };
}

function block(frames: readonly CanFrame[], expected: readonly ExpectedFrame[]) {
  return {
    data: [...frames],
    expected: [...expected],
    payloadBits: frames.reduce((sum, frame) => sum + canFrameBits(frame).length, 0),
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x43414e,
}: GenerationOptions = {}): Iterable<CanCase> {
  const boundaryFrames: readonly CanFrame[] = [
    { extended: false, id: 0, rtr: false, dlc: 0, data: [] },
    {
      extended: false,
      id: 0x7ff,
      rtr: false,
      dlc: 8,
      data: [0x00, 0x01, 0x7f, 0x80, 0xaa, 0x55, 0xfe, 0xff],
    },
    { extended: false, id: 0x123, rtr: true, dlc: 0, data: [] },
    {
      extended: true,
      id: 0,
      rtr: false,
      dlc: 8,
      data: [0xff, 0x00, 0x5a, 0xa5, 0x11, 0x22, 0x33, 0x44],
    },
    {
      extended: true,
      id: 0x1fffffff,
      rtr: false,
      dlc: 8,
      data: [0x0f, 0xf0, 0xcc, 0x33, 0x80, 0x01, 0x7e, 0x81],
    },
  ];
  const boundaryStart = 9_007_199_254_740_990n;
  let cursor = boundaryStart + BigInt(CAN_INITIAL_IDLE_SAMPLES);
  const boundaryExpected: ExpectedFrame[] = [];
  for (const frame of boundaryFrames) {
    const item = packet(frame, cursor);
    boundaryExpected.push(item.expected);
    cursor = item.end;
  }
  yield {
    name: 'standard-extended-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    channels: { can_rx: 0 },
    options: { ...OPTIONS },
    startSample: boundaryStart,
    chunkSamples: [1, 7, 31, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield block(boundaryFrames, boundaryExpected);
    },
  };

  const remoteRegressionFrames: readonly CanFrame[] = [
    { extended: false, id: 0x321, rtr: true, dlc: 8, data: [] },
    {
      extended: false,
      id: 0x322,
      rtr: false,
      dlc: 8,
      data: [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80],
    },
    { extended: true, id: 0x1abcde, rtr: true, dlc: 8, data: [] },
    {
      extended: true,
      id: 0x1abcdf,
      rtr: false,
      dlc: 8,
      data: [0x81, 0x72, 0x63, 0x54, 0x45, 0x36, 0x27, 0x18],
    },
  ];
  const remoteStart = 7n;
  let remoteCursor = remoteStart + BigInt(CAN_INITIAL_IDLE_SAMPLES);
  const remoteExpected: ExpectedFrame[] = [];
  for (const frame of remoteRegressionFrames) {
    const item = packet(frame, remoteCursor);
    remoteExpected.push(item.expected);
    remoteCursor = item.end;
  }
  yield {
    name: 'remote-dlc-data-field',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    channels: { can_rx: 0 },
    options: { ...OPTIONS },
    startSample: remoteStart,
    chunkSamples: [1, 3, 7, 31, 257],
    minimumPayloadBits: 0,
    *generate() {
      yield block(remoteRegressionFrames, remoteExpected);
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const framesPerBlock = 1536;
  yield {
    name: 'seeded-classic-frames',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    channels: { can_rx: 0 },
    options: { ...OPTIONS },
    startSample: 0n,
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let payloadBits = 0;
      let captured = BigInt(CAN_INITIAL_IDLE_SAMPLES);
      while (payloadBits < required) {
        const frames: CanFrame[] = [];
        const expected: ExpectedFrame[] = [];
        for (let index = 0; index < framesPerBlock; index++) {
          const extended = (random() & 1) === 1;
          const remote = (random() & 15) === 0;
          const dlc = remote ? 0 : 8;
          const data = remote ? [] : Array.from({ length: 8 }, () => random() & 0xff);
          const frame: CanFrame = {
            extended,
            id: random() & (extended ? 0x1fffffff : 0x7ff),
            rtr: remote,
            dlc,
            data,
          };
          const item = packet(frame, captured);
          captured = item.end;
          payloadBits += canFrameBits(frame).length;
          frames.push(frame);
          expected.push(item.expected);
        }
        yield block(frames, expected);
      }
    },
  };
}
