import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface X2444mFrame {
  readonly mosi: readonly number[];
  readonly miso: readonly number[];
}

export interface X2444mCase extends RoundtripCase<X2444mFrame> {}

const channels = { clk: 3, miso: 0, mosi: 7, cs: 1 };

function spiOptions(): Record<string, string | number> {
  return { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder: 'msb-first', wordsize: 8 };
}

function commandFrame(value: number): X2444mFrame {
  return { mosi: [value], miso: [0] };
}

function writeFrame(address: number, value: number): X2444mFrame {
  return {
    mosi: [0x83 | ((address & 0x0f) << 3), (value >> 8) & 0xff, value & 0xff],
    miso: [0, 0, 0],
  };
}

function readFrame(address: number, value: number): X2444mFrame {
  return {
    mosi: [0x86 | ((address & 0x0f) << 3), 0, 0],
    miso: [0, (value >> 8) & 0xff, value & 0xff],
  };
}

function commandExpected(name: string, annotation: number): ExpectedFrame {
  return { classIndex: annotation, texts: [name, name[0]] };
}

function valueExpected(name: string, address: number, value: number, annotation: number): ExpectedFrame {
  const addressText = `0x${address.toString(16)}`;
  const valueText = `0x${value.toString(16).padStart(4, '0')}`;
  return {
    classIndex: annotation,
    texts: [`${name}: ${addressText} => ${valueText}`, `${name[0]}: ${addressText} => ${valueText}`, name[0]],
  };
}

function summary(): ExpectedFrame {
  return { protoId: 'x2444m', kind: 'summary' };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x58323434,
}: GenerationOptions = {}): Iterable<X2444mCase> {
  const data = [
    commandFrame(0x80),
    commandFrame(0x81),
    commandFrame(0x82),
    commandFrame(0x84),
    commandFrame(0x85),
    writeFrame(0, 0),
    writeFrame(15, 0xffff),
    readFrame(0, 0),
    readFrame(15, 0xabcd),
  ];
  const expectedAnnotations = [
    commandExpected('WRDS', 0),
    commandExpected('STO', 1),
    commandExpected('SLEEP', 2),
    commandExpected('WREN', 4),
    commandExpected('RCL', 5),
    valueExpected('WRITE', 0, 0, 3),
    valueExpected('WRITE', 15, 0xffff, 3),
    valueExpected('READ', 0, 0, 6),
    valueExpected('READ', 15, 0xabcd, 6),
  ];
  yield {
    name: 'commands-and-read-write-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 31n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions() }],
    chunkSamples: [1, 17, 257],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: data.length,
        payloadBits: data.reduce((sum, frame) => sum + frame.mosi.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalFrames = Math.ceil(required / 24);
  const perBlock = 4096;
  yield {
    name: 'seeded-long',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions() }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < totalFrames; offset += perBlock) {
        const count = Math.min(perBlock, totalFrames - offset);
        const data: X2444mFrame[] = [];
        const expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const address = random() & 0x0f;
          const value = random() & 0xffff;
          const read = (random() & 1) !== 0;
          const frame = read ? readFrame(address, value) : writeFrame(address, value);
          data.push(frame);
          if (index === 0 || index === count - 1) {
            expectedAnnotations.push(valueExpected(read ? 'READ' : 'WRITE', address, value, read ? 6 : 3));
          }
        }
        yield {
          data,
          expected: offset === 0 ? [summary()] : [],
          expectedAnnotations,
          annotationCount: count,
          payloadBits: count * 24,
        };
      }
    },
  };
}
