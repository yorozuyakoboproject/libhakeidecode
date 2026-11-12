import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { caliperMeasurement } from './index.js';

export interface CaliperItem {
  readonly raw: number;
  readonly flags: number;
  readonly bits?: number;
  readonly gap?: number;
}

export interface CaliperCase extends RoundtripCase<CaliperItem> {
  readonly halfClockSamples: number;
  readonly initialSamples: number;
}

interface CaliperAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

function plan(
  config: CaliperCase,
  items: readonly CaliperItem[],
): { annotations: CaliperAnnotation[]; bits: number; totalSamples: number } {
  const half = config.halfClockSamples;
  const timeoutMs = Number(config.options.timeout_ms);
  const timeoutSamples = Math.round(timeoutMs * (config.sampleRate / 1000));
  const showAll = config.options.changes === 'no';
  let cursor = config.startSample + BigInt(config.initialSamples);
  let lastValue: number | null = null;
  let lastUnit = '';
  let bits = 0;
  const annotations: CaliperAnnotation[] = [];

  for (const item of items) {
    cursor += BigInt(Math.max(0, Math.trunc(item.gap ?? 0)));
    const count = item.bits ?? 24;
    if (!Number.isInteger(count) || count < 0 || count > 24) throw new RangeError('Caliper packet has invalid length');
    if (count) {
      const first = cursor + BigInt(half);
      const last = first + BigInt(2 * half * (count - 1));
      if (count === 24) {
        const measurement = caliperMeasurement(
          item.raw,
          Boolean((item.flags >>> 4) & 1),
          Boolean((item.flags >>> 7) & 1),
          String(config.options.unit),
        );
        if (showAll || measurement.value !== lastValue || measurement.unit !== lastUnit) {
          annotations.push({
            ss: first,
            es: last,
            classIndex: 0,
            texts: [measurement.text, measurement.short],
          });
          lastValue = measurement.value;
          lastUnit = measurement.unit;
        }
      } else if (timeoutMs && timeoutSamples > 0) {
        annotations.push({
          ss: first,
          es: last + BigInt(timeoutSamples),
          classIndex: 1,
          texts: [`timeout with ${count} bits in buffer`, `timeout (${count} bits)`, 'timeout'],
        });
      }
      bits += count;
    }
    cursor += BigInt(count * 2 * half);
  }
  return { annotations, bits, totalSamples: Number(cursor - config.startSample) };
}

function expectedAnnotations(annotations: readonly CaliperAnnotation[]): ExpectedFrame[] {
  return annotations.map((item) => ({
    ss: item.ss,
    es: item.es,
    classIndex: item.classIndex,
    texts: item.texts,
  }));
}

function summary(config: CaliperCase, totalSamples: number): ExpectedFrame {
  return {
    protoId: 'caliper',
    kind: 'summary',
    ss: config.startSample,
    es: config.startSample + BigInt(totalSamples),
  };
}

function boundary(
  name: string,
  items: readonly CaliperItem[],
  options: Record<string, string | number>,
  sampleRate: number,
  startSample: bigint,
): CaliperCase {
  const config: CaliperCase = {
    name,
    kind: 'boundary',
    seed: 0x43414c49,
    sampleRate,
    startSample,
    initialSamples: 3,
    halfClockSamples: 2,
    channels: { clk: 1, data: 5 },
    options,
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const result = plan(config, items);
      yield {
        data: items,
        expected: [summary(config, result.totalSamples)],
        expectedAnnotations: expectedAnnotations(result.annotations),
        annotationCount: result.annotations.length,
        payloadBits: Math.max(1, result.bits),
      };
    },
  };
  return config;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x43414c49,
}: GenerationOptions = {}): Iterable<CaliperCase> {
  yield boundary(
    'keep-extremes',
    [
      { raw: 0, flags: 0 },
      { raw: 0xffff, flags: 0 },
      { raw: 1, flags: 1 << 4 },
      { raw: 0xffff, flags: (1 << 4) | (1 << 7) },
      { raw: 2, flags: 1 << 7 },
      { raw: 1234, flags: 0 },
    ],
    { timeout_ms: 10, unit: 'keep', changes: 'no' },
    1_000_000,
    23n,
  );
  yield boundary(
    'convert-inch-to-mm',
    [
      { raw: 1, flags: 1 << 7, gap: 5 },
      { raw: 25_400, flags: 1 << 7 },
      { raw: 0xffff, flags: (1 << 7) | (1 << 4) },
    ],
    { timeout_ms: 10, unit: 'mm', changes: 'no' },
    1_000_000,
    9_007_199_254_740_990n,
  );
  yield boundary(
    'convert-mm-to-inch',
    [
      { raw: 2540, flags: 0 },
      { raw: 1000, flags: 0 },
      { raw: 10, flags: 0 },
      { raw: 0x8000, flags: 1 << 4 },
    ],
    { timeout_ms: 5, unit: 'inch', changes: 'no' },
    500_000,
    61n,
  );
  yield boundary(
    'changes-only',
    [
      { raw: 1000, flags: 0 },
      { raw: 1000, flags: 0 },
      { raw: 1000, flags: 0 },
      { raw: 1000, flags: 1 << 7 },
      { raw: 1000, flags: 1 << 7 },
      { raw: 1001, flags: 1 << 7 },
    ],
    { timeout_ms: 0, unit: 'keep', changes: 'yes' },
    1_000_000,
    7n,
  );
  yield boundary(
    'timeout-partial-recovery',
    [
      { raw: 0x1234, flags: 0, bits: 5 },
      { raw: 0x4321, flags: 0, gap: 120 },
      { raw: 0x1111, flags: 0 },
    ],
    { timeout_ms: 1, unit: 'keep', changes: 'no' },
    100_000,
    37n,
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const packets = Math.ceil(required / 24);
  const totalBits = packets * 24;
  const perBlock = 256;
  const half = 2;
  const initialSamples = 3;
  const config: CaliperCase = {
    name: 'seeded-long-packets',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    initialSamples,
    halfClockSamples: half,
    channels: { clk: 2, data: 6 },
    options: { timeout_ms: 0, unit: 'keep', changes: 'no' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      const firstRise = initialSamples + half;
      for (let offset = 0, block = 0; offset < packets; offset += perBlock, block++) {
        const length = Math.min(perBlock, packets - offset);
        const data: CaliperItem[] = [];
        for (let index = 0; index < length; index++)
          data.push({ raw: random() & 0xffff, flags: (random() >>> 8) & 0xff });
        const firstPacketRise = firstRise + 2 * half * 24 * offset;
        const first = data[0]!;
        const measurement = caliperMeasurement(
          first.raw,
          Boolean((first.flags >>> 4) & 1),
          Boolean((first.flags >>> 7) & 1),
          'keep',
        );
        yield {
          data,
          expected:
            block === 0
              ? [
                  {
                    protoId: 'caliper',
                    kind: 'summary',
                    ss: config.startSample,
                    es: config.startSample + BigInt(initialSamples + totalBits * 2 * half),
                  },
                ]
              : [],
          expectedAnnotations: [
            {
              ss: BigInt(firstPacketRise),
              es: BigInt(firstPacketRise + 2 * half * 23),
              classIndex: 0,
              texts: [measurement.text, measurement.short],
            },
          ],
          annotationCount: data.length,
          payloadBits: data.length * 24,
        };
      }
    },
  };
  yield config;
}
