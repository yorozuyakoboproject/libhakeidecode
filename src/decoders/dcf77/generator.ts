import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Dcf77Slot {
  readonly highMs: number;
  readonly periodMs: number;
}

export interface Dcf77Case extends RoundtripCase<Dcf77Slot> {}

export interface Dcf77Position {
  readonly ss: bigint;
  readonly es: bigint;
  readonly end: bigint;
}

interface MinuteFields {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly weekday: number;
  readonly month: number;
  readonly year: number;
  readonly special?: number;
  readonly call?: number;
  readonly summer?: number;
  readonly cest?: number;
  readonly cet?: number;
  readonly leap?: number;
}

const MINUTE_SLOTS = 60;

function bcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

function setBits(bits: number[], start: number, value: number, width: number): void {
  for (let index = 0; index < width; index++) bits[start + index] = (value >>> index) & 1;
}

function setParity(bits: number[], start: number, end: number, parity: number): void {
  let ones = 0;
  for (let index = start; index <= end; index++) ones += bits[index]!;
  bits[parity] = ones & 1;
}

function minuteBits(fields: MinuteFields): number[] {
  const bits = Array<number>(59).fill(0);
  bits[0] = 0;
  bits[20] = 1;
  const special = fields.special ?? 0;
  for (let index = 0; index < 14; index++) bits[1 + index] = (special >>> index) & 1;
  bits[15] = fields.call ?? 0;
  bits[16] = fields.summer ?? 0;
  bits[17] = fields.cest ?? 0;
  bits[18] = fields.cet ?? 1;
  bits[19] = fields.leap ?? 0;
  setBits(bits, 21, bcd(fields.minute), 7);
  setParity(bits, 21, 27, 28);
  setBits(bits, 29, bcd(fields.hour), 6);
  setParity(bits, 29, 34, 35);
  setBits(bits, 36, bcd(fields.day), 6);
  setBits(bits, 42, bcd(fields.weekday), 3);
  setBits(bits, 45, bcd(fields.month), 5);
  setBits(bits, 50, bcd(fields.year), 8);
  setParity(bits, 36, 57, 58);
  return bits;
}

function minuteSlots(bits: readonly number[]): Dcf77Slot[] {
  const slots = bits.map((bit) => ({ highMs: bit ? 200 : 100, periodMs: 1000 }));
  slots.push({ highMs: 0, periodMs: 1000 });
  return slots;
}

export function scheduleSlots(startSample: bigint, sampleRate: number, slots: readonly Dcf77Slot[]): Dcf77Position[] {
  const positions: Dcf77Position[] = [];
  let elapsedMs = 0;
  for (const slot of slots) {
    const ss = startSample + BigInt(Math.round((elapsedMs * sampleRate) / 1000));
    elapsedMs += slot.highMs;
    const es = startSample + BigInt(Math.round((elapsedMs * sampleRate) / 1000));
    elapsedMs += slot.periodMs - slot.highMs;
    const end = startSample + BigInt(Math.round((elapsedMs * sampleRate) / 1000));
    positions.push({ ss, es, end });
  }
  return positions;
}

function summary(): ExpectedFrame {
  return { protoId: 'dcf77', kind: 'summary' };
}

function minuteAnnotation(
  positions: readonly Dcf77Position[],
  offset: number,
  first: number,
  last: number,
  classIndex: number,
): ExpectedFrame {
  return {
    ss: positions[offset + first]!.ss,
    es: positions[offset + last]!.es,
    classIndex,
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x44434637,
}: GenerationOptions = {}): Iterable<Dcf77Case> {
  const knownBits = minuteBits({
    minute: 59,
    hour: 23,
    day: 31,
    weekday: 7,
    month: 12,
    year: 99,
    special: 0x3fff,
    call: 1,
    summer: 1,
    cest: 1,
    cet: 1,
    leap: 1,
  });
  const knownSlots = [{ highMs: 0, periodMs: 2000 }, ...minuteSlots(knownBits)];
  const knownStart = 13n;
  const knownRate = 1000;
  yield {
    name: 'known-minute-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: knownRate,
    startSample: knownStart,
    channels: { data: 2 },
    options: {},
    chunkSamples: [1, 31, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const positions = scheduleSlots(knownStart, knownRate, knownSlots);
      yield {
        data: knownSlots,
        expected: [summary()],
        expectedAnnotations: [
          minuteAnnotation(positions, 1, 0, 0, 17),
          minuteAnnotation(positions, 1, 0, 0, 0),
          minuteAnnotation(positions, 1, 1, 14, 1),
          minuteAnnotation(positions, 1, 29, 34, 10),
          minuteAnnotation(positions, 1, 58, 58, 16),
        ],
        annotationCount: 76,
        payloadBits: 59,
      };
    },
  };

  const resyncBits = minuteBits({
    minute: 5,
    hour: 6,
    day: 7,
    weekday: 1,
    month: 8,
    year: 9,
  });
  const resyncSlots = [{ highMs: 0, periodMs: 300 }, { highMs: 100, periodMs: 2000 }, ...minuteSlots(resyncBits)];
  const resyncStart = 0n;
  const resyncRate = 1000;
  yield {
    name: 'unknown-bit-resynchronisation',
    kind: 'boundary',
    seed,
    sampleRate: resyncRate,
    startSample: resyncStart,
    channels: { data: 4 },
    options: {},
    chunkSamples: [7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const positions = scheduleSlots(resyncStart, resyncRate, resyncSlots);
      yield {
        data: resyncSlots,
        expected: [summary()],
        expectedAnnotations: [
          minuteAnnotation(positions, 1, 0, 0, 18),
          minuteAnnotation(positions, 2, 0, 0, 17),
          minuteAnnotation(positions, 2, 0, 0, 0),
          minuteAnnotation(positions, 2, 21, 27, 8),
        ],
        annotationCount: 77,
        payloadBits: 60,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalMinutes = Math.ceil(required / 59);
  const minutesPerBlock = 512;
  const longRate = 10;
  const longStart = 0n;
  yield {
    name: 'seeded-long-minutes',
    kind: 'long',
    seed,
    sampleRate: longRate,
    startSample: longStart,
    channels: { data: 0 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let minuteIndex = 0;
      for (let offset = 0; offset < totalMinutes; offset += minutesPerBlock) {
        const count = Math.min(minutesPerBlock, totalMinutes - offset);
        const slots: Dcf77Slot[] = offset === 0 ? [{ highMs: 0, periodMs: 2000 }] : [];
        let lastBits: readonly number[] = [];
        for (let index = 0; index < count; index++) {
          const fields: MinuteFields = {
            minute: random() % 60,
            hour: random() % 24,
            day: (random() % 28) + 1,
            weekday: (random() % 7) + 1,
            month: (random() % 12) + 1,
            year: random() % 100,
            special: random() & 0x3fff,
          };
          lastBits = minuteBits(fields);
          slots.push(...minuteSlots(lastBits));
        }
        const firstMinuteStart = longStart + BigInt(offset === 0 ? 20 : 20 + minuteIndex * MINUTE_SLOTS * longRate);
        const lastMinuteStart = firstMinuteStart + BigInt((count - 1) * MINUTE_SLOTS * longRate);
        const lastParityStart = lastMinuteStart + BigInt(58 * longRate);
        const lastParityHigh = BigInt(lastBits[58]! ? 2 : 1);
        yield {
          data: slots,
          expected: offset === 0 ? [summary()] : [],
          expectedAnnotations: [
            {
              ss: firstMinuteStart,
              es: firstMinuteStart + 1n,
              classIndex: 17,
            },
            {
              ss: lastParityStart,
              es: lastParityStart + lastParityHigh,
              classIndex: 16,
            },
          ],
          annotationCount: count * 76,
          payloadBits: count * 59,
        };
        minuteIndex += count;
      }
    },
  };
}
