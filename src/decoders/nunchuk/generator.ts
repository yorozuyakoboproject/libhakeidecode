import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface NunchukOperation {
  readonly address: number;
  readonly addressBits?: 7 | 10;
  readonly direction: 'read' | 'write';
  readonly data: readonly number[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface NunchukCase extends RoundtripCase<NunchukOperation> {}

const SUMMARY: ExpectedFrame = { protoId: 'nunchuk', kind: 'summary' };

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

function readAnnotations(data: readonly number[]): ExpectedFrame[] {
  const sx = data[0]!;
  const sy = data[1]!;
  const axHigh = data[2]! << 2;
  const ayHigh = data[3]! << 2;
  const azHigh = data[4]! << 2;
  const aux = data[5]!;
  const bz = aux & 1;
  const bc = (aux >> 1) & 1;
  const axRest = (aux >> 2) & 3;
  const ayRest = (aux >> 4) & 3;
  const azRest = (aux >> 6) & 3;
  const ax = axHigh | axRest;
  const ay = ayHigh | ayRest;
  const az = azHigh | azRest;
  const z = bz === 0 ? 'pressed' : 'not pressed';
  const c = bc === 0 ? 'pressed' : 'not pressed';
  return [
    annotation(0, `Analog stick X position: 0x${hex(sx, 2)}`, `SX: 0x${hex(sx, 2)}`),
    annotation(1, `Analog stick Y position: 0x${hex(sy, 2)}`, `SY: 0x${hex(sy, 2)}`),
    annotation(2, `Accelerometer X value bits[9:2]: 0x${hex(axHigh, 3)}`, `AX[9:2]: 0x${hex(axHigh, 3)}`),
    annotation(3, `Accelerometer Y value bits[9:2]: 0x${hex(ayHigh, 3)}`, `AY[9:2]: 0x${hex(ayHigh, 3)}`),
    annotation(4, `Accelerometer Z value bits[9:2]: 0x${hex(azHigh, 3)}`, `AZ[9:2]: 0x${hex(azHigh, 3)}`),
    annotation(6, `Z: ${bz === 0 ? '' : 'not '}pressed`, `BZ: ${bz}`),
    annotation(7, `C: ${bc === 0 ? '' : 'not '}pressed`, `BC: ${bc}`),
    annotation(
      8,
      `Accelerometer X value bits[1:0]: 0x${axRest.toString(16).toUpperCase()}`,
      `AX[1:0]: 0x${axRest.toString(16).toUpperCase()}`,
    ),
    annotation(
      9,
      `Accelerometer Y value bits[1:0]: 0x${ayRest.toString(16).toUpperCase()}`,
      `AY[1:0]: 0x${ayRest.toString(16).toUpperCase()}`,
    ),
    annotation(
      10,
      `Accelerometer Z value bits[1:0]: 0x${azRest.toString(16).toUpperCase()}`,
      `AZ[1:0]: 0x${azRest.toString(16).toUpperCase()}`,
    ),
    annotation(13, `Analog stick: ${sx}/${sy}, accelerometer: ${ax}/${ay}/${az}, Z: ${z}, C: ${c}`),
  ];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4e554e,
}: GenerationOptions = {}): Iterable<NunchukCase> {
  yield {
    name: 'init-and-full-read',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 19n,
    channels: { scl: 2, sda: 6 },
    options: {},
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: NunchukOperation[] = [
        { address: 0x52, direction: 'write', data: [0x40, 0x00], stop: true },
        { address: 0x52, direction: 'read', data: [0x80, 0x7f, 0x10, 0x20, 0x30, 0x00], stop: true },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(11, 'Nunchuk write: 0x40'),
          annotation(11, 'Nunchuk write: 0x00'),
          annotation(12, 'Initialize Nunchuk', 'Init Nunchuk', 'Init', 'I'),
          ...readAnnotations([0x80, 0x7f, 0x10, 0x20, 0x30, 0x00]),
        ],
        annotationCount: 14,
        payloadBits: 90,
      };
    },
  };

  yield {
    name: 'short-init-warning',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 37n,
    channels: { scl: 0, sda: 1 },
    options: {},
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [3, 29, 509],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: [{ address: 0x52, direction: 'write', data: [0x40], stop: true }] as NunchukOperation[],
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(11, 'Nunchuk write: 0x40'),
          annotation(14, 'Init sequence was 1 bytes long (2 expected)'),
        ],
        annotationCount: 2,
        payloadBits: 18,
      };
    },
  };

  yield {
    name: 'unknown-init-warning',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 43n,
    channels: { scl: 1, sda: 3 },
    options: {},
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [7, 67, 1021],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: [{ address: 0x52, direction: 'write', data: [0x40, 0x01], stop: true }] as NunchukOperation[],
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(11, 'Nunchuk write: 0x40'),
          annotation(11, 'Nunchuk write: 0x01'),
          annotation(14, 'Unknown init sequence (expected: 0x40 0x00)'),
        ],
        annotationCount: 3,
        payloadBits: 27,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = Math.ceil(required / 4);
  yield {
    name: 'seeded-long-read-stream',
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
        const bytes = block === 0 ? Array.from({ length: 6 }, () => random() & 0xff) : null;
        const data: NunchukOperation[] = bytes
          ? [{ address: 0x52, direction: 'read', data: bytes, stop: true }]
          : [{ address: 0x52, direction: 'write', data: [0x40, 0x00], stop: true }];
        const expectedAnnotations = bytes
          ? readAnnotations(bytes)
          : [
              annotation(11, 'Nunchuk write: 0x40'),
              annotation(11, 'Nunchuk write: 0x00'),
              annotation(12, 'Initialize Nunchuk', 'Init Nunchuk', 'Init', 'I'),
            ];
        let payloadBits = bytes ? 63 : 27;
        const fillers = Math.ceil(Math.max(0, perBlock - payloadBits) / 18);
        for (let index = 0; index < fillers; index++)
          data.push({ address: 0x52, addressBits: 10, direction: 'read', data: [], stop: true });
        payloadBits += fillers * 18;
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits,
        };
      }
    },
  };
}
