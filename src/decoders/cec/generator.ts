import { MIN_PAYLOAD_BITS } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { cecFrameText, cecSectionText } from './index.js';

export interface CecMessage {
  readonly bytes: readonly number[];
  readonly acks?: readonly boolean[];
  readonly eoms?: readonly boolean[];
}

export interface CecCase extends RoundtripCase<CecMessage> {}

const SUMMARY: ExpectedFrame = { protoId: 'cec', kind: 'summary' };

function messageAnnotations(message: CecMessage): ExpectedFrame[] {
  const acks = message.acks ?? [];
  const eoms = message.eoms ?? [];
  const result: ExpectedFrame[] = [{ classIndex: 0, texts: ['ST'] }];
  const used: number[] = [];
  let nack = false;
  for (let index = 0; index < message.bytes.length; index++) {
    const value = message.bytes[index]!;
    const eom = eoms[index] ?? index === message.bytes.length - 1;
    const ack = acks[index] ?? true;
    for (let bit = 7; bit >= 0; bit--) result.push({ classIndex: 5, texts: [String((value >>> bit) & 1)] });
    result.push({ classIndex: 6, texts: [`0x${value.toString(16).padStart(2, '0')}`] });
    result.push({ classIndex: eom ? 2 : 1, texts: [eom ? 'EOM=Y' : 'EOM=N'] });
    result.push({ classIndex: ack ? 4 : 3, texts: [ack ? 'ACK' : 'NACK'] });
    used.push(value);
    if (!ack) nack = true;
    if (eom || !ack) break;
  }
  result.push({ classIndex: 7, texts: [cecFrameText(used)] });
  result.push({
    classIndex: 8,
    texts: [cecSectionText(used, eoms[used.length - 1] ?? used.length === message.bytes.length, nack)],
  });
  return result;
}

function annotations(messages: readonly CecMessage[]): ExpectedFrame[] {
  return messages.flatMap(messageAnnotations);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x434543,
}: GenerationOptions = {}): Iterable<CecCase> {
  const boundaryMessages = [
    { bytes: [0x40, 0x36] },
    { bytes: [0x0f, 0x82, 0x10, 0x00] },
    { bytes: [0x50, 0x44], acks: [true, false] },
    { bytes: [0x8f], acks: [false] },
  ];
  yield {
    name: 'frames-broadcast-ping-and-nack',
    kind: 'boundary',
    seed,
    sampleRate: 2_000,
    startSample: 17n,
    channels: { cec: 0 },
    options: {},
    chunkSamples: [1, 7, 31, 257],
    minimumPayloadBits: 0,
    *generate() {
      const expected = annotations(boundaryMessages);
      yield {
        data: boundaryMessages,
        expected: [SUMMARY],
        expectedAnnotations: expected.slice(0, 12).concat(expected.slice(-6)),
        annotationCount: expected.length,
        payloadBits: boundaryMessages.reduce((sum, item) => sum + item.bytes.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bytesPerMessage = 64;
  const messagesPerBlock = 1024;
  const makeMessage = (offset: number): CecMessage => ({
    bytes: Array.from({ length: bytesPerMessage }, (_, index) => (offset + index * 37) & 0xff),
  });
  const blocks = Math.ceil(required / (messagesPerBlock * bytesPerMessage * 8));
  yield {
    name: 'seeded-long-multi-frame',
    kind: 'long',
    seed,
    sampleRate: 2_000,
    startSample: 0n,
    channels: { cec: 0 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      for (let block = 0; block < blocks; block++) {
        const messages = Array.from({ length: messagesPerBlock }, (_, index) =>
          makeMessage(block * messagesPerBlock + index),
        );
        const first = messageAnnotations(messages[0]!).filter(
          (item) => item.classIndex === 0 || item.classIndex === 7 || item.classIndex === 8,
        );
        yield {
          data: messages,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: first,
          annotationCount: messages.length * (bytesPerMessage * 11 + 3),
          payloadBits: messages.length * bytesPerMessage * 8,
        };
      }
    },
  };
}
