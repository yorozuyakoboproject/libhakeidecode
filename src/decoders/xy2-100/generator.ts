import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface XyFrame {
  readonly bits: readonly number[];
  readonly status?: readonly number[];
}

export interface XyCase extends RoundtripCase<XyFrame> {
  readonly initialSamples: number;
  readonly statusChannel?: number;
}

const TYPE_16 = ['16 bit Position Frame', '16 bit Pos', 'Pos', 'P'];
const TYPE_18 = ['18 bit Position Frame', '18 bit Pos', 'Pos', 'P'];
const TYPE_COMMAND = ['Command Frame', 'Command', 'C'];
const AMBIGUOUS = [
  'Careful: 18-bit position frames with wrong parity and command frames with wrong parity cannot be identified',
];

function parityEven(bits: readonly number[]): 0 | 1 {
  return bits.reduce((value, bit) => value ^ bit, 0) as 0 | 1;
}

function frame16(value: number): XyFrame {
  const bits = [0, 0, 1];
  for (let shift = 15; shift >= 0; shift--) bits.push((value >>> shift) & 1);
  bits.push(parityEven(bits));
  return { bits };
}

function frame18(raw: number): XyFrame {
  const bits = [1, 0, 1];
  for (let shift = 17; shift >= 2; shift--) bits.push((raw >>> shift) & 1);
  bits.push(parityEven(bits) ^ 1);
  return { bits };
}

function commandFrame(command: number, parameter: number): XyFrame {
  const bits = [0, 1, 1];
  for (let shift = 7; shift >= 0; shift--) bits.push((command >>> shift) & 1);
  for (let shift = 7; shift >= 0; shift--) bits.push((parameter >>> shift) & 1);
  bits.push(parityEven(bits));
  return { bits };
}

function invalidFrame(): XyFrame {
  return { bits: Array<number>(20).fill(0) };
}

function hex(value: number): string {
  return value.toString(16).toUpperCase();
}

function frameAnnotations(frame: XyFrame, rising0: bigint): ExpectedFrame[] {
  const bits = frame.bits;
  if (!Array.isArray(bits) || bits.length !== 20 || bits.some((bit) => bit !== 0 && bit !== 1))
    throw new Error('XY2-100 frame must contain twenty binary bits');
  const rising = (index: number): bigint => rising0 + BigInt(index * 2);
  const falling = (index: number): bigint => rising0 + BigInt(index * 2 + 1);
  const annotations: ExpectedFrame[] = [];
  const status = frame.status;

  for (let index = 1; index <= 19; index++) {
    annotations.push({
      ss: rising(index - 1),
      es: rising(index),
      classIndex: 0,
      texts: [String(bits[index - 1])],
    });
    if (status && index >= 2)
      annotations.push({
        ss: falling(index - 1),
        es: falling(index),
        classIndex: 1,
        texts: [String(status[index - 2])],
      });
  }

  annotations.push({
    ss: rising(19),
    es: rising(20),
    classIndex: 0,
    texts: [String(bits[19])],
  });

  const even = bits[19] === parityEven(bits.slice(0, 19));
  const type1 = bits[0];
  const type3 = (bits[0]! << 2) | (bits[1]! << 1) | bits[2]!;
  const firstSs = rising(0);
  const firstEs = rising(1);
  let typeEs = rising(3);
  const paritySs = rising(19);
  const parityEs = rising(20);
  let typeTexts: readonly string[] | null = null;
  let position: number | null = null;
  let command: number | null = null;
  let parameter: number | null = null;

  if (type1 === 1 && !even) {
    annotations.push({ ss: firstSs, es: rising(20), classIndex: 8, texts: AMBIGUOUS });
    typeEs = firstEs;
    typeTexts = TYPE_18;
    let value = 0;
    for (let index = 0; index < 16; index++) value |= bits[index + 3]! << (17 - index);
    position = value >= 131072 ? value - 262144 : value;
  } else if (type3 === 1) {
    typeTexts = TYPE_16;
    if (!even) annotations.push({ ss: firstSs, es: rising(20), classIndex: 8, texts: ['Parity error', 'PE'] });
    let value = 0;
    for (let index = 0; index < 16; index++) value |= bits[index + 3]! << (15 - index);
    position = value >= 32768 ? value - 65536 : value;
  } else if (type3 === 7 && even) {
    annotations.push({ ss: firstSs, es: rising(20), classIndex: 8, texts: AMBIGUOUS });
    typeTexts = TYPE_COMMAND;
    command = 0;
    parameter = 0;
    for (let index = 0; index < 8; index++) command |= bits[index + 3]! << (7 - index);
    for (let index = 0; index < 8; index++) parameter |= bits[index + 11]! << (7 - index);
  } else {
    annotations.push({
      ss: firstSs,
      es: rising(20),
      classIndex: 8,
      texts: ['Error', 'Unknown command or parity error'],
    });
    return annotations;
  }

  annotations.push({ ss: firstSs, es: typeEs, classIndex: 2, texts: typeTexts });
  annotations.push({
    ss: paritySs,
    es: parityEs,
    classIndex: 5,
    texts: typeTexts === TYPE_18 ? ['X', 'Unknown'] : even ? ['OK'] : ['NOK'],
  });
  if (position !== null) annotations.push({ ss: typeEs, es: paritySs, classIndex: 6, texts: [String(position)] });
  else if (command !== null && parameter !== null) {
    const commandEs = rising(11);
    annotations.push({
      ss: typeEs,
      es: commandEs,
      classIndex: 3,
      texts: [`Command 0x${hex(command)}`, `Cmd 0x${hex(command)}`, `0x${hex(command)}`],
    });
    annotations.push({
      ss: commandEs,
      es: paritySs,
      classIndex: 4,
      texts: [
        `Parameter 0x${hex(parameter)} / ${parameter}`,
        `0x${hex(parameter)} / ${parameter}`,
        `0x${hex(parameter)}`,
      ],
    });
  }

  if (status) {
    annotations.push({
      ss: falling(19),
      es: falling(20),
      classIndex: 1,
      texts: [String(status[18])],
    });
    let value = 0;
    for (let index = 0; index < 19; index++) value |= status[index]! << (18 - index);
    annotations.push({
      ss: falling(1),
      es: falling(20),
      classIndex: 7,
      texts: [`Status 0x${hex(value)}`, `0x${hex(value)}`],
    });
  }
  return annotations;
}

function summary(): ExpectedFrame {
  return { protoId: 'xy2-100', kind: 'summary' };
}

function frameGapAnnotations(rising0: bigint): ExpectedFrame[] {
  const ss = rising0 + 40n;
  const es = rising0 + 42n;
  return [
    { ss, es, classIndex: 0, texts: ['0'] },
    { ss, es, classIndex: 8, texts: ['Not enough data bits'] },
  ];
}

function makeCase(name: string, frames: readonly XyFrame[], start: bigint, status = false): XyCase {
  return {
    name,
    kind: 'boundary',
    seed: 0x58593231,
    sampleRate: 2_000_000,
    startSample: start,
    channels: { clk: 0, sync: 1, data: 2, ...(status ? { status: 3 } : {}) },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    initialSamples: 2,
    statusChannel: status ? 3 : undefined,
    *generate() {
      const annotations: ExpectedFrame[] = [];
      let rising = this.startSample + BigInt(this.initialSamples);
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index]!;
        annotations.push(...frameAnnotations(frame, rising));
        if (index + 1 < frames.length) annotations.push(...frameGapAnnotations(rising));
        rising += 42n;
      }
      yield {
        data: frames,
        expected: [summary()],
        expectedAnnotations: annotations,
        annotationCount: annotations.length,
        payloadBits: frames.length * 20,
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x58593231,
}: GenerationOptions = {}): Iterable<XyCase> {
  yield makeCase(
    'sixteen-bit-positions',
    [frame16(0), frame16(1), frame16(0x7fff), frame16(0x8000), frame16(0xffff)],
    7n,
  );
  yield makeCase('eighteen-bit-positions', [frame18(0), frame18(4), frame18(0x1fffc), frame18(0x3fffc)], 19n);
  yield makeCase('commands-and-parity-error', [commandFrame(0x12, 0x34), commandFrame(0xff, 0x80)], 23n);
  yield makeCase('unknown-frame', [invalidFrame(), frame16(0x1234)], 9_007_199_254_740_990n);
  const status: XyFrame = {
    ...frame16(0x2345),
    status: Array.from({ length: 19 }, (_, index) => (index * 7 + 3) & 1),
  };
  yield makeCase('status-channel', [status], 31n, true);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const total = Math.ceil(required / 20);
  const perBlock = 1024;
  const blocks = Math.ceil(total / perBlock);
  yield {
    name: 'seeded-long-positions',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { clk: 0, sync: 1, data: 2 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    initialSamples: 2,
    *generate() {
      const random = randomWords(seed);
      let rising = this.startSample + BigInt(this.initialSamples);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(perBlock, total - block * perBlock);
        const data: XyFrame[] = [];
        const annotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const frame = frame16(random() & 0xffff);
          data.push(frame);
          if (index === 0 || index === count - 1) annotations.push(...frameAnnotations(frame, rising));
          rising += 42n;
        }
        const gapCount = count - (block === blocks - 1 ? 1 : 0);
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: annotations,
          annotationCount: count * 23 + 2 * gapCount,
          payloadBits: count * 20,
        };
      }
    },
  };
}
