import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { SAE_INITIAL_IDLE_SAMPLES, saeFrameBits, saeTiming } from './encoder.js';

export interface SaeFrame {
  readonly speed: 1 | 4;
  readonly bytes: readonly number[];
}

export interface SaeCase extends RoundtripCase<SaeFrame> {}

const SAMPLE_RATE = 250_000;
const OPTIONS = {} as const;

function annotationCount(frame: SaeFrame): number {
  const count = frame.bytes.length;
  return 9 * count + 7 + (count > 5 ? 1 : 0) + (frame.bytes[3] === 1 ? 1 : 0);
}

function frameObservations(frame: SaeFrame, start: bigint) {
  const timing = saeTiming(SAMPLE_RATE, frame.speed);
  const bits = saeFrameBits(frame);
  const annotations: ExpectedFrame[] = [
    {
      classIndex: 0,
      texts: [`${frame.speed}x SOF`, `S${frame.speed}`, 'S'],
      ss: start,
      es: start + BigInt(timing.sof),
    },
  ];
  let cursor = start + BigInt(timing.sof);
  let level = 0;
  for (let index = 0; index < 8; index++) {
    const value = bits[index]!;
    if (index === 0)
      annotations.push({
        classIndex: 1,
        texts: [String(value)],
        ss: cursor,
        es: cursor + BigInt(value === level ? timing.short : timing.long),
      });
    cursor += BigInt(value === level ? timing.short : timing.long);
    level ^= 1;
  }
  annotations.push({
    classIndex: 3,
    texts: [frame.bytes[0]!.toString(16).padStart(2, '0')],
    ss: start + BigInt(timing.sof),
    es: cursor,
  });
  for (let index = 8; index < bits.length; index++) {
    const value = bits[index]!;
    cursor += BigInt(value === level ? timing.short : timing.long);
    level ^= 1;
  }
  annotations.push({
    classIndex: 2,
    texts: ['EOF', 'E'],
    ss: cursor,
    es: cursor + BigInt(timing.ifs),
  });
  return {
    annotations,
    count: annotationCount(frame),
    end: cursor + BigInt(timing.idleTail),
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x31383530,
}: GenerationOptions = {}): Iterable<SaeCase> {
  const boundaryFrames: readonly SaeFrame[] = [
    { speed: 1, bytes: [0x00, 0x00, 0x00, 0x00, 0xff] },
    {
      speed: 4,
      bytes: [0xff, 0x00, 0xff, 0x00, ...Array.from({ length: 254 }, (_, index) => (index * 73 + 0x55) & 0xff), 0x00],
    },
    { speed: 4, bytes: [0x68, 0x6a, 0xf1, 0x01, 0x10, 0x00] },
    { speed: 1, bytes: [0x68, 0x6a, 0xf1, 0x01, 0x00] },
  ];
  const boundaryStart = 9_007_199_254_740_990n;
  let cursor = boundaryStart + BigInt(SAE_INITIAL_IDLE_SAMPLES);
  const boundaryAnnotations: ExpectedFrame[] = [];
  let boundaryCount = 0;
  let boundaryBits = 0;
  for (const frame of boundaryFrames) {
    const observed = frameObservations(frame, cursor);
    boundaryAnnotations.push(...observed.annotations);
    boundaryCount += observed.count;
    boundaryBits += frame.bytes.length * 8;
    cursor = observed.end;
  }
  yield {
    name: 'speed-byte-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    channels: { data: 3 },
    options: { ...OPTIONS },
    startSample: boundaryStart,
    chunkSamples: [1, 3, 31, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: [...boundaryFrames],
        expected: [{ protoId: 'sae_j1850_vpw', kind: 'summary' }],
        expectedAnnotations: boundaryAnnotations,
        annotationCount: boundaryCount,
        payloadBits: boundaryBits,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const framesPerBlock = 64;
  const dataBytes = 1024;
  yield {
    name: 'seeded-4x-frames',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    channels: { data: 3 },
    options: { ...OPTIONS },
    startSample: 0n,
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let captured = BigInt(SAE_INITIAL_IDLE_SAMPLES);
      let payloadBits = 0;
      while (payloadBits < required) {
        const frames: SaeFrame[] = [];
        const expectedAnnotations: ExpectedFrame[] = [];
        let count = 0;
        for (let index = 0; index < framesPerBlock; index++) {
          const bytes = Array.from({ length: dataBytes + 5 }, () => random() & 0xff);
          bytes[3] = random() & 0xfe;
          const frame: SaeFrame = { speed: 4, bytes };
          const observed = frameObservations(frame, captured);
          captured = observed.end;
          payloadBits += bytes.length * 8;
          frames.push(frame);
          count += observed.count;
          if (index === 0) expectedAnnotations.push(...observed.annotations);
        }
        yield {
          data: frames,
          expected:
            payloadBits <= framesPerBlock * (dataBytes + 5) * 8 ? [{ protoId: 'sae_j1850_vpw', kind: 'summary' }] : [],
          expectedAnnotations,
          annotationCount: count,
          payloadBits: frames.length * (dataBytes + 5) * 8,
        };
      }
    },
  };
}
