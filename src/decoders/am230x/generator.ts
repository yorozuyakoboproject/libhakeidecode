import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { am230xBitsToNumber, am230xChecksum, am230xHumidity, am230xTemperature, formatAm230xNumber } from './index.js';

export interface Am230xProfile {
  readonly startLow: number;
  readonly startHigh: number;
  readonly responseLow: number;
  readonly responseHigh: number;
  readonly bitLow: number;
  readonly bit0High: number;
  readonly bit1High: number;
  readonly endLow: number;
  readonly endHigh: number;
}

export const AM230X_PROFILES = {
  min: {
    startLow: 750,
    startHigh: 10,
    responseLow: 50,
    responseHigh: 50,
    bitLow: 45,
    bit0High: 20,
    bit1High: 65,
    endLow: 45,
    endHigh: 100,
  },
  nominal: {
    startLow: 1000,
    startHigh: 30,
    responseLow: 80,
    responseHigh: 80,
    bitLow: 50,
    bit0High: 28,
    bit1High: 70,
    endLow: 50,
    endHigh: 100,
  },
  max: {
    startLow: 25_000,
    startHigh: 10_000,
    responseLow: 90,
    responseHigh: 90,
    bitLow: 90,
    bit0High: 35,
    bit1High: 80,
    endLow: 90,
    endHigh: 100,
  },
  long: {
    startLow: 750,
    startHigh: 10,
    responseLow: 50,
    responseHigh: 50,
    bitLow: 50,
    bit0High: 20,
    bit1High: 70,
    endLow: 50,
    endHigh: 100,
  },
} as const satisfies Record<string, Am230xProfile>;

export type Am230xProfileName = keyof typeof AM230X_PROFILES;
export type Am230xItem = { readonly kind: 'packet'; readonly bytes: readonly number[] } | { readonly kind: 'noise' };

export interface Am230xCase extends RoundtripCase<Am230xItem> {
  readonly profile: Am230xProfileName;
  readonly initialHighMicros: number;
}

interface Am230xAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

function validateBytes(bytes: readonly number[]): void {
  if (bytes.length !== 5 || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff))
    throw new RangeError('AM230x packets require five bytes');
}

export function am230xItemBits(item: Am230xItem): number[] {
  if (item.kind === 'noise') return [];
  validateBytes(item.bytes);
  return item.bytes.flatMap((value) => Array.from({ length: 8 }, (_, bit) => (value >>> (7 - bit)) & 1));
}

export function am230xPacketCycleMicros(item: Am230xItem, profile: Am230xProfile): number {
  if (item.kind === 'noise') return 300 + 30;
  const bits = am230xItemBits(item);
  let total =
    profile.startLow +
    profile.startHigh +
    profile.responseLow +
    profile.responseHigh +
    profile.endLow +
    profile.endHigh;
  for (const bit of bits) total += profile.bitLow + (bit ? profile.bit1High : profile.bit0High);
  return total;
}

function sampleAt(config: Am230xCase, micros: number): bigint {
  return config.startSample + BigInt(Math.round((micros * config.sampleRate) / 1_000_000));
}

function plan(
  config: Am230xCase,
  items: readonly Am230xItem[],
): { annotations: Am230xAnnotation[]; bits: number; totalMicros: number } {
  const profile = AM230X_PROFILES[config.profile];
  const device = String(config.options.device);
  const annotations: Am230xAnnotation[] = [];
  let micros = config.initialHighMicros;
  let bits = 0;

  for (const item of items) {
    if (item.kind === 'noise') {
      micros += 300 + 30;
      continue;
    }
    validateBytes(item.bytes);
    const packetStart = sampleAt(config, micros);
    micros += profile.startLow;
    micros += profile.startHigh;
    const startEnd = sampleAt(config, micros);
    annotations.push({ ss: packetStart, es: startEnd, classIndex: 0, texts: ['Start', 'S'] });
    micros += profile.responseLow;
    micros += profile.responseHigh;
    const responseEnd = sampleAt(config, micros);
    annotations.push({ ss: startEnd, es: responseEnd, classIndex: 1, texts: ['Response', 'R'] });

    const bitValues = am230xItemBits(item);
    const bytePositions = [responseEnd];
    let lastBitEnd = responseEnd;
    for (let index = 0; index < bitValues.length; index++) {
      const bitStart = sampleAt(config, micros);
      micros += profile.bitLow;
      micros += bitValues[index] ? profile.bit1High : profile.bit0High;
      const bitEnd = sampleAt(config, micros);
      lastBitEnd = bitEnd;
      annotations.push({
        ss: bitStart,
        es: bitEnd,
        classIndex: 2,
        texts: [`Bit: ${bitValues[index]}`, String(bitValues[index])],
      });

      if ((index + 1) % 8 === 0) {
        const byte = am230xBitsToNumber(bitValues, index - 7, index + 1);
        const text = `0x${byte.toString(16).padStart(2, '0')}`;
        annotations.push({
          ss: bytePositions.at(-1) ?? bitStart,
          es: bitEnd,
          classIndex: 4,
          texts: [`Byte: ${text}`, text],
        });
        if (index === 15) {
          const value = formatAm230xNumber(am230xHumidity(item.bytes, device));
          annotations.push({
            ss: bytePositions.at(-2) ?? bitStart,
            es: bitEnd,
            classIndex: 5,
            texts: [`Humidity: ${value} %`, `RH = ${value} %`],
          });
        } else if (index === 31) {
          const value = formatAm230xNumber(am230xTemperature(item.bytes, device));
          annotations.push({
            ss: bytePositions.at(-2) ?? bitStart,
            es: bitEnd,
            classIndex: 6,
            texts: [`Temperature: ${value} °C`, `T = ${value} °C`],
          });
        } else if (index === 39) {
          const valid = item.bytes[4] === am230xChecksum(item.bytes.slice(0, 4));
          annotations.push({
            ss: bytePositions.at(-1) ?? bitStart,
            es: bitEnd,
            classIndex: 7,
            texts: valid ? ['Checksum: OK', 'OK'] : ['Checksum: not OK', 'NOK'],
          });
        }
        bytePositions.push(bitEnd);
      }
    }
    micros += profile.endLow;
    annotations.push({ ss: lastBitEnd, es: sampleAt(config, micros), classIndex: 3, texts: ['End', 'E'] });
    micros += profile.endHigh;
    bits += 40;
  }
  return { annotations, bits, totalMicros: micros };
}

function expectedAnnotations(annotations: readonly Am230xAnnotation[]): ExpectedFrame[] {
  return annotations.map((item) => ({
    ss: item.ss,
    es: item.es,
    classIndex: item.classIndex,
    texts: item.texts,
  }));
}

function summary(config: Am230xCase, totalMicros: number): ExpectedFrame {
  return {
    protoId: 'am230x',
    kind: 'summary',
    ss: config.startSample,
    es: sampleAt(config, totalMicros),
  };
}

function boundary(
  name: string,
  items: readonly Am230xItem[],
  device: string,
  profile: Am230xProfileName,
  sampleRate: number,
  startSample: bigint,
): Am230xCase {
  const config: Am230xCase = {
    name,
    kind: 'boundary',
    seed: 0x414d3233,
    sampleRate,
    startSample,
    initialHighMicros: 1000,
    profile,
    channels: { sda: 4 },
    options: { device },
    chunkSamples: [1, 19, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const result = plan(config, items);
      yield {
        data: items,
        expected: [summary(config, result.totalMicros)],
        expectedAnnotations: expectedAnnotations(result.annotations),
        annotationCount: result.annotations.length,
        payloadBits: Math.max(1, result.bits),
      };
    },
  };
  return config;
}

function packet(bytes: readonly number[]): Am230xItem {
  validateBytes(bytes);
  return { kind: 'packet', bytes };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x414d3233,
}: GenerationOptions = {}): Iterable<Am230xCase> {
  yield boundary(
    'minimum-timing-negative-temperature',
    [packet([0x00, 0x00, 0x80, 0x01, 0x81])],
    'am230x',
    'min',
    200_000,
    13n,
  );
  yield boundary(
    'maximum-timing-and-values',
    [packet([0x27, 0x0f, 0x27, 0x0f, 0x6c])],
    'am230x',
    'max',
    200_000,
    9_007_199_254_740_990n,
  );
  yield boundary('dht11-integer-values', [packet([65, 0, 23, 0, 88])], 'dht11', 'nominal', 200_000, 29n);
  yield boundary(
    'bad-checksum-after-noise',
    [{ kind: 'noise' }, packet([0x12, 0x34, 0x01, 0x02, 0x00])],
    'am230x',
    'min',
    200_000,
    71n,
  );
  yield boundary(
    'back-to-back-packets',
    [packet([0x03, 0xe8, 0x80, 0x64, 0x8c]), packet([0x03, 0xe8, 0x00, 0x64, 0x0c])],
    'am230x',
    'nominal',
    200_000,
    101n,
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const packets = Math.ceil(required / 40);
  const perBlock = 256;
  const profile = AM230X_PROFILES.long;
  const config: Am230xCase = {
    name: 'seeded-long-packets',
    kind: 'long',
    seed,
    sampleRate: 100_000,
    startSample: 0n,
    initialHighMicros: 1000,
    profile: 'long',
    channels: { sda: 1 },
    options: { device: 'am230x' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      const allBytes = new Uint8Array(packets * 5);
      for (let index = 0; index < packets; index++) {
        const offset = index * 5;
        allBytes[offset] = random() & 0xff;
        allBytes[offset + 1] = random() & 0xff;
        allBytes[offset + 2] = random() & 0xff;
        allBytes[offset + 3] = random() & 0xff;
        allBytes[offset + 4] =
          index % 17 === 0
            ? 0
            : am230xChecksum([allBytes[offset]!, allBytes[offset + 1]!, allBytes[offset + 2]!, allBytes[offset + 3]!]);
      }

      let totalCycleMicros = 0;
      for (let index = 0; index < packets; index++)
        totalCycleMicros += am230xPacketCycleMicros(
          { kind: 'packet', bytes: Array.from(allBytes.subarray(index * 5, index * 5 + 5)) },
          profile,
        );
      const captureEnd = sampleAt(config, config.initialHighMicros + totalCycleMicros);

      let sourceMicros = config.initialHighMicros;
      for (let offset = 0, block = 0; offset < packets; offset += perBlock, block++) {
        const length = Math.min(perBlock, packets - offset);
        const blockBytes = allBytes.slice(offset * 5, (offset + length) * 5);
        const data: Am230xItem[] = [];
        let blockCycle = 0;
        for (let index = 0; index < length; index++) {
          const bytes = Array.from(blockBytes.slice(index * 5, index * 5 + 5));
          data.push({ kind: 'packet', bytes });
          blockCycle += am230xPacketCycleMicros({ kind: 'packet', bytes }, profile);
        }
        const startFall = sampleAt(config, sourceMicros);
        const startEnd = sampleAt(config, sourceMicros + profile.startLow + profile.startHigh);
        const responseEnd = sampleAt(
          config,
          sourceMicros + profile.startLow + profile.startHigh + profile.responseLow + profile.responseHigh,
        );
        yield {
          data,
          expected:
            block === 0
              ? [
                  {
                    protoId: 'am230x',
                    kind: 'summary',
                    ss: config.startSample,
                    es: captureEnd,
                  },
                ]
              : [],
          expectedAnnotations: [
            { ss: startFall, es: startEnd, classIndex: 0, texts: ['Start', 'S'] },
            { ss: startEnd, es: responseEnd, classIndex: 1, texts: ['Response', 'R'] },
          ],
          annotationCount: data.length * 51,
          payloadBits: data.length * 40,
        };
        sourceMicros += blockCycle;
      }
    },
  };
  yield config;
}
