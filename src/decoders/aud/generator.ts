import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface AudCommand {
  readonly nibbles: 1 | 2 | 4 | 8;
  readonly value: number;
}

export interface AudCase extends RoundtripCase<AudCommand> {}

export const AUD_SAMPLES_PER_NIBBLE = 2;

const CHANNELS = { audck: 0, naudsync: 1, audata3: 2, audata2: 3, audata1: 4, audata0: 5 };
const SUMMARY: ExpectedFrame = { protoId: 'aud', kind: 'summary' };

export function audAnnotationStart(command: AudCommand, start: bigint): bigint {
  return start;
}

export function audAnnotationEnd(command: AudCommand, start: bigint): bigint {
  return start + BigInt(AUD_SAMPLES_PER_NIBBLE * (1 + command.nibbles));
}

function annotation(command: AudCommand, start: bigint): ExpectedFrame {
  return {
    ss: audAnnotationStart(command, start),
    es: audAnnotationEnd(command, start),
    classIndex: 0,
    texts: [`0x${BigInt(command.value).toString(16).toUpperCase().padStart(8, '0')}`],
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x415544,
}: GenerationOptions = {}): Iterable<AudCase> {
  yield {
    name: 'address-widths',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 17n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const commands: AudCommand[] = [
        { nibbles: 1, value: 0x0a },
        { nibbles: 2, value: 0xbc },
        { nibbles: 4, value: 0x89ab },
        { nibbles: 8, value: 0xdeadbeef },
      ];
      let cursor = 18n;
      const expectedAnnotations = commands.map((command) => {
        const item = annotation(command, cursor);
        cursor = audAnnotationEnd(command, cursor);
        return item;
      });
      yield {
        data: commands,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: commands.length,
        payloadBits: commands.reduce((sum, command) => sum + 4 * (1 + command.nibbles), 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 8192;
  const commands = Math.ceil(required / 8);
  yield {
    name: 'seeded-long-addresses',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let cursor = 1n;
      for (let offset = 0; offset < commands; offset += perBlock) {
        const count = Math.min(perBlock, commands - offset);
        const data: AudCommand[] = Array.from({ length: count }, () => ({
          nibbles: 1 as const,
          value: random() & 0x0f,
        }));
        const expectedAnnotations = [annotation(data[0]!, cursor)];
        for (const command of data) cursor = audAnnotationEnd(command, cursor);
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: data.length,
          payloadBits: data.length * 8,
        };
      }
    },
  };
}
