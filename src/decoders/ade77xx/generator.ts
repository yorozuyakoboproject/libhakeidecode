import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Ade77xxFrame {
  readonly mosi: readonly number[];
  readonly miso: readonly number[];
}

export interface Ade77xxCase extends RoundtripCase<Ade77xxFrame> {}

const channels = { clk: 3, miso: 0, mosi: 7, cs: 1 },
  REGISTERS: Readonly<Record<number, readonly [string, number]>> = {
    0x01: ['AWATTHR', 16],
    0x0a: ['AIRMS', 24],
    0x0b: ['BIRMS', 24],
    0x0c: ['CIRMS', 24],
    0x12: ['WFORM', 24],
    0x13: ['OPMODE', 8],
    0x24: ['AVRMSGAIN', 12],
    0x7e: ['CHKSUM', 8],
    0x7f: ['Version', 8],
  };

function zeros(length: number): number[] {
  return Array.from({ length }, () => 0);
}

function transaction(command: number, payload: readonly number[], read: boolean): Ade77xxFrame {
  const data = [...payload],
    mosi = [command, ...(read ? zeros(data.length) : data)],
    miso = [0, ...(read ? data : zeros(data.length))];
  return { mosi, miso };
}

function annotation(write: boolean, text: string): ExpectedFrame {
  return { classIndex: write ? 1 : 0, texts: [text] };
}

function warning(text: string): ExpectedFrame {
  return { classIndex: 2, texts: [text] };
}

function summary(): ExpectedFrame {
  return { protoId: 'ade77xx', kind: 'summary' };
}

function spiOptions(wordsize: number, bitorder = 'msb-first') {
  return { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder, wordsize };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0xade77,
}: GenerationOptions = {}): Iterable<Ade77xxCase> {
  yield {
    name: 'read-write-widths',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 23n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = [
          transaction(0xa4, [0x12, 0x34], false),
          transaction(0x24, [0x0a, 0xbc], true),
          transaction(0x8a, [0x12, 0x34, 0x56], false),
          transaction(0x01, [0xff, 0x00], true),
          transaction(0x93, [0x5a], false),
          transaction(0x7e, [0x33], true),
        ],
        expectedAnnotations = [
          annotation(true, 'AVRMSGAIN: 0x1234'),
          annotation(false, 'AVRMSGAIN: 0xabc'),
          annotation(true, 'AIRMS: 0x123456'),
          annotation(false, 'AWATTHR: 0xff00'),
          annotation(true, 'OPMODE: 0x5a'),
          annotation(false, 'CHKSUM: 0x33'),
        ];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 32,
      };
    },
  };

  yield {
    name: 'short-and-unknown',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 29n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [2, 31, 1021],
    minimumPayloadBits: 0,
    *generate() {
      const data: Ade77xxFrame[] = [
          { mosi: [0x8a, 0x12], miso: [0x00, 0x00] },
          { mosi: [0x7d, 0x00], miso: [0x00, 0x55] },
          transaction(0x7f, [0x42], true),
        ],
        expectedAnnotations = [
          annotation(true, 'AIRMS: SHORT'),
          warning('Short transfer!'),
          warning('Unknown register!'),
          annotation(false, 'Version: 0x42'),
        ];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: 16 + 16 + 16,
      };
    },
  };

  yield {
    name: 'multi-byte-word',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(32) }],
    chunkSamples: [4093, 8191],
    minimumPayloadBits: 0,
    *generate() {
      const data = [
          transaction(0x8a, [0x12, 0x34, 0x56], false),
          { mosi: [0x12, 0x00, 0x00, 0x00], miso: [0xff, 0xab, 0xcd, 0xef] },
        ],
        expectedAnnotations = [annotation(true, 'AIRMS: 0x123456'), annotation(false, 'WFORM: 0xabcdef')];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 32,
      };
    },
  };

  yield {
    name: 'lsb-first-byte-words',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 31n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8, 'lsb-first') }],
    chunkSamples: [3, 17, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data = [transaction(0xa4, [0x0a, 0xbc], false), transaction(0x24, [0x12, 0x34], true)],
        expectedAnnotations = [annotation(true, 'AVRMSGAIN: 0xabc'), annotation(false, 'AVRMSGAIN: 0x1234')];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 24,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    totalFrames = Math.ceil(required / 32),
    framesPerBlock = 4096,
    blocks = Math.ceil(totalFrames / framesPerBlock),
    longRegisters = [0x0a, 0x0b, 0x0c, 0x12];
  yield {
    name: 'seeded-long',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(framesPerBlock, totalFrames - block * framesPerBlock),
          data: Ade77xxFrame[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const register = longRegisters[random() % longRegisters.length]!,
            read = (random() & 1) === 1,
            payload = [Math.floor(random() / 65536) & 0xff, Math.floor(random() / 256) & 0xff, random() & 0xff],
            frame = transaction((read ? 0 : 0x80) | register, payload, read),
            text = `${REGISTERS[register]![0]}: 0x${payload.reduce((value, byte) => value * 256 + byte, 0).toString(16)}`;
          data.push(frame);
          if (index === 0 || index === count - 1) expectedAnnotations.push(annotation(!read, text));
        }
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations,
          annotationCount: data.length,
          payloadBits: data.length * 32,
        };
      }
    },
  };
}
