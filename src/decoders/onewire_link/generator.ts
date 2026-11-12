import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface OnewireResetOperation {
  readonly kind: 'reset';
  readonly presence: boolean;
  readonly overdrive?: boolean;
}

export interface OnewireBitsOperation {
  readonly kind: 'bits';
  readonly bits: readonly number[];
  readonly overdrive?: boolean;
}

export type OnewireOperation = OnewireResetOperation | OnewireBitsOperation;
export interface OnewireCase extends RoundtripCase<OnewireOperation> {}

const LEAD_US = 10;
const FINISH_US = 20;
const NORMAL = {
  resetLow: 500,
  resetHigh: 500,
  presenceDelay: 30,
  presenceLow: 120,
  bitPeriod: 70,
  bitOneLow: 6,
  bitZeroLow: 30,
  slotEnd: 60,
  presenceTimeout: 480,
  presenceWindow: 60,
} as const;
const OVERDRIVE = {
  resetLow: 60,
  resetHigh: 70,
  presenceDelay: 2,
  presenceLow: 10,
  bitPeriod: 10,
  bitOneLow: 1,
  bitZeroLow: 8,
  slotEnd: 6,
  presenceTimeout: 48,
  presenceWindow: 6,
} as const;

export interface OnewireResetTiming {
  readonly fall: bigint;
  readonly rise: bigint;
  readonly presenceStart: bigint | null;
  readonly presenceEnd: bigint | null;
  readonly presencePacketEnd: bigint;
  readonly end: bigint;
}

export interface OnewireBitTiming {
  readonly fall: bigint;
  readonly rise: bigint;
  readonly slotEnd: bigint;
  readonly end: bigint;
}

export class OnewireTimeline {
  private readonly startSample: bigint;
  private readonly sampleRate: number;
  private cursor = LEAD_US;

  constructor(config: Pick<RoundtripCase<unknown>, 'startSample' | 'sampleRate'>) {
    this.startSample = config.startSample;
    this.sampleRate = config.sampleRate;
  }

  private sample(microseconds: number): bigint {
    return this.startSample + BigInt(Math.round((microseconds * this.sampleRate) / 1_000_000));
  }

  reset(operation: OnewireResetOperation): OnewireResetTiming {
    const timing = operation.overdrive ? OVERDRIVE : NORMAL;
    const fall = this.sample(this.cursor),
      rise = this.sample(this.cursor + timing.resetLow),
      presenceStart = operation.presence ? this.sample(this.cursor + timing.resetLow + timing.presenceDelay) : null,
      presenceEnd = operation.presence
        ? this.sample(this.cursor + timing.resetLow + timing.presenceDelay + timing.presenceLow)
        : null,
      presencePacketEnd = this.sample(
        this.cursor + timing.resetLow + (operation.presence ? timing.presenceTimeout : timing.presenceWindow),
      ),
      end = this.sample(this.cursor + timing.resetLow + timing.resetHigh);
    this.cursor += timing.resetLow + timing.resetHigh;
    return { fall, rise, presenceStart, presenceEnd, presencePacketEnd, end };
  }

  bits(operation: OnewireBitsOperation): OnewireBitTiming[] {
    const timing = operation.overdrive ? OVERDRIVE : NORMAL,
      result: OnewireBitTiming[] = [];
    for (const bit of operation.bits) {
      const fall = this.sample(this.cursor),
        rise = this.sample(this.cursor + (bit ? timing.bitOneLow : timing.bitZeroLow)),
        slotEnd = rise > this.sample(this.cursor + timing.slotEnd) ? rise : this.sample(this.cursor + timing.slotEnd),
        end = this.sample(this.cursor + timing.bitPeriod);
      result.push({ fall, rise, slotEnd, end });
      this.cursor += timing.bitPeriod;
    }
    return result;
  }

  finish(): bigint {
    return this.sample(this.cursor + FINISH_US);
  }
}

export function bitsFromBytes(bytes: readonly number[]): number[] {
  const result: number[] = [];
  for (const byte of bytes) for (let bit = 0; bit < 8; bit++) result.push((byte >>> bit) & 1);
  return result;
}

export function bitsFromBigInt(value: bigint, length: number): number[] {
  return Array.from({ length }, (_, bit) => Number((value >> BigInt(bit)) & 1n));
}

export function linkFrames(operations: readonly OnewireOperation[], timeline: OnewireTimeline): ExpectedFrame[] {
  const frames: ExpectedFrame[] = [];
  for (const operation of operations) {
    if (operation.kind === 'reset') {
      const event = timeline.reset(operation);
      frames.push({
        ss: event.rise,
        es: event.presencePacketEnd,
        protoId: 'onewire_link',
        kind: 'protocol',
        data: ['RESET/PRESENCE', operation.presence],
      });
    } else {
      const events = timeline.bits(operation);
      for (let index = 0; index < operation.bits.length; index++) {
        frames.push({
          ss: events[index]!.fall,
          es: events[index]!.slotEnd,
          protoId: 'onewire_link',
          kind: 'protocol',
          data: ['BIT', operation.bits[index]!],
        });
      }
    }
  }
  return frames;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x31574952,
}: GenerationOptions = {}): Iterable<OnewireCase> {
  yield {
    name: 'normal-presence-and-bit-levels',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { owr: 0 },
    options: { overdrive: 'no' },
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: OnewireOperation[] = [
          { kind: 'reset', presence: false },
          { kind: 'bits', bits: [1, 0, 1, 1, 0, 0, 1, 0] },
          { kind: 'reset', presence: true },
          { kind: 'bits', bits: [0, 0, 0, 0, 0, 0, 0, 0] },
          { kind: 'bits', bits: [1, 1, 1, 1, 1, 1, 1, 1] },
        ],
        timeline = new OnewireTimeline({
          startSample: 9_007_199_254_740_990n,
          sampleRate: 1_000_000,
        }),
        expected = linkFrames(data, timeline);
      yield {
        data,
        expected,
        expectedAnnotations: [
          { classIndex: 2, texts: ['Reset', 'Rst', 'R'] },
          { classIndex: 3, texts: ['Presence: false', 'Presence', 'Pres', 'P'] },
          { classIndex: 0, texts: ['Bit: 1', '1'] },
          { classIndex: 0, texts: ['Bit: 0', '0'] },
          { classIndex: 3, texts: ['Presence: true', 'Presence', 'Pres', 'P'] },
        ],
        annotationCount: data.reduce(
          (count, operation) => count + (operation.kind === 'reset' ? 2 : operation.bits.length),
          0,
        ),
        payloadBits: data.reduce(
          (count, operation) => count + (operation.kind === 'bits' ? operation.bits.length : 0),
          0,
        ),
      };
    },
  };

  yield {
    name: 'overdrive-entry-and-exit',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 17n,
    channels: { owr: 4 },
    options: { overdrive: 'yes' },
    chunkSamples: [31, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: OnewireOperation[] = [
          { kind: 'reset', presence: true, overdrive: true },
          { kind: 'bits', bits: bitsFromBytes([0x3c]), overdrive: true },
          { kind: 'bits', bits: bitsFromBytes([0x69]), overdrive: true },
          { kind: 'reset', presence: true, overdrive: false },
          { kind: 'bits', bits: bitsFromBytes([0xaa, 0x55]) },
        ],
        timeline = new OnewireTimeline({ startSample: 17n, sampleRate: 2_000_000 }),
        expected = linkFrames(data, timeline);
      yield {
        data,
        expected,
        expectedAnnotations: [
          {
            classIndex: 1,
            texts: ['Sampling rate is suggested to be above 5MHz for proper overdrive mode decoding.'],
          },
          { classIndex: 4, texts: ['Entering overdrive mode', 'Overdrive on'] },
          { classIndex: 4, texts: ['Exiting overdrive mode', 'Overdrive off'] },
        ],
        annotationCount: 3 + 2 + 8 + 8 + 2 + 16,
        payloadBits: 32,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bitsPerBlock = 3072,
    blocks = Math.ceil(required / bitsPerBlock);
  yield {
    name: 'seeded-long-overdrive-bits',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { owr: 3 },
    options: { overdrive: 'yes' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed),
        timeline = new OnewireTimeline({ startSample: 0n, sampleRate: 2_000_000 });
      for (let block = 0; block < blocks; block++) {
        const bits = Array.from({ length: bitsPerBlock }, () => random() & 1),
          operation: OnewireBitsOperation = { kind: 'bits', bits, overdrive: true },
          expected = linkFrames([operation], timeline);
        yield {
          data: [operation],
          expected,
          expectedAnnotations:
            block === 0
              ? [
                  {
                    classIndex: 1,
                    texts: ['Sampling rate is suggested to be above 5MHz for proper overdrive mode decoding.'],
                  },
                ]
              : [],
          annotationCount: bits.length + (block === 0 ? 1 : 0),
          payloadBits: bits.length,
        };
      }
    },
  };
}
