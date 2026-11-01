import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface PWMCycle {
  readonly periodTicks: number;
  readonly dutyUnits: number;
}

export interface PWMCase extends RoundtripCase<PWMCycle> {
  readonly tickRate: number;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x50574d,
}: GenerationOptions = {}): Iterable<PWMCase> {
  for (const polarity of ['active-high', 'active-low']) {
    for (const mode of ['fixed-1khz-50-duty', 'boundary', 'quantized', 'large-position', 'long']) {
      const long = mode === 'long';
      const fixed = mode === 'fixed-1khz-50-duty';
      const sampleRate = mode === 'boundary' || fixed ? 16_000_000 : 1_000_000;
      const startSample = mode === 'large-position' ? 9_007_199_254_740_990n : 0n;
      const minimum = long ? Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits) : 0;
      const count = long ? Math.ceil(minimum / 32) : 16;
      const tickRate = 16_000_000;
      yield {
        name: polarity + '-' + mode,
        kind: long ? 'long' : 'boundary',
        seed,
        sampleRate,
        startSample,
        tickRate,
        channels: { data: polarity === 'active-high' ? 0 : 7 },
        options: { polarity },
        chunkSamples: long ? [4093, 8191, 16381] : [1, 7, 257, 4093],
        minimumPayloadBits: minimum,
        *generate() {
          const random = randomWords(seed);
          let start = startSample + 3n;
          for (let offset = 0; offset < count; offset += 256) {
            const data: PWMCycle[] = [],
              expected: ExpectedFrame[] = [];
            for (let index = offset; index < Math.min(count, offset + 256); index++) {
              const periodTicks = fixed
                ? 16_000
                : long
                  ? 256 + (random() % 65280)
                  : [32, 33, 63, 1023, 65535, 160, 65534, 1600][index % 8]!;
              const minimumDuty = Math.ceil((16 * 65535) / periodTicks);
              const dutyUnits = fixed
                ? 32_768
                : long
                  ? minimumDuty + (random() % (65536 - 2 * minimumDuty))
                  : [32768, 33761, 48892, 32768, 65519, 6554, 32768, 64880][index % 8]!;
              data.push({ periodTicks, dutyUnits });
              const numerator = BigInt(periodTicks) * BigInt(sampleRate);
              const period = (2n * numerator + BigInt(tickRate)) / (2n * BigInt(tickRate));
              const denominator = BigInt(tickRate) * 65535n;
              const active = (2n * numerator * BigInt(dutyUnits) + denominator) / (2n * denominator);
              expected.push({
                ss: start,
                es: start + period,
                periodSamples: period,
                activeSamples: active,
                periodSeconds: { value: Number(period) / sampleRate, tolerance: Number.EPSILON },
                dutyCycle: { value: (Number(active) * 100) / Number(period), tolerance: 1e-9 },
              });
              start += period;
            }
            yield { data, expected, payloadBits: data.length * 32 };
          }
        },
      };
    }
  }
}
