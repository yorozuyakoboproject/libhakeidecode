import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import {
  FLEXRAY_INITIAL_IDLE_BITS,
  FLEXRAY_INTERFRAME_IDLE_BITS,
  FLEXRAY_TSS_BITS,
  flexRayFrameBits,
} from './encoder.js';

export interface FlexRayFrame {
  readonly id: number;
  readonly payloadLength: number;
  readonly cycle: number;
  readonly payloadPreamble: boolean;
  readonly nullFrame: boolean;
  readonly sync: boolean;
  readonly startup: boolean;
  readonly data: readonly number[];
}

export interface FlexRayCase extends RoundtripCase<FlexRayFrame> {}

const SAMPLE_RATE = 40_000_000;
const BITRATE = 10_000_000;
const BIT_WIDTH = SAMPLE_RATE / BITRATE;

function annotationCount(frame: FlexRayFrame): number {
  return 108 + 11 * frame.data.length;
}

function frameObservations(frame: FlexRayFrame, channel: 'A' | 'B', start: bigint) {
  const wire = flexRayFrameBits(frame, channel);
  const tssEnd = start + BigInt(FLEXRAY_TSS_BITS * BIT_WIDTH);
  const raw = (actual: number): number => actual + 2 * Math.ceil(actual / 8);
  const sample = (actual: number): bigint => tssEnd + BigInt(raw(actual) * BIT_WIDTH + Math.trunc(BIT_WIDTH / 2));
  const annotations: ExpectedFrame[] = [
    {
      classIndex: 1,
      texts: ['Transmission start sequence', 'TSS'],
      ss: start,
      es: tssEnd,
    },
    {
      classIndex: 2,
      texts: ['FSS', 'Frame start sequence'],
      ss: sample(0) - BigInt(Math.trunc(BIT_WIDTH / 2)),
      es: sample(0) + BigInt(Math.trunc(BIT_WIDTH / 2)),
    },
    {
      classIndex: 8,
      texts: [`Frame ID: ${frame.id}`, `ID: ${frame.id}`, String(frame.id)],
      ss: sample(6) - BigInt(Math.trunc(BIT_WIDTH / 2)),
      es: sample(16) + BigInt(Math.trunc(BIT_WIDTH / 2)),
    },
  ];
  return {
    annotations,
    count: annotationCount(frame),
    end: tssEnd + BigInt(wire.length * BIT_WIDTH),
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x464c4558,
}: GenerationOptions = {}): Iterable<FlexRayCase> {
  const boundaryFrames: readonly FlexRayFrame[] = [
    {
      id: 1,
      payloadLength: 0,
      cycle: 0,
      payloadPreamble: false,
      nullFrame: true,
      sync: false,
      startup: false,
      data: [],
    },
    {
      id: 2047,
      payloadLength: 127,
      cycle: 63,
      payloadPreamble: true,
      nullFrame: false,
      sync: true,
      startup: true,
      data: Array.from({ length: 254 }, (_, index) => (index * 97 + 0x31) & 0xff),
    },
  ];
  const start = 9_007_199_254_740_990n + BigInt(FLEXRAY_INITIAL_IDLE_BITS * BIT_WIDTH);
  let cursor = start;
  const expectedAnnotations: ExpectedFrame[] = [];
  let count = 0;
  let payloadBits = 0;
  for (const frame of boundaryFrames) {
    const observed = frameObservations(frame, 'A', cursor);
    expectedAnnotations.push(...observed.annotations);
    count += observed.count;
    payloadBits += frame.data.length * 8;
    cursor = observed.end + BigInt(FLEXRAY_INTERFRAME_IDLE_BITS * BIT_WIDTH);
  }
  yield {
    name: 'channel-a-length-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    channels: { channel: 0 },
    options: { channel_type: 'A', bitrate: BITRATE },
    startSample: start - BigInt(FLEXRAY_INITIAL_IDLE_BITS * BIT_WIDTH),
    chunkSamples: [1, 7, 31, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: [...boundaryFrames],
        expected: [{ protoId: 'flexray', kind: 'summary' }],
        expectedAnnotations,
        annotationCount: count,
        payloadBits,
      };
    },
  };

  const channelBFrame: FlexRayFrame = {
    id: 1024,
    payloadLength: 1,
    cycle: 31,
    payloadPreamble: false,
    nullFrame: false,
    sync: false,
    startup: false,
    data: [0x5a, 0xa5],
  };
  const channelBStart = start;
  const channelBObserved = frameObservations(channelBFrame, 'B', channelBStart);
  yield {
    name: 'channel-b-boundary',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    channels: { channel: 1 },
    options: { channel_type: 'B', bitrate: BITRATE },
    startSample: channelBStart - BigInt(FLEXRAY_INITIAL_IDLE_BITS * BIT_WIDTH),
    chunkSamples: [1, 3, 17, 257],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: [channelBFrame],
        expected: [{ protoId: 'flexray', kind: 'summary' }],
        expectedAnnotations: channelBObserved.annotations,
        annotationCount: channelBObserved.count,
        payloadBits: channelBFrame.data.length * 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const framesPerBlock = 260;
  yield {
    name: 'seeded-max-payload',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    channels: { channel: 0 },
    options: { channel_type: 'A', bitrate: BITRATE },
    startSample: 0n,
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let captured = BigInt(FLEXRAY_INITIAL_IDLE_BITS * BIT_WIDTH);
      let payloadBits = 0;
      while (payloadBits < required) {
        const frames: FlexRayFrame[] = [];
        const expectedAnnotations: ExpectedFrame[] = [];
        let count = 0;
        for (let index = 0; index < framesPerBlock; index++) {
          const frame: FlexRayFrame = {
            id: 1 + (random() % 2047),
            payloadLength: 127,
            cycle: random() % 64,
            payloadPreamble: (random() & 1) === 1,
            nullFrame: false,
            sync: (random() & 1) === 1,
            startup: false,
            data: Array.from({ length: 254 }, () => random() & 0xff),
          };
          const observed = frameObservations(frame, 'A', captured);
          captured = observed.end + BigInt(FLEXRAY_INTERFRAME_IDLE_BITS * BIT_WIDTH);
          payloadBits += frame.data.length * 8;
          frames.push(frame);
          count += observed.count;
          if (index === 0) expectedAnnotations.push(...observed.annotations);
        }
        yield {
          data: frames,
          expected:
            frames.length && payloadBits <= framesPerBlock * 254 * 8 ? [{ protoId: 'flexray', kind: 'summary' }] : [],
          expectedAnnotations,
          annotationCount: count,
          payloadBits: frames.length * 254 * 8,
        };
      }
    },
  };
}
