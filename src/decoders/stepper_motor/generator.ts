import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { formatStepper } from './index.js';

export interface StepperItem {
  readonly direction: 0 | 1;
}

export interface StepperCase extends RoundtripCase<StepperItem> {
  readonly stepSamples: number;
  readonly initialSamples: number;
}

interface StepperAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

function scaleOf(config: StepperCase): { scale: number; decimals: 0 | 2; unit: string } {
  if (config.options.unit === 'steps') return { scale: 1, decimals: 0, unit: 'steps' };
  return { scale: Number(config.options.steps_per_mm), decimals: 2, unit: 'mm' };
}

function eventTexts(
  config: StepperCase,
  sample: bigint,
  previous: bigint,
  position: number,
): Pick<StepperAnnotation, 'texts' | 'classIndex'>[] {
  const { scale, decimals, unit } = scaleOf(config);
  const speed = config.sampleRate / Number(sample - previous) / scale;
  const speedText = formatStepper(speed, decimals);
  const positionText = formatStepper(position / scale, decimals);
  return [
    { classIndex: 0, texts: [`${speedText} ${unit}/s`, speedText] },
    { classIndex: 1, texts: [`${positionText} ${unit}`, positionText] },
  ];
}

function plan(
  config: StepperCase,
  items: readonly StepperItem[],
): { annotations: StepperAnnotation[]; totalSamples: number } {
  const annotations: StepperAnnotation[] = [];
  let position = 0;
  for (let index = 0; index < items.length; index++) {
    const sample = config.startSample + BigInt(config.initialSamples + index * config.stepSamples);
    if (index) {
      const previous = sample - BigInt(config.stepSamples);
      for (const event of eventTexts(config, sample, previous, position))
        annotations.push({ ss: previous, es: sample, classIndex: event.classIndex, texts: event.texts });
    }
    position += items[index]!.direction ? 1 : -1;
  }
  const totalSamples = items.length
    ? config.initialSamples + 1 + (items.length - 1) * config.stepSamples
    : config.initialSamples;
  return { annotations, totalSamples };
}

function expectedAnnotations(annotations: readonly StepperAnnotation[]): ExpectedFrame[] {
  return annotations.map((item) => ({
    ss: item.ss,
    es: item.es,
    classIndex: item.classIndex,
    texts: item.texts,
  }));
}

function summary(config: StepperCase, totalSamples: number): ExpectedFrame {
  return {
    protoId: 'stepper_motor',
    kind: 'summary',
    ss: config.startSample,
    es: config.startSample + BigInt(totalSamples),
  };
}

function boundary(
  name: string,
  directions: readonly (0 | 1)[],
  options: Record<string, string | number>,
  sampleRate: number,
  stepSamples: number,
  startSample: bigint,
): StepperCase {
  const config: StepperCase = {
    name,
    kind: 'boundary',
    seed: 0x53544550,
    sampleRate,
    startSample,
    initialSamples: 2,
    stepSamples,
    channels: { step: 3, dir: 7 },
    options,
    chunkSamples: [1, 23, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = directions.map((direction) => ({ direction }));
      const result = plan(config, data);
      yield {
        data,
        expected: [summary(config, result.totalSamples)],
        expectedAnnotations: expectedAnnotations(result.annotations),
        annotationCount: result.annotations.length,
        payloadBits: data.length,
      };
    },
  };
  return config;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53544550,
}: GenerationOptions = {}): Iterable<StepperCase> {
  yield boundary(
    'steps-reversal',
    [1, 1, 0, 1, 0, 0, 1, 1, 0],
    { unit: 'steps', steps_per_mm: 100 },
    1_000_000,
    4,
    17n,
  );
  yield boundary(
    'millimetres-slow-speed',
    [0, 0, 1, 1, 0, 1, 0, 0, 1, 1],
    { unit: 'mm', steps_per_mm: 200 },
    2_000_000,
    7,
    9_007_199_254_740_990n,
  );
  yield boundary(
    'millimetres-fractional-scale',
    [1, 0, 1, 0, 0, 1, 1, 0, 1],
    { unit: 'mm', steps_per_mm: 12.5 },
    800_000,
    3,
    53n,
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const count = required;
  const perBlock = 8192;
  const stepSamples = 4;
  const initialSamples = 2;
  const config: StepperCase = {
    name: 'seeded-long-motion',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    initialSamples,
    stepSamples,
    channels: { step: 1, dir: 6 },
    options: { unit: 'steps', steps_per_mm: 100 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let position = 0;
      for (let offset = 0, block = 0; offset < count; offset += perBlock, block++) {
        const length = Math.min(perBlock, count - offset);
        const data: StepperItem[] = Array.from({ length }, () => ({
          direction: (random() & 1) as 0 | 1,
        }));
        let firstExpected: ExpectedFrame[];
        if (offset === 0) {
          firstExpected = [
            { ss: 2n, es: 6n, classIndex: 0, texts: ['250000 steps/s', '250000'] },
            {
              ss: 2n,
              es: 6n,
              classIndex: 1,
              texts: [`${data[0]!.direction ? 1 : -1} steps`, String(data[0]!.direction ? 1 : -1)],
            },
          ];
        } else {
          const previous = BigInt(initialSamples + (offset - 1) * stepSamples);
          const sample = previous + BigInt(stepSamples);
          const texts = eventTexts(config, sample, previous, position)[0]!;
          firstExpected = [{ ss: previous, es: sample, ...texts }];
        }
        const emitting = offset === 0 ? Math.max(0, data.length - 1) : data.length;
        for (const item of data) position += item.direction ? 1 : -1;
        yield {
          data,
          expected:
            block === 0
              ? [
                  {
                    protoId: 'stepper_motor',
                    kind: 'summary',
                    ss: config.startSample,
                    es: config.startSample + BigInt(initialSamples + 1 + (count - 1) * stepSamples),
                  },
                ]
              : [],
          expectedAnnotations: firstExpected,
          annotationCount: emitting * 2,
          payloadBits: data.length,
        };
      }
    },
  };
  yield config;
}
