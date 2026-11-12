import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { annotationTexts, getProtocolSpec, IRMP_PROTOCOLS, IrIrmpDecoder } from './index.js';
import type { IrmpFrame } from './index.js';

export interface IrIrmpCase extends RoundtripCase<IrmpFrame> {}

interface IrmpTestFrame extends IrmpFrame {
  readonly id?: string;
  readonly expected?: IrmpFrame;
}

type RawOptions = Pick<IrmpFrame, 'startMultiplier' | 'gapTicks'>;

const channels = { ir: 0 };

const inertContext: DecoderContext = {
  register: () => 0,
  put: () => {},
  hasChannel: () => false,
  channelValue: () => undefined,
  currentSample: 0n,
};

function rejectsSampleRate(sampleRate: number): boolean {
  const decoder = new IrIrmpDecoder();
  decoder.start(inertContext);
  decoder.metadata(SRD_CONF_SAMPLERATE, sampleRate);
  try {
    void decoder.decode().next();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes('multiple of library samplerate');
  }
}

function assertInvalidSampleRatesRejected(): void {
  for (const sampleRate of [8_000, 11_000, 48_000]) {
    if (!rejectsSampleRate(sampleRate)) {
      throw new Error(`IRMP decoder accepted invalid sample rate: ${sampleRate}`);
    }
  }
}

function mask(width: number): number {
  return width >= 32 ? 0xffff_ffff : 2 ** width - 1;
}

function makeFrame(protocol: number, address: number, command: number, repeat = false): IrmpTestFrame {
  const spec = getProtocolSpec(protocol);
  const frame = {
    protocol,
    address: spec.addressBits ? address & mask(spec.addressBits) : 0,
    command: spec.commandBits ? command & mask(spec.commandBits) : 0,
    repeat,
  };
  return { ...frame, expected: frame };
}

function rawBits(text: string): readonly number[] {
  if (!/^[01]+$/.test(text)) throw new Error(`Invalid IRMP raw vector: ${text}`);
  return [...text].map((bit) => Number(bit));
}

function rawVector(
  id: string,
  protocol: number,
  raw: string,
  expectedProtocol: number,
  address: number,
  command: number,
  options: RawOptions = {},
): IrmpTestFrame {
  const bits = rawBits(raw);
  return {
    id,
    protocol,
    address,
    command,
    raw: bits,
    expected: { protocol: expectedProtocol, address, command },
    ...(options.startMultiplier === undefined ? {} : { startMultiplier: options.startMultiplier }),
    ...(options.gapTicks === undefined ? {} : { gapTicks: options.gapTicks }),
  };
}

const fixedVectors: readonly IrmpTestFrame[] = Object.freeze([
  rawVector('nec-standard', 2, '00101100010010000110101010010101', 2, 0x1234, 0x56),
  rawVector('nec-apple', 11, '01110111111000010110101001011010', 11, 0x5a, 0x56),
  rawVector('nec-onkyo', 56, '00101100010010001011001111010101', 56, 0x1234, 0xabcd),
  rawVector('jvc-stop', 20, '1010001111010101', 20, 0x5, 0xabc),
  rawVector('samsung37-sync', 3, '0010110001001000001010101101010100101', 3, 0x1234, 0xa5a),
  rawVector('nec16-sync', 27, '0100100001010101', 27, 0x12, 0xaa),
  rawVector('sircs-variable-12', 1, '110001001000', 1, 0x0100, 0x123),
  rawVector('sircs-fixed-20', 1, '11000100100000000000', 1, 0x0900, 0x123),
  rawVector('netbox-press', 26, '1011010101010101', 26, 0x5, 0x2a),
  rawVector('netbox-release', 26, '1010000101010101', 26, 0x5, 0xaa),
  rawVector('rc5-double-start', 7, '0010010101010', 7, 0x12, 0x6a, { startMultiplier: 2 }),
  rawVector('rc6a-long', 21, '010000010010001101000100010101100111', 21, 0x1234, 0x4567),
  rawVector('a1tvbox-start-bit', 32, '10101101000110100', 32, 0x5a, 0x34),
  rawVector('ortek-address-shift', 33, '010101001010101000', 33, 0x15, 0x2a),
  rawVector(
    'mitsu-word-order',
    49,
    '0000000000000000000000000000000000000000111011010001001011001011001101001010100101010110',
    49,
    0x1234,
    0x56,
  ),
  rawVector('lego-crc-first', 29, '0010101010111100', 29, 0, 0x2ab),
  rawVector('kaseikyo-genre2', 5, '001011000100100000100101111010100110101010100101', 5, 0x1234, 0xa565),
  rawVector('fdc-release', 18, '0101000000000000000010000101110000000000', 18, 0x0a, 0xba),
  rawVector('vincent-duplicated-command', 50, '00010010001101000101011001010110', 50, 0x1234, 0x56),
  rawVector('metz-inverted-fields', 55, '01010100101010010101', 55, 0x5, 0x2a),
  rawVector('samsung48-gapped-command', 41, '001011000100100001101010000000000001111000000000', 41, 0x1234, 0x7856),
  rawVector('lgair-fields', 40, '0001001000110100010101100000', 40, 0x12, 0x3456),
  rawVector(
    'acp24-compressed',
    46,
    '1010011000000000000010110000000000000000000000000000000000000000001101',
    46,
    0,
    0xabcd,
  ),
  rawVector('rcmm32', 36, '00010010001101000101011001111000', 36, 0x1234, 0x5678),
  rawVector('rcmm24', 37, '000100100011010001010110', 37, 0x1234, 0x56),
  rawVector('rcmm12', 38, '101010111100', 38, 0x0a, 0xbc),
]);

if (fixedVectors.length !== 26) throw new Error(`Expected 26 IRMP fixed vectors, got ${fixedVectors.length}`);
if (IRMP_PROTOCOLS.length !== 57) throw new Error(`Expected 57 IRMP protocols, got ${IRMP_PROTOCOLS.length}`);

const fixedByWireProtocol = new Map(fixedVectors.map((frame) => [frame.protocol, frame]));

const fieldValues: Readonly<Record<number, readonly [number, number]>> = {
  8: [0x0a, 0x155],
  17: [0x2aa, 0x2aa],
  19: [0x02, 0x155],
  23: [0x1a, 0x2a],
  31: [0x00, 0x5a],
  45: [0x15, 0x2a],
  57: [0x1234, 0x05],
};

function coverageFrame(protocol: number): IrmpTestFrame {
  const fixed = fixedByWireProtocol.get(protocol);
  if (fixed) return fixed;
  const values = fieldValues[protocol];
  if (values) return makeFrame(protocol, values[0], values[1]);
  return makeFrame(protocol, 0x20 + protocol, 0x30 + protocol * 3);
}

function annotationFor(frame: IrmpTestFrame): ExpectedFrame {
  return { classIndex: 0, texts: annotationTexts(frame.expected ?? frame) };
}

function summary(): ExpectedFrame {
  return { protoId: 'ir_irmp', kind: 'summary' };
}

function payloadBits(frames: readonly IrmpFrame[]): number {
  return frames.reduce(
    (total, frame) => total + (frame.repeat ? 0 : (frame.raw?.length ?? getProtocolSpec(frame.protocol).bits)),
    0,
  );
}

function coverageFrames(): IrmpTestFrame[] {
  return IRMP_PROTOCOLS.map((spec) => coverageFrame(spec.id));
}

function withGap(frame: IrmpTestFrame, gapTicks: number): IrmpTestFrame {
  return { ...frame, gapTicks };
}

function repeatMarker(frame: IrmpTestFrame, gapTicks: number): IrmpTestFrame {
  const expected = { ...(frame.expected ?? frame), repeat: true };
  return { ...frame, repeat: true, gapTicks, expected };
}

function necRepeatFrames(gapTicks: number): IrmpTestFrame[] {
  const base = fixedByWireProtocol.get(2);
  if (!base) throw new Error('Missing NEC base vector');
  return [base, repeatMarker(base, gapTicks)];
}

function sircsSplitFrames(): IrmpTestFrame[] {
  const first = fixedVectors.find((frame) => frame.id === 'sircs-variable-12');
  if (!first) throw new Error('Missing SIRCS 12-bit vector');
  const second = rawVector('sircs-split-second', 1, '011010100010', 1, 0x0100, 0x456);
  return [first, withGap(second, 400)];
}

function boundaryCase(
  name: string,
  sampleRate: number,
  startSample: bigint,
  polarity: 'active-low' | 'active-high',
  frames: readonly IrmpTestFrame[],
  expectedAnnotations: readonly IrmpTestFrame[] = frames,
  chunkSamples: readonly number[] = [7, 127, 4093],
): IrIrmpCase {
  return {
    name,
    kind: 'boundary',
    seed: 0x4952_4d50,
    sampleRate,
    startSample,
    channels,
    options: { polarity },
    chunkSamples,
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: frames,
        expected: [summary()],
        expectedAnnotations: expectedAnnotations.map(annotationFor),
        annotationCount: expectedAnnotations.length,
        payloadBits: payloadBits(frames),
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4952_4d50,
}: GenerationOptions = {}): Iterable<IrIrmpCase> {
  assertInvalidSampleRatesRejected();

  yield boundaryCase('c-fixed-vectors', 20_000, 7n, 'active-low', fixedVectors, fixedVectors, [1, 7, 127, 4093]);

  const covered = coverageFrames();
  yield boundaryCase('all-protocols-active-low', 20_000, 7n, 'active-low', covered);
  yield boundaryCase(
    'all-protocols-active-high-large-position',
    60_000,
    9_007_199_254_740_990n,
    'active-high',
    covered,
    covered,
    [37, 257, 8191],
  );

  const acceptedRepeat = necRepeatFrames(2_300);
  yield boundaryCase(
    'nec-repeat-accepted',
    40_000,
    123_456_789n,
    'active-high',
    acceptedRepeat,
    acceptedRepeat,
    [3, 31, 1021, 8191],
  );

  const rejectedRepeat = necRepeatFrames(2_900);
  yield boundaryCase(
    'nec-repeat-rejected',
    40_000,
    123_456_789n,
    'active-high',
    rejectedRepeat,
    rejectedRepeat.slice(0, 1),
    [3, 31, 1021, 8191],
  );

  const splitSircs = sircsSplitFrames();
  yield boundaryCase('sircs-timeout-split', 20_000, 0x1234n, 'active-low', splitSircs, splitSircs, [1, 13, 257, 4093]);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerFrame = getProtocolSpec(57).bits;
  const totalFrames = Math.ceil(required / bitsPerFrame);
  const framesPerBlock = 1024;
  const blockCount = Math.ceil(totalFrames / framesPerBlock);
  yield {
    name: 'seeded-long-radio1',
    kind: 'long',
    seed,
    sampleRate: 20_000,
    startSample: 0n,
    channels,
    options: { polarity: 'active-low' },
    chunkSamples: [2048, 4096, 8192, 16384],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let remaining = totalFrames;
      for (let block = 0; block < blockCount; block++) {
        const count = Math.min(framesPerBlock, remaining);
        const data = Array.from({ length: count }, () => makeFrame(57, random() & 0xffff, random() & 0x07));
        remaining -= count;
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: [annotationFor(data[0]!)],
          annotationCount: count,
          payloadBits: count * bitsPerFrame,
        };
      }
    },
  };
}
