import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { MICROWIRE_INITIAL_IDLE_SAMPLES } from './encoder.js';

export interface MicrowireBits {
  readonly kind: 'bits';
  readonly bits: readonly number[];
  readonly soBits: readonly number[];
}

export interface MicrowireStatus {
  readonly kind: 'status';
  readonly clocks: number;
  readonly soPeriod: number;
}

export type MicrowirePacket = MicrowireBits | MicrowireStatus;

export interface MicrowireCase extends RoundtripCase<MicrowirePacket> {}

const CHANNELS = { cs: 0, sk: 1, si: 2, so: 3 } as const;
const SAMPLE_RATE = 2_000_000;

function bitAnnotations(bits: readonly number[], soBits: readonly number[]): ExpectedFrame[] {
  const result: ExpectedFrame[] = [{ classIndex: 0, texts: ['Start bit', 'S'] }];
  for (let index = 1; index < bits.length; index++) {
    result.push({
      classIndex: 1,
      texts: [`SI bit: ${bits[index]}`, `SI: ${bits[index]}`, String(bits[index])],
    });
    result.push({
      classIndex: 2,
      texts: [`SO bit: ${soBits[index]}`, `SO: ${soBits[index]}`, String(soBits[index])],
    });
  }
  return result;
}

function bitFrame(startSample: bigint, packet: MicrowireBits): ExpectedFrame {
  const csRise = startSample + BigInt(MICROWIRE_INITIAL_IDLE_SAMPLES);
  const rise = (index: number): bigint => csRise + 1n + BigInt(index * 2);
  const csFall = csRise + 1n + BigInt(packet.bits.length * 2);
  const data = Array.from({ length: packet.bits.length - 1 }, (_, offset) => {
    const index = offset + 1;
    return [
      rise(index),
      index + 1 < packet.bits.length ? rise(index + 1) : csFall,
      packet.bits[index]!,
      packet.soBits[index]!,
    ] as const;
  });
  return { ss: csRise, es: csFall, protoId: 'microwire', kind: 'protocol', data };
}

function statusAnnotations(clocks: number, soPeriod: number): ExpectedFrame[] {
  const result: ExpectedFrame[] = [];
  let previous = 0;
  for (let clock = 0; clock < clocks; clock++) {
    const level = Math.floor(clock / soPeriod) & 1;
    if (previous === 0 && level === 1) result.push({ classIndex: 4, texts: ['Busy', 'B'] });
    previous = level;
  }
  result.push(
    (Math.floor(clocks / soPeriod) & 1) === 1
      ? { classIndex: 3, texts: ['Ready', 'R'] }
      : { classIndex: 4, texts: ['Busy', 'B'] },
  );
  return result;
}

const BOUNDARY_BITS = [1, 0, 1, 1, 0, 0, 1, 0, 1] as const;
const BOUNDARY_SO = [1, 0, 0, 1, 1, 0, 1, 0, 1] as const;

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d495245,
}: GenerationOptions = {}): Iterable<MicrowireCase> {
  const boundaryStart = 23n;
  const boundaryBit: MicrowireBits = { kind: 'bits', bits: BOUNDARY_BITS, soBits: BOUNDARY_SO };
  const boundaryStatus: MicrowireStatus = { kind: 'status', clocks: 5, soPeriod: 3 };
  const boundaryData = [boundaryBit, boundaryStatus];
  yield {
    name: 'bit-packet-and-ready-status',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: boundaryStart,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 31, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: boundaryData,
        expected: [bitFrame(boundaryStart, boundaryBit)],
        expectedAnnotations: [
          ...bitAnnotations(boundaryBit.bits, boundaryBit.soBits),
          ...statusAnnotations(boundaryStatus.clocks, boundaryStatus.soPeriod),
        ],
        annotationCount: bitAnnotations(boundaryBit.bits, boundaryBit.soBits).length + 2,
        payloadBits: boundaryBit.bits.length * 2 + boundaryStatus.clocks * 4,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const statusClocks = 32_768;
  const blocks = 8;
  yield {
    name: 'seeded-long-status-and-bit-stream',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const longBit: MicrowireBits = {
          kind: 'bits',
          bits: [1, ...Array.from({ length: 8 }, () => random() & 1)],
          soBits: [0, ...Array.from({ length: 8 }, () => random() & 1)],
        };
        const status: MicrowireStatus = { kind: 'status', clocks: statusClocks, soPeriod: 4096 };
        const data = block === 0 ? [longBit, status] : [status];
        const annotations = statusAnnotations(status.clocks, status.soPeriod);
        if (block === 0) annotations.unshift(...bitAnnotations(longBit.bits, longBit.soBits));
        const payloadBits = status.clocks * 4 + (block === 0 ? longBit.bits.length * 2 : 0);
        yield {
          data,
          expected: block === 0 ? [bitFrame(0n, longBit)] : [],
          expectedAnnotations: annotations,
          annotationCount: annotations.length,
          payloadBits,
        };
      }
    },
  };
}
