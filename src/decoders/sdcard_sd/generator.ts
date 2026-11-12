import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { commandName } from './tables.js';

export interface SdToken {
  readonly bits: readonly number[];
}

export interface SdcardSdCase extends RoundtripCase<SdToken> {}

const CHANNELS = { cmd: 0, clk: 2 } as const;
const SUMMARY: ExpectedFrame = { protoId: 'sdcard_sd', kind: 'summary' };

function valueBits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >>> (width - index - 1)) & 1);
}

function token(bits: readonly number[]): SdToken {
  return { bits };
}

function commandToken(index: number, argument = 0, crc = 0): SdToken {
  return token([0, 1, ...valueBits(index, 6), ...valueBits(argument >>> 0, 32), ...valueBits(crc & 0x7f, 7), 1]);
}

function responseToken(index: number, argument = 0): SdToken {
  return token([0, 0, ...valueBits(index, 6), ...valueBits(argument >>> 0, 32), ...valueBits(0, 7), 1]);
}

function responseR2(register: readonly number[]): SdToken {
  return token([0, 0, 1, 1, 1, 1, 1, 1, ...register.slice(0, 127), 1]);
}

function registerBits(base: number): number[] {
  return Array.from({ length: 127 }, (_, index) => ((base + Math.imul(index, 29)) >>> (index % 8)) & 1);
}

function commandAnnotation(index: number, description: string, application = false): ExpectedFrame {
  const prefix = application ? 'ACMD' : 'CMD',
    name = commandName(index, application),
    command = `${prefix}${index} (${name})`;
  return {
    classIndex: (application ? 64 : 0) + index,
    texts: [`${command}: ${description}`, command, `${prefix}${index}`],
  };
}

function responseAnnotation(index: number): ExpectedFrame {
  const names: Readonly<Record<number, string>> = {
    128: 'R1',
    129: 'R1b',
    130: 'R2',
    131: 'R3',
    132: 'R6',
    133: 'R7',
  };
  return { classIndex: index, texts: [`Response: ${names[index]}`] };
}

function options(): Record<string, string> {
  return {};
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53444353,
}: GenerationOptions = {}): Iterable<SdcardSdCase> {
  yield {
    name: 'commands-and-responses',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_000n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = [
        commandToken(0),
        commandToken(16, 512),
        responseToken(16),
        commandToken(55),
        responseToken(55),
        commandToken(41, 0x40ff8000),
        responseToken(41, 0x40ff8000),
        commandToken(2),
        responseR2(registerBits(0x31)),
        commandToken(9, 0x00010000),
        responseR2(registerBits(0x73)),
        commandToken(7, 0x00010000),
        responseToken(7, 0x00010000),
        commandToken(8, 0x1aa),
        responseToken(8, 0x1aa),
        commandToken(17),
        responseToken(17),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        commandAnnotation(0, 'Reset all SD cards'),
        commandAnnotation(16, 'Set the block length to 512 bytes'),
        responseAnnotation(128),
        commandAnnotation(55, 'Next command is an application-specific command'),
        responseAnnotation(128),
        commandAnnotation(41, 'Send HCS info and activate the card init process', true),
        responseAnnotation(131),
        commandAnnotation(2, 'Ask card for CID number'),
        responseAnnotation(130),
        commandAnnotation(9, 'Send card-specific data (CSD)'),
        responseAnnotation(130),
        commandAnnotation(7, 'Select / deselect card'),
        responseAnnotation(132),
        commandAnnotation(8, 'Send interface condition to card'),
        responseAnnotation(133),
        commandAnnotation(17, 'CMD17'),
        responseAnnotation(128),
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 1_265,
        payloadBits: data.reduce((sum, item) => sum + item.bits.length, 0),
      };
    },
  };

  yield {
    name: 'application-status-and-registers',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 17n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [3, 31, 2047],
    minimumPayloadBits: 0,
    *generate() {
      const data = [
        commandToken(55),
        responseToken(55),
        commandToken(6, 2),
        responseToken(6),
        commandToken(55),
        responseToken(55),
        commandToken(13),
        responseToken(13),
        commandToken(55),
        responseToken(55),
        commandToken(51),
        responseToken(51),
        commandToken(10, 0x00010000),
        responseR2(registerBits(0x55)),
        commandToken(13, 0x00010000),
        responseToken(13),
        commandToken(6),
        responseToken(6),
        commandToken(3),
        responseToken(3, 0x12340000),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        commandAnnotation(55, 'Next command is an application-specific command'),
        responseAnnotation(128),
        commandAnnotation(6, 'Read SD config register (SCR)', true),
        responseAnnotation(128),
        commandAnnotation(55, 'Next command is an application-specific command'),
        responseAnnotation(128),
        commandAnnotation(13, 'Set SD status', true),
        responseAnnotation(128),
        commandAnnotation(55, 'Next command is an application-specific command'),
        responseAnnotation(128),
        commandAnnotation(51, 'Read SD config register (SCR)', true),
        responseAnnotation(128),
        commandAnnotation(10, 'Send card identification data (CID)'),
        responseAnnotation(130),
        commandAnnotation(13, 'Send card status register'),
        responseAnnotation(128),
        commandAnnotation(6, 'Switch/check card function'),
        responseAnnotation(128),
        commandAnnotation(3, 'Ask card for new relative card address (RCA)'),
        responseAnnotation(132),
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 1_443,
        payloadBits: data.reduce((sum, item) => sum + item.bits.length, 0),
      };
    },
  };

  yield {
    name: 'missing-response-recovers-command',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 41n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [5, 127, 1021],
    minimumPayloadBits: 0,
    *generate() {
      const data = [
        commandToken(2),
        commandToken(9, 0x00010000),
        responseR2(registerBits(0x69)),
        commandToken(16, 512),
        commandToken(17),
        responseToken(17),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        commandAnnotation(2, 'Ask card for CID number'),
        commandAnnotation(9, 'Send card-specific data (CSD)'),
        responseAnnotation(130),
        commandAnnotation(16, 'Set the block length to 512 bytes'),
        commandAnnotation(17, 'CMD17'),
        responseAnnotation(128),
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        payloadBits: data.reduce((sum, item) => sum + item.bits.length, 0),
      };
    },
  };

  yield {
    name: 'missing-responses-preserve-command-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 73n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [2, 3, 7, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data = [
        commandToken(16, 512),
        commandToken(17),
        responseToken(17, 0x12345678),
        commandToken(2),
        commandToken(9, 0x00010000),
        responseR2(registerBits(0x4d)),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        commandAnnotation(16, 'Set the block length to 512 bytes'),
        commandAnnotation(17, 'CMD17'),
        responseAnnotation(128),
        commandAnnotation(2, 'Ask card for CID number'),
        commandAnnotation(9, 'Send card-specific data (CSD)'),
        responseAnnotation(130),
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        payloadBits: data.reduce((sum, item) => sum + item.bits.length, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bitsPerCycle = 96,
    cycles = Math.ceil(required / bitsPerCycle),
    perBlock = 512;
  yield {
    name: 'seeded-long-block-length-cycles',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < cycles; offset += perBlock) {
        const count = Math.min(perBlock, cycles - offset),
          data: SdToken[] = [];
        for (let index = 0; index < count; index++) {
          data.push(commandToken(16, 512), responseToken(16, random() & 0xffffffff));
        }
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations: [commandAnnotation(16, 'Set the block length to 512 bytes'), responseAnnotation(128)],
          annotationCount: count * 140,
          payloadBits: count * bitsPerCycle,
        };
      }
    },
  };
}
