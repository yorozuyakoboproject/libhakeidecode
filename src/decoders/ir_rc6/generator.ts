import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { rc6FrameBits, rc6HalfBit, type Rc6Frame } from './index.js';

export interface Rc6Case extends RoundtripCase<Rc6Frame> {}

export const RC6_LEAD_HALF_BITS = 8;
export const RC6_GAP_HALF_BITS = 8;

export interface Rc6Run {
  readonly level: 0 | 1;
  readonly halfBits: number;
}

export function rc6FrameRuns(frame: Rc6Frame): Rc6Run[] {
  const runs: Rc6Run[] = [
    { level: 0, halfBits: 6 },
    { level: 1, halfBits: 2 },
  ];
  for (const bit of rc6FrameBits(frame)) {
    if (bit) runs.push({ level: 0, halfBits: 1 }, { level: 1, halfBits: 1 });
    else runs.push({ level: 1, halfBits: 1 }, { level: 0, halfBits: 1 });
  }
  return runs;
}

export function rc6PayloadBits(frame: Rc6Frame): number {
  return rc6FrameBits(frame).length;
}

export function rc6FrameAnnotations(frame: Rc6Frame, frameStart: bigint, halfbit: number): ExpectedFrame[] {
  const mode = frame.mode;
  const addressBits = mode === 0 || frame.shortAddress !== false ? 8 : 16;
  const dataBits = mode === 0 ? 8 : 1;
  const half = BigInt(halfbit);
  const syncEnd = frameStart + 8n * half;
  const startEnd = syncEnd + 2n * half;
  const fieldEnd = startEnd + 6n * half;
  const toggleEnd = fieldEnd + 2n * half;
  const addressEnd = toggleEnd + BigInt(addressBits * 2) * half;
  const dataEnd = addressEnd + BigInt(dataBits * 2) * half;
  const addressText = `Address: ${frame.address.toString(16).toUpperCase().padStart(2, '0')}`;
  const dataText = `Data: ${frame.data
    .toString(16)
    .toUpperCase()
    .padStart(mode === 0 ? 2 : 0, '0')}`;
  return [
    {
      classIndex: 1,
      texts: ['Synchronisation', 'Sync'],
      ss: frameStart,
      es: syncEnd,
    },
    {
      classIndex: 2,
      texts: ['Startbit', 'Start'],
      ss: syncEnd,
      es: startEnd,
    },
    {
      classIndex: 3,
      texts: [`Field: ${mode}`],
      ss: startEnd,
      es: fieldEnd,
    },
    {
      classIndex: 4,
      texts: [`Toggle: ${frame.toggle}`],
      ss: fieldEnd,
      es: toggleEnd,
    },
    {
      classIndex: 5,
      texts: [addressText],
      ss: toggleEnd,
      es: addressEnd,
    },
    {
      classIndex: 6,
      texts: [dataText],
      ss: addressEnd,
      es: dataEnd,
    },
  ];
}

export function rc6AnnotationCount(frames: readonly Rc6Frame[], halfbit: number): number {
  const edges: number[] = [];
  let time = 0;
  let level = 1;
  const add = (next: 0 | 1, halfBits: number): void => {
    if (next !== level) edges.push(time);
    level = next;
    time += halfBits * halfbit;
  };

  add(1, RC6_LEAD_HALF_BITS);
  for (const frame of frames) {
    for (const run of rc6FrameRuns(frame)) add(run.level, run.halfBits);
    add(1, RC6_GAP_HALF_BITS);
  }
  add(0, 1);
  add(1, 1);

  const packetLengths = frames.map((frame) => rc6FrameBits(frame).length + 1);
  let packetIndex = 0;
  let packetLength = packetLengths[0] ?? 22;
  let raw = 0;
  let fieldBlocks = 0;
  let packageFields = 0;
  let bitCount = 0;
  let numEdges = -1;
  const outerEdges: number[] = [];
  const deltas: number[] = [];
  let state = 'IDLE';
  let cursor = 0;
  let lastEvent: number | null = null;

  while (cursor < edges.length) {
    const actual = edges[cursor]!;
    const timeoutAt: number = lastEvent === null ? Infinity : lastEvent + halfbit * 6;
    const timedOut: boolean = state === 'DATA' && timeoutAt <= actual;
    const sample: number = timedOut ? timeoutAt : actual;
    if (!timedOut || timeoutAt === actual) cursor++;
    if (timedOut) state = 'IDLE';
    lastEvent = sample;

    outerEdges.push(sample);
    if (outerEdges.length < 2) continue;
    const delta = Math.trunc((sample - outerEdges.at(-2)!) / halfbit + 0.5);
    deltas.push(delta);
    if (deltas.length < 2) continue;

    if (deltas.at(-2) === 6 && deltas.at(-1) === 2) {
      state = 'SYNC';
      numEdges = 0;
      bitCount = 1;
      raw++;
      packetLength = packetLengths[packetIndex++] ?? packetLength;
    }

    if (numEdges % 2 === 0) {
      const firstDelta = deltas.at(-2)!;
      const secondDelta = deltas.at(-1)!;
      if ([1, 2, 3].includes(firstDelta) && [1, 2, 3, 6].includes(secondDelta)) {
        state = 'DATA';
        if (firstDelta !== secondDelta) {
          outerEdges.splice(outerEdges.length - 1, 0, sample - secondDelta * halfbit);
          deltas[deltas.length - 1] = firstDelta;
          deltas.push(secondDelta - firstDelta);
          numEdges++;
        }
        raw++;
        bitCount++;
      }
    }

    if (bitCount > 0) {
      if (bitCount === 6) fieldBlocks++;
      if (state === 'IDLE' && bitCount === packetLength) {
        packageFields += 2;
        bitCount = 0;
      }
    }
    numEdges++;
  }
  return raw + fieldBlocks * 4 + packageFields;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x524336,
}: GenerationOptions = {}): Iterable<Rc6Case> {
  const boundaries = [
    {
      name: 'mode0-auto-boundaries',
      polarity: 'auto' as const,
      sampleRate: 100_000,
      startSample: 3n,
      frames: [
        { mode: 0 as const, address: 0, data: 0, toggle: 0 as const },
        { mode: 0 as const, address: 255, data: 254, toggle: 1 as const },
      ],
    },
    {
      name: 'mode0-active-high',
      polarity: 'active-high' as const,
      sampleRate: 100_000,
      startSample: 9_007_199_254_740_990n,
      frames: [
        { mode: 0 as const, address: 0x5a, data: 0xa4, toggle: 1 as const },
        { mode: 0 as const, address: 0x01, data: 0x80, toggle: 0 as const },
      ],
    },
    {
      name: 'mode6-short-address',
      polarity: 'active-low' as const,
      sampleRate: 100_000,
      startSample: 11n,
      frames: [
        { mode: 6 as const, address: 0, data: 0, toggle: 0 as const, shortAddress: true },
        { mode: 6 as const, address: 127, data: 0, toggle: 1 as const, shortAddress: true },
      ],
    },
    {
      name: 'mode6-long-address',
      polarity: 'active-high' as const,
      sampleRate: 100_000,
      startSample: 29n,
      frames: [
        { mode: 6 as const, address: 0x8000, data: 0, toggle: 0 as const, shortAddress: false },
        { mode: 6 as const, address: 0xffff, data: 0, toggle: 1 as const, shortAddress: false },
      ],
    },
  ];

  for (const item of boundaries) {
    const halfbit = rc6HalfBit(item.sampleRate);
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: item.sampleRate,
      startSample: item.startSample,
      channels: { ir: 5 },
      options: { polarity: item.polarity },
      chunkSamples: [5, 31, 257, 4093],
      minimumPayloadBits: 0,
      *generate() {
        let cursor = item.startSample + BigInt(RC6_LEAD_HALF_BITS * halfbit);
        const expectedAnnotations: ExpectedFrame[] = [];
        for (const frame of item.frames) {
          expectedAnnotations.push(...rc6FrameAnnotations(frame, cursor, halfbit));
          cursor += BigInt(rc6FrameBits(frame).length * 2 + 8 + RC6_GAP_HALF_BITS) * BigInt(halfbit);
        }
        yield {
          data: item.frames,
          expected: [{ protoId: 'ir_rc6', kind: 'summary' }],
          expectedAnnotations,
          annotationCount: rc6AnnotationCount(item.frames, halfbit),
          payloadBits: item.frames.reduce((sum, frame) => sum + rc6PayloadBits(frame), 0),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const sampleRate = 10_000;
  const halfbit = rc6HalfBit(sampleRate);
  const perBlock = 2048;
  const payloadPerFrame = 21;
  const frameCount = Math.ceil(required / payloadPerFrame);
  yield {
    name: 'seeded-long-mode0',
    kind: 'long',
    seed,
    sampleRate,
    startSample: 0n,
    channels: { ir: 0 },
    options: { polarity: 'auto' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let cursor = BigInt(RC6_LEAD_HALF_BITS * halfbit);
      for (let offset = 0; offset < frameCount; offset += perBlock) {
        const count = Math.min(perBlock, frameCount - offset);
        const data: Rc6Frame[] = [];
        let firstLayout: ExpectedFrame[] | null = null;
        let lastLayout: ExpectedFrame[] | null = null;
        for (let index = 0; index < count; index++) {
          const word = random();
          const frame: Rc6Frame = {
            mode: 0,
            address: word & 0xff,
            data: (word >>> 8) & 0xff & 0xfe,
            toggle: ((word >>> 16) & 1) as 0 | 1,
          };
          data.push(frame);
          const layout = rc6FrameAnnotations(frame, cursor, halfbit);
          firstLayout ??= layout;
          lastLayout = layout;
          cursor += BigInt(rc6FrameBits(frame).length * 2 + 8 + RC6_GAP_HALF_BITS) * BigInt(halfbit);
        }
        yield {
          data,
          expected: offset === 0 ? [{ protoId: 'ir_rc6', kind: 'summary' }] : [],
          expectedAnnotations: [...firstLayout!, ...lastLayout!],
          annotationCount: rc6AnnotationCount(data, halfbit),
          payloadBits: count * payloadPerFrame,
        };
      }
    },
  };
}
