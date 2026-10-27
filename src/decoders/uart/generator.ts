import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface UARTWords {
  readonly rx?: number;
  readonly tx?: number;
}

export interface UARTCase extends RoundtripCase<UARTWords> {
  readonly idleBits: number;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x55415254,
}: GenerationOptions = {}): Iterable<UARTCase> {
  const boundaries = [
    { name: '8n1-back-to-back', bits: 8, parity: 'none', stops: 1, idle: 0 },
    { name: '5-odd-no-stop', bits: 5, parity: 'odd', stops: 0 },
    { name: '6-even-half-stop', bits: 6, parity: 'even', stops: 0.5 },
    { name: '7-zero-one-and-half-stop', bits: 7, parity: 'zero', stops: 1.5 },
    { name: '9-one-two-stops-msb-inverted', bits: 9, parity: 'one', stops: 2, msb: true, invert: true },
    { name: '8-ignore-tx-only', bits: 8, parity: 'ignore', stops: 1, txOnly: true },
    { name: '8n1-rx-only', bits: 8, parity: 'none', stops: 1, rxOnly: true },
    { name: 'fractional-samples', bits: 8, parity: 'even', stops: 1, sampleRate: 2_000_000 },
    { name: 'sample-point-1', bits: 8, parity: 'none', stops: 1, point: 1 },
    { name: 'sample-point-99', bits: 8, parity: 'none', stops: 1, point: 99 },
    { name: 'large-sample-position', bits: 8, parity: 'none', stops: 1, start: 9_007_199_254_740_990n },
    { name: 'seeded-long', bits: 8, parity: 'none', stops: 1, long: true, idle: 0, sampleRate: 1_843_200 },
  ];
  for (const boundary of boundaries) {
    const long = boundary.long ?? false;
    const payloadBits = long ? Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits) : 0;
    const channels: Record<string, number> = boundary.txOnly
      ? { tx: 6 }
      : boundary.rxOnly
        ? { rx: 1 }
        : { rx: 1, tx: 6 };
    const directions = Object.keys(channels) as ('rx' | 'tx')[];
    const mask = 2 ** boundary.bits - 1;
    const count = long ? Math.ceil(payloadBits / (boundary.bits * directions.length)) : 16;
    yield {
      name: boundary.name,
      kind: long ? 'long' : 'boundary',
      seed,
      sampleRate: boundary.sampleRate ?? 7_372_800,
      channels,
      options: {
        baudrate: 115200,
        data_bits: boundary.bits,
        parity: boundary.parity,
        stop_bits: boundary.stops,
        bit_order: boundary.msb ? 'msb-first' : 'lsb-first',
        invert_rx: boundary.invert ? 'yes' : 'no',
        invert_tx: boundary.invert ? 'yes' : 'no',
        sample_point: boundary.point ?? 50,
      },
      startSample: boundary.start ?? 0n,
      chunkSamples: long ? [4093, 8191, 16381] : [1, 31, 64, 127],
      idleBits: boundary.idle ?? 2,
      minimumPayloadBits: payloadBits,
      *generate() {
        const random = randomWords(seed);
        for (let offset = 0; offset < count; offset += 256) {
          const data: UARTWords[] = [],
            expected: ExpectedFrame[] = [];
          for (let index = offset; index < Math.min(count, offset + 256); index++) {
            const words: { rx?: number; tx?: number } = {};
            for (const direction of directions) {
              const value = long
                ? random() & mask
                : [0, mask, 1, mask - 1, 0x55 & mask, 0xaa & mask, 1 << (boundary.bits - 1), random() & mask][
                    index % 8
                  ]!;
              words[direction] = value;
              expected.push({ value, direction: direction === 'rx' ? 0 : 1, valid: true });
            }
            data.push(words);
          }
          yield { data, expected, payloadBits: data.length * directions.length * boundary.bits };
        }
      },
    };
  }
}
