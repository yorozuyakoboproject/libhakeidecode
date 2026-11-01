import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface IRNECWord {
  readonly kind: 'nec' | 'repeat';
  readonly address?: number;
  readonly command?: number;
  readonly invalid?: boolean;
}
export interface IRNECCase extends RoundtripCase<IRNECWord> {
  readonly gapMs: number;
}

function expected(word: IRNECWord, extended: boolean): ExpectedFrame {
  if (word.kind === 'repeat')
    return {
      kind: 'repeat',
      address: null,
      command: null,
      addressInverse: null,
      commandInverse: null,
      valid: true,
    };
  const address = word.address ?? 0,
    command = word.command ?? 0,
    addressInverse = word.invalid ? (address ^ 0x5a) & 0xff : (address ^ 0xff) & 0xff,
    commandInverse = word.invalid ? (command ^ 0xa5) & 0xff : (command ^ 0xff) & 0xff;
  return extended
    ? {
        kind: 'nec',
        address: address & 0xffff,
        command,
        addressInverse: null,
        commandInverse,
        valid: !word.invalid,
      }
    : {
        kind: 'nec',
        address,
        command,
        addressInverse,
        commandInverse,
        valid: !word.invalid,
      };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x49524e45,
}: GenerationOptions = {}): Iterable<IRNECCase> {
  const boundaries = [
    { name: 'standard-low', polarity: 'active-low', extended: false, carrier: 0, address: 0x00, command: 0x16 },
    { name: 'standard-high', polarity: 'active-high', extended: false, carrier: 0, address: 0xa5, command: 0x5a },
    { name: 'standard-auto', polarity: 'auto', extended: false, carrier: 0, address: 0x7e, command: 0x81 },
    { name: 'extended-low', polarity: 'active-low', extended: true, carrier: 0, address: 0x12ab, command: 0x34 },
    {
      name: 'invalid-inverse',
      polarity: 'active-low',
      extended: false,
      carrier: 0,
      address: 0x10,
      command: 0x20,
      invalid: true,
    },
    { name: 'carrier-38k', polarity: 'active-low', extended: false, carrier: 38_000, address: 0x55, command: 0xaa },
    { name: 'repeat', polarity: 'active-low', extended: false, carrier: 0, repeat: true },
  ];
  for (const item of boundaries) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: item.carrier ? 2_000_000 : 1_000_000,
      startSample: item.name === 'extended-low' ? 9_007_199_254_740_990n : 5n,
      channels: { ir: 3 },
      options: {
        polarity: item.polarity,
        carrier_frequency: item.carrier,
        extended: item.extended ? 'yes' : 'no',
      },
      chunkSamples: [1, 31, 257, 4093],
      gapMs: 20,
      minimumPayloadBits: 0,
      *generate() {
        const data: IRNECWord[] = item.repeat
          ? [{ kind: 'repeat' }, { kind: 'repeat' }]
          : [
              { kind: 'nec', address: item.address, command: item.command, invalid: item.invalid },
              { kind: 'repeat' },
              { kind: 'nec', address: (item.address ?? 0) + 1, command: (item.command ?? 0) + 1 },
            ];
        yield { data, expected: data.map((word) => expected(word, item.extended)), payloadBits: 32 * data.length };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const count = Math.ceil(required / 32);
  const perBlock = 128;
  yield {
    name: 'seeded-long-standard',
    kind: 'long',
    seed,
    sampleRate: 10_000,
    startSample: 0n,
    channels: { ir: 0 },
    options: { polarity: 'active-low', carrier_frequency: 0, extended: 'no' },
    chunkSamples: [4093, 8191, 16381],
    gapMs: 0,
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < count; offset += perBlock) {
        const data: IRNECWord[] = [],
          expectedFrames: ExpectedFrame[] = [];
        for (let index = offset; index < Math.min(count, offset + perBlock); index++) {
          const word: IRNECWord = {
            kind: 'nec',
            address: random() & 0xff,
            command: random() & 0xff,
          };
          data.push(word);
          expectedFrames.push(expected(word, false));
        }
        yield { data, expected: expectedFrames, payloadBits: data.length * 32 };
      }
    },
  };
}
