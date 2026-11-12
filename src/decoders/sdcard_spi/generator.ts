import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { commandName } from './commands.js';

export interface SPIByte {
  readonly mosi?: number;
  readonly miso?: number;
}

export interface SdSpiFrame {
  readonly words: readonly SPIByte[];
}

export interface SdSpiCase extends RoundtripCase<SdSpiFrame> {}

const CHAIN = [
  {
    decoder: 'spi',
    options: {
      cs_polarity: 'active-low',
      cpol: 0,
      cpha: 0,
      bitorder: 'msb-first',
      wordsize: 8,
    },
  },
] as const;
const CHANNELS = { clk: 3, miso: 0, mosi: 7, cs: 1 } as const;
const SUMMARY: ExpectedFrame = { protoId: 'sdcard_spi', kind: 'summary' };

function word(mosi?: number, miso?: number): SPIByte {
  return { ...(mosi === undefined ? {} : { mosi }), ...(miso === undefined ? {} : { miso }) };
}

function commandWords(index: number, arg = 0, application = false): SPIByte[] {
  return [
    word(0x40 | ((application ? 0 : 0) + index)),
    word((arg >>> 24) & 0xff),
    word((arg >>> 16) & 0xff),
    word((arg >>> 8) & 0xff),
    word(arg & 0xff),
    word(0x01),
  ];
}

function commandPrefix(index: number, application: boolean): string {
  return `${application ? 'ACMD' : 'CMD'}${index}`;
}

function commandFields(index: number, arg: number, application = false): ExpectedFrame[] {
  const prefix = commandPrefix(index, application),
    name = commandName(index, application);
  return [
    { classIndex: 133, texts: ['Start bit: 0'] },
    { classIndex: 133, texts: ['Transmitter bit: 1'] },
    { classIndex: 133, texts: [`Command: ${prefix} (${name})`] },
    { classIndex: 133, texts: [`Argument: 0x${arg.toString(16).padStart(4, '0')}`] },
    { classIndex: 133, texts: ['CRC7: 0x0'] },
    { classIndex: 133, texts: ['End bit: 1'] },
  ];
}

function commandAnnotation(index: number, description: string, application = false): ExpectedFrame {
  return {
    classIndex: application ? 64 + index : index,
    texts: [`${commandPrefix(index, application)} (${commandName(index, application)}): ${description}`],
  };
}

function r1Annotation(value: number): ExpectedFrame {
  return { classIndex: 128, texts: [`R1: 0x${value.toString(16).padStart(2, '0')}`] };
}

function r1Word(value = 0): SPIByte {
  return word(0xff, value);
}

function commandResponse(index: number, arg: number, response = 0, application = false): SdSpiFrame {
  return {
    words: [...commandWords(index, arg, application), word(0xff, 0xff), r1Word(response)],
  };
}

function readBlockFrame(index: number, address: number, data: readonly number[]): SdSpiFrame {
  return {
    words: [
      ...commandWords(index, address),
      word(0xff, 0xff),
      r1Word(),
      word(0xff, 0xfe),
      ...data.map((value) => word(0xff, value)),
      word(0xff, 0xff),
      word(0xff, 0xff),
    ],
  };
}

function writeBlockFrame(index: number, address: number, data: readonly number[]): SdSpiFrame {
  return {
    words: [
      ...commandWords(index, address),
      word(0xff, 0xff),
      r1Word(),
      word(0xfe, 0xff),
      ...data.map((value) => word(value)),
      word(0xff, 0x05),
      word(0xff, 0x00),
      word(0xff, 0xff),
    ],
  };
}

function options(): Record<string, string> {
  return {};
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53445350,
}: GenerationOptions = {}): Iterable<SdSpiCase> {
  yield {
    name: 'command-and-r1-cycles',
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
      const data = [
        commandResponse(0, 0, 1),
        commandResponse(16, 4, 0),
        commandResponse(55, 0, 0),
        commandResponse(41, 0x40000000, 0, true),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        ...commandFields(0, 0),
        commandAnnotation(0, 'Reset the SD card'),
        r1Annotation(1),
        ...commandFields(16, 4),
        commandAnnotation(16, 'Set the block length to 4 bytes'),
        r1Annotation(0),
        ...commandFields(55, 0),
        commandAnnotation(55, 'Next command is an application-specific command'),
        r1Annotation(0),
        ...commandFields(41, 0x40000000, true),
        commandAnnotation(41, 'Send HCS info and activate the card init process', true),
        r1Annotation(0),
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 64,
        payloadBits: data.reduce((sum, item) => sum + item.words.length * 8, 0),
      };
    },
  };

  yield {
    name: 'single-block-read-and-write',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 17n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [3, 31, 2047],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [
        commandResponse(16, 4, 0),
        readBlockFrame(17, 0, [0x11, 0x22, 0x33, 0x44]),
        writeBlockFrame(24, 0, [0xaa, 0xbb, 0xcc, 0xdd]),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        ...commandFields(16, 4),
        commandAnnotation(16, 'Set the block length to 4 bytes'),
        r1Annotation(0),
        ...commandFields(17, 0),
        commandAnnotation(17, 'Read a block from address 0x0000'),
        r1Annotation(0),
        { classIndex: 17, texts: ['Start Block'] },
        { classIndex: 17, texts: ['CRC'] },
        ...commandFields(24, 0),
        commandAnnotation(24, 'Write a block to address 0x0000'),
        r1Annotation(0),
        { classIndex: 24, texts: ['Start Block'] },
        { classIndex: 24, texts: ['Data Response'] },
        { classIndex: 24, texts: ['Card is busy'] },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 59,
        payloadBits: data.reduce((sum, item) => sum + item.words.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bitsPerCycle = 64,
    cycles = Math.ceil(required / bitsPerCycle),
    perBlock = 512;
  yield {
    name: 'seeded-long-cmd0-stream',
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
      for (let offset = 0; offset < cycles; offset += perBlock) {
        const count = Math.min(perBlock, cycles - offset);
        const data = Array.from({ length: count }, () => commandResponse(0, random() & 0xffffffff, random() & 1));
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            { classIndex: 133, texts: ['Command: CMD0 (GO_IDLE_STATE)'] },
            commandAnnotation(0, 'Reset the SD card'),
            r1Annotation(Number(data[0]!.words[7]!.miso ?? 0)),
          ],
          annotationCount: count * 16,
          payloadBits: count * bitsPerCycle,
        };
      }
    },
  };
}
