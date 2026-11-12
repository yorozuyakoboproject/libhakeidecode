import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface MapleFrame {
  readonly bytes: readonly number[];
  readonly startPulses: 4 | 6;
}

export interface MapleCase extends RoundtripCase<MapleFrame> {}

const CHANNELS = { sdcka: 0, sdckb: 1 } as const;
const SAMPLE_RATE = 4_000_000;
const FIELD_NAMES = [['Size', 'L'], ['SrcAP', 'S'], ['DstAP', 'D'], ['Cmd', 'C'], ['Data'], ['Cksum', 'K']] as const;

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function checksum(bytes: readonly number[], length: number): number {
  return bytes.slice(0, length).reduce((value, byte) => value ^ byte, 0);
}

function fieldAnnotation(bytes: readonly number[], index: number, expectedLength: number): ExpectedFrame {
  const bintype = index < 4 ? index : index === expectedLength ? 5 : 4;
  return {
    classIndex: bintype + 6,
    texts: [...FIELD_NAMES[bintype]!.map((name) => `${name}: ${hex(bytes[index]!)}`), hex(bytes[index]!)],
  };
}

function frameAnnotations(frame: MapleFrame): ExpectedFrame[] {
  const result: ExpectedFrame[] = [
    frame.startPulses === 4
      ? { classIndex: 0, texts: ['Start pattern', 'Start', 'S'] }
      : { classIndex: 2, texts: ['Start pattern with CRC', 'Start CRC', 'SC'] },
  ];
  const expectedLength = 4 * ((frame.bytes[0] ?? 0) + 1);
  for (let index = 0; index < frame.bytes.length; index++) {
    const bintype = index < 4 ? index : index === expectedLength ? 5 : 4;
    if (bintype === 4) continue;
    if (bintype === 5 && frame.bytes[index] !== checksum(frame.bytes, index))
      result.push({ classIndex: 13, texts: ['Cksum error', 'K error', 'KE'] });
    result.push(fieldAnnotation(frame.bytes, index, expectedLength));
  }
  result.push({ classIndex: 1, texts: ['End pattern', 'End', 'E'] });
  if (frame.bytes.length !== expectedLength + 1)
    result.push({ classIndex: 14, texts: ['Size error', 'L error', 'LE'] });
  return result;
}

function annotationCount(frame: MapleFrame): number {
  const expectedLength = 4 * ((frame.bytes[0] ?? 0) + 1);
  let count = 2 + frame.bytes.length * 9;
  if (frame.bytes.length > expectedLength && frame.bytes[expectedLength] !== checksum(frame.bytes, expectedLength))
    count++;
  if (frame.bytes.length !== expectedLength + 1) count++;
  return count;
}

const BOUNDARY_FRAMES: readonly MapleFrame[] = [
  { bytes: [0, 0x10, 0x20, 0x05, 0x35], startPulses: 4 },
  { bytes: [1, 0x04, 0x01, 0x02, 0x5a, 0x33, 0x0f, 0xf0, 0x90], startPulses: 6 },
  { bytes: [0, 0x11, 0x22, 0x33, 0x01], startPulses: 4 },
  { bytes: [1, 0x00, 0x01, 0x02, 0x03], startPulses: 4 },
];

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d41504c,
}: GenerationOptions = {}): Iterable<MapleCase> {
  yield {
    name: 'start-checksum-and-size-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 67n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 31, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: BOUNDARY_FRAMES,
        expected: [{ protoId: 'maple_bus', kind: 'summary' }],
        expectedAnnotations: BOUNDARY_FRAMES.flatMap(frameAnnotations),
        annotationCount: BOUNDARY_FRAMES.reduce((sum, frame) => sum + annotationCount(frame), 0),
        payloadBits: BOUNDARY_FRAMES.reduce((sum, frame) => sum + frame.bytes.length * 16, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const framesPerBlock = 128;
  const words = 16;
  const payloadBytes = words * 4;
  const blocks = 8;
  yield {
    name: 'seeded-long-full-frames',
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
        const data: MapleFrame[] = [];
        for (let index = 0; index < framesPerBlock; index++) {
          const bytes = [words, random() & 0xff, random() & 0xff, random() & 0xff];
          for (let byte = 0; byte < payloadBytes; byte++) bytes.push(random() & 0xff);
          bytes.push(checksum(bytes, bytes.length));
          data.push({ bytes, startPulses: 4 });
        }
        yield {
          data,
          expected: block === 0 ? [{ protoId: 'maple_bus', kind: 'summary' }] : [],
          expectedAnnotations: [
            { classIndex: 0, texts: ['Start pattern', 'Start', 'S'] },
            fieldAnnotation(data[0]!.bytes, 0, 4 * (words + 1)),
          ],
          annotationCount: data.reduce((sum, frame) => sum + annotationCount(frame), 0),
          payloadBits: data.reduce((sum, frame) => sum + frame.bytes.length * 16, 0),
        };
      }
    },
  };
}
