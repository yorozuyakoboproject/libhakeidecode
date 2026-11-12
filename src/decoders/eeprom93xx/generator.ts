import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface MicrowireFrame {
  readonly si: readonly number[];
  readonly so: readonly number[];
}

export interface Eeprom93xxCase extends RoundtripCase<MicrowireFrame> {}

const CHAIN = [{ decoder: 'microwire', options: {} }] as const;
const CHANNELS = { cs: 1, sk: 3, si: 4, so: 6 } as const;
const SUMMARY: ExpectedFrame = { protoId: 'eeprom93xx', kind: 'summary' };

function bits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >>> (width - index - 1)) & 1);
}

function frame(si: readonly number[], so: readonly number[] = []): MicrowireFrame {
  return {
    si: [...si],
    so: Array.from({ length: si.length }, (_, index) => so[index] ?? 0),
  };
}

function readFrame(address: number, addressSize: number, wordSize: number, value: number): MicrowireFrame {
  const si = [1, 0, ...bits(address, addressSize), ...Array.from({ length: wordSize }, () => 0)];
  const so = [...Array.from({ length: 2 + addressSize }, () => 0), ...bits(value, wordSize)];
  return frame(si, so);
}

function readAnnotation(address: number, addressSize: number): ExpectedFrame {
  const text = `0x${address.toString(16).padStart(Math.max(4, Math.ceil(addressSize / 4)), '0')}`;
  return { classIndex: 0, texts: [`Address: ${text}`, `Addr: ${text}`, text] };
}

function dataAnnotation(value: number, wordSize: number): ExpectedFrame {
  const text = `0x${value.toString(16).padStart(Math.max(4, Math.ceil(wordSize / 4)), '0')}`;
  return { classIndex: 1, texts: [`Data: ${text}`, text] };
}

function options(addresssize = 8, wordsize = 16, format = 'hex'): Record<string, string | number> {
  return { addresssize, wordsize, format };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x39335858,
}: GenerationOptions = {}): Iterable<Eeprom93xxCase> {
  yield {
    name: 'read-and-write',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_000n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const read = readFrame(0x12, 8, 16, 0xabcd);
      const write = frame([0, 1, ...bits(0x34, 8), ...bits(0x1234, 16)]);
      const expectedAnnotations = [
        { classIndex: 0, texts: ['Read word', 'READ'] },
        readAnnotation(0x12, 8),
        dataAnnotation(0xabcd, 16),
        { classIndex: 0, texts: ['Write word', 'WRITE'] },
        readAnnotation(0x34, 8),
        { classIndex: 0, texts: ['Data: 0x1234', '0x1234'] },
      ] satisfies ExpectedFrame[];
      yield {
        data: [read, write],
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: (read.si.length - 1) * 2 + (write.si.length - 1),
      };
    },
  };

  yield {
    name: 'erase-commands-and-warnings',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 17n,
    channels: CHANNELS,
    options: options(8, 16, 'ascii'),
    chunkSamples: [3, 31],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const erase = frame([1, 1, ...bits(0x5a, 8)]);
      const wen = frame([0, 0, 1, 1, ...Array.from({ length: 6 }, () => 0)]);
      const wds = frame([0, 0, 0, 0, ...Array.from({ length: 6 }, () => 0)]);
      const eral = frame([0, 0, 1, 0, ...Array.from({ length: 6 }, () => 0)]);
      const wral = frame([0, 0, 0, 1, ...Array.from({ length: 6 }, () => 0), ...bits(0x4142, 16)]);
      const short = frame([1, 0, 1]);
      const expectedAnnotations: ExpectedFrame[] = [
        { classIndex: 0, texts: ['Erase word', 'ERASE'] },
        readAnnotation(0x5a, 8),
        { classIndex: 0, texts: ['Write enable', 'WEN'] },
        { classIndex: 0, texts: ['Write disable', 'WDS'] },
        { classIndex: 0, texts: ['Erase all memory', 'Erase all', 'ERAL'] },
        { classIndex: 0, texts: ['Write all memory', 'Write all', 'WRAL'] },
        { classIndex: 0, texts: ['Data: AB', 'AB'] },
        { classIndex: 2, texts: ['Not enough packet bits'] },
      ];
      yield {
        data: [erase, wen, wds, eral, wral, short],
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits:
          erase.si.length + wen.si.length + wds.si.length + eral.si.length + wral.si.length + short.si.length,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bitsPerFrame = 2 + 8 + 16,
    frames = Math.ceil(required / bitsPerFrame),
    perBlock = 500;
  yield {
    name: 'seeded-long-read-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < frames; offset += perBlock) {
        const count = Math.min(perBlock, frames - offset);
        const data = Array.from({ length: count }, (_, index) =>
          readFrame((offset + index) & 0xff, 8, 16, random() & 0xffff),
        );
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            { classIndex: 0, texts: ['Read word', 'READ'] },
            dataAnnotation(Number(data[0]!.so.slice(10).reduce((value, bit) => (value << 1) | bit, 0)), 16),
          ],
          annotationCount: count * 3,
          payloadBits: count * bitsPerFrame,
        };
      }
    },
  };
}
