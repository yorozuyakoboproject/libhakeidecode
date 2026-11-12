import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Ps2Frame {
  readonly value: number;
  readonly parity?: 0 | 1;
  readonly leadingOnes?: number;
}

export interface Ps2Case extends RoundtripCase<Ps2Frame> {
  readonly initialHalves: number;
}

interface Ps2Interval {
  readonly ss: bigint;
  readonly es: bigint;
}

function oddParity(value: number): 0 | 1 {
  let ones = 0;
  for (let index = 0; index < 8; index++) ones ^= (value >>> index) & 1;
  return ones === 1 ? 0 : 1;
}

function expectedFrame(frame: Ps2Frame, start: bigint): { annotations: ExpectedFrame[]; next: bigint } {
  const positions: bigint[] = [];
  let falling = start;
  for (let index = 0; index < 11; index++) {
    positions.push(falling);
    falling += 2n;
  }
  const intervals: Ps2Interval[] = positions.map((ss, index) => ({
    ss,
    es: index === 10 ? ss + 2n : positions[index + 1]!,
  }));
  const dataBits = Array.from({ length: 8 }, (_, index) => (frame.value >>> index) & 1);
  const parity = frame.parity ?? oddParity(frame.value);
  const values = [0, ...dataBits, parity, 1];
  const annotations: ExpectedFrame[] = values.map((value, index) => ({
    ss: intervals[index]!.ss,
    es: intervals[index]!.es,
    classIndex: 0,
    texts: [String(value)],
  }));
  annotations.push(
    { ...intervals[0]!, classIndex: 1, texts: ['Start bit', 'Start', 'S'] },
    {
      ss: intervals[1]!.ss,
      es: intervals[8]!.es,
      classIndex: 6,
      texts: [
        `Data: ${frame.value.toString(16).padStart(2, '0')}`,
        `D: ${frame.value.toString(16).padStart(2, '0')}`,
        frame.value.toString(16).padStart(2, '0'),
      ],
    },
    {
      ...intervals[9]!,
      classIndex: (dataBits.reduce((sum, bit) => sum + bit, 0) + parity) % 2 === 1 ? 3 : 4,
      texts:
        (dataBits.reduce((sum, bit) => sum + bit, 0) + parity) % 2 === 1
          ? ['Parity OK', 'Par OK', 'P']
          : ['Parity error', 'Par err', 'PE'],
    },
    { ...intervals[10]!, classIndex: 2, texts: ['Stop bit', 'Stop', 'St', 'T'] },
  );
  return { annotations, next: start + 22n };
}

function summary(): ExpectedFrame {
  return { protoId: 'ps2', kind: 'summary' };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x505332,
}: GenerationOptions = {}): Iterable<Ps2Case> {
  const boundary = [
    { name: 'odd-parity-boundaries', start: 7n, frames: [0x00, 0xff, 0x55, 0xaa, 0x81] },
    {
      name: 'parity-error-and-leading-ones',
      start: 31n,
      frames: [{ value: 0x42, parity: 0 as const, leadingOnes: 3 }],
    },
    {
      name: 'large-sample-numbers',
      start: 9_007_199_254_740_990n,
      frames: [{ value: 0x01, leadingOnes: 1 }, { value: 0x80 }],
    },
  ];
  for (const item of boundary) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: 2_000_000,
      startSample: item.start,
      channels: { clk: 2, data: 5 },
      options: {},
      chunkSamples: [1, 17, 257, 4093],
      minimumPayloadBits: 0,
      initialHalves: 2,
      *generate() {
        const data = item.frames.map((frame) => (typeof frame === 'number' ? { value: frame } : frame));
        const annotations: ExpectedFrame[] = [];
        let sample = this.startSample + 2n;
        for (const frame of data) {
          sample += BigInt((frame.leadingOnes ?? 0) * 2);
          const result = expectedFrame(frame, sample);
          annotations.push(...result.annotations);
          sample = result.next;
        }
        yield {
          data,
          expected: [summary()],
          expectedAnnotations: annotations,
          annotationCount: annotations.length,
          payloadBits: data.length * 11,
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const total = Math.ceil(required / 11);
  const perBlock = 2048;
  const blocks = Math.ceil(total / perBlock);
  yield {
    name: 'seeded-long-odd-parity',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { clk: 0, data: 3 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    initialHalves: 2,
    *generate() {
      const random = randomWords(seed);
      let sample = this.startSample + 2n;
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(perBlock, total - block * perBlock);
        const data: Ps2Frame[] = [];
        const annotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const value = random() & 0xff;
          const frame: Ps2Frame = {
            value,
            ...(index % 17 === 0 ? { parity: (oddParity(value) ^ 1) as 0 | 1 } : {}),
          };
          data.push(frame);
          const result = expectedFrame(frame, sample);
          if (index === 0 || index === count - 1) annotations.push(...result.annotations);
          sample = result.next;
        }
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: annotations,
          annotationCount: count * 15,
          payloadBits: count * 11,
        };
      }
    },
  };
}
