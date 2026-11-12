import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface MxcOperation {
  readonly address: number;
  readonly addressBits?: 7 | 10;
  readonly direction: 'read' | 'write';
  readonly data: readonly number[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface MxcCase extends RoundtripCase<MxcOperation> {}

const SUMMARY: ExpectedFrame = { protoId: 'mxc6225xu', kind: 'summary' };
const SHAKE = ['none', 'shake left', 'shake right', 'undefined'] as const;
const ORIENTATION = [
  'vertical in upright orientation',
  'rotated 90 degrees clockwise',
  'vertical in inverted orientation',
  'rotated 90 degrees counterclockwise',
] as const;
const SHAKE_THRESHOLD = ['0.5g', '1.0g', '1.5g', '2.0g'] as const;
const COUNTS = ['16', '32', '64', '128'] as const;

function signedByte(value: number): number {
  return value & 0x80 ? value - 0x100 : value;
}

function statusText(value: number): string {
  const int = (value >> 7) & 1;
  const shake = (value >> 5) & 3;
  const tilt = (value >> 4) & 1;
  const orientation = (value >> 2) & 3;
  const rotation = value & 3;
  return (
    `INT = ${int}: Orientation ${int === 0 ? 'unchanged and no' : 'changed or'} shake event occurred\n` +
    `SH[1:0] = ${shake.toString(2)}: Shake event: ${SHAKE[shake]}\n` +
    `TILT = ${tilt}: Orientation measurement is ${tilt === 0 ? '' : 'not '}valid\n` +
    `ORI[1:0] = ${orientation.toString(2)}: ${ORIENTATION[orientation]}\n` +
    `OR[1:0] = ${rotation.toString(2)}: ${ORIENTATION[rotation]}\n`
  );
}

function detectionText(value: number): string {
  const shakeMode = (value >> 6) & 1;
  const threshold = (value >> 4) & 3;
  const shakeCount = (value >> 2) & 3;
  const orientationCount = value & 3;
  return (
    `SHM = ${shakeMode}: Set shake mode to ${shakeMode}\n` +
    `SHTH[1:0] = ${threshold.toString(2)}: Set shake threshold to ${SHAKE_THRESHOLD[threshold]}\n` +
    `SHC[1:0] = ${shakeCount.toString(2)}: Set shake count to ${COUNTS[shakeCount]} readings\n` +
    `ORC[1:0] = ${orientationCount.toString(2)}: Set orientation count to ${COUNTS[orientationCount]} readings\n`
  );
}

function annotation(classIndex: number, text: string): ExpectedFrame {
  return { classIndex, texts: [text] };
}

function readRegister(register: number, data: readonly number[]): MxcOperation[] {
  return [
    { address: 0x2a, direction: 'write', data: [register], stop: false },
    { address: 0x2a, direction: 'read', data, repeatedStart: true, stop: true },
  ];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d5843,
}: GenerationOptions = {}): Iterable<MxcCase> {
  yield {
    name: 'register-min-max-status',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 23n,
    channels: { scl: 1, sda: 4 },
    options: {},
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [1, 13, 251, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = readRegister(0x00, [0x80, 0x7f, 0xff, 0x80]);
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(0, 'XOUT: -128'),
          annotation(0, 'YOUT: 127'),
          annotation(0, statusText(0xff)),
          annotation(0, detectionText(0x80)),
        ],
        annotationCount: 4,
        payloadBits: 63,
      };
    },
  };

  yield {
    name: 'detection-thresholds',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 41n,
    channels: { scl: 0, sda: 1 },
    options: {},
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [5, 61, 509],
    minimumPayloadBits: 0,
    *generate() {
      const data: MxcOperation[] = [
        { address: 0x2a, direction: 'write', data: [0x03, 0x80], stop: true },
        { address: 0x2a, direction: 'write', data: [0x03, 0xff], stop: true },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [annotation(0, detectionText(0x80)), annotation(0, detectionText(0xff))],
        annotationCount: 2,
        payloadBits: 54,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = Math.ceil(required / 4);
  yield {
    name: 'seeded-long-orientation-stream',
    kind: 'long',
    seed,
    sampleRate: 800_000,
    startSample: 0n,
    channels: { scl: 0, sda: 1 },
    options: {},
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < 4; block++) {
        const x = random() & 0xff;
        const y = random() & 0xff;
        const status = random() & 0xff;
        const detection = random() & 0xff;
        const data: MxcOperation[] = readRegister(0x00, [x, y, status, detection]);
        let payloadBits = 63;
        const fillers = Math.ceil(Math.max(0, perBlock - payloadBits) / 27);
        for (let index = 0; index < fillers; index++)
          data.push(
            { address: 0x2a, direction: 'write', data: [0x00], stop: false },
            { address: 0x2a, direction: 'read', data: [], repeatedStart: true, stop: true },
          );
        payloadBits += fillers * 27;
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            annotation(0, `XOUT: ${signedByte(x)}`),
            annotation(0, `YOUT: ${signedByte(y)}`),
            annotation(0, statusText(status)),
            annotation(0, detectionText(detection)),
          ],
          annotationCount: 4,
          payloadBits,
        };
      }
    },
  };
}
