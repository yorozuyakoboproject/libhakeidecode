import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface AvrPdiFrame {
  readonly bits: readonly number[];
}

export interface AvrPdiCase extends RoundtripCase<AvrPdiFrame> {}

const CHANNELS = { reset: 0, data: 1 } as const;
const SUMMARY: ExpectedFrame = { protoId: 'avr_pdi', kind: 'summary' };

function bitCount(value: number): number {
  let count = 0;
  for (; value; value >>>= 1) count += value & 1;
  return count;
}

function uartFrame(value: number, goodParity = true, stop = 1): AvrPdiFrame {
  const bits = [0];
  for (let index = 0; index < 8; index++) bits.push((value >>> index) & 1);
  bits.push((bitCount(value) & 1) ^ (goodParity ? 0 : 1), stop);
  return { bits };
}

function breakFrame(): AvrPdiFrame {
  return { bits: [...Array.from({ length: 11 }, () => 0), 1] };
}

function instruction(opcode: number, argument = 0): AvrPdiFrame {
  return uartFrame((opcode << 5) | (argument & 0x0f));
}

function instructionFrames(opcode: number, argument: number, bytes: readonly number[]): AvrPdiFrame[] {
  return [instruction(opcode, argument), ...bytes.map((value) => uartFrame(value))];
}

function opcodeAnnotation(texts: readonly string[]): ExpectedFrame {
  return { classIndex: 8, texts };
}

function dataAnnotation(texts: readonly string[]): ExpectedFrame {
  return { classIndex: 9, texts };
}

function deviceDataAnnotation(texts: readonly string[]): ExpectedFrame {
  return { classIndex: 10, texts };
}

function commandAnnotation(texts: readonly string[]): ExpectedFrame {
  return { classIndex: 14, texts };
}

function options(): Record<string, string> {
  return {};
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x50444931,
}: GenerationOptions = {}): Iterable<AvrPdiCase> {
  yield {
    name: 'instructions-and-repeated-operands',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_000n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = [
        ...instructionFrames(0, 0b0101, [0x34, 0x12, 0xcd, 0xab]),
        ...instructionFrames(1, 0, [0x5a]),
        ...instructionFrames(2, 0b0010, [0x7f, 0x01, 0x02, 0x03]),
        ...instructionFrames(3, 0, [0x42]),
        ...instructionFrames(4, 2, [0x11]),
        ...instructionFrames(5, 1, [0x02, 0x00]),
        ...instructionFrames(1, 0, [0x21, 0x22, 0x23]),
        ...instructionFrames(6, 0, [0xaa]),
        ...instructionFrames(7, 0, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        opcodeAnnotation(['Insn: LDS a2, m2', 'LDS a2, m2', 'LDS']),
        dataAnnotation(['Data: 0x1234', '0x1234', '1234']),
        deviceDataAnnotation(['Data: 0xabcd', '0xabcd', 'abcd']),
        commandAnnotation(['LDS 0x1234 0xabcd', 'LDS 1234 abcd']),
        opcodeAnnotation(['Insn: LD *(ptr) m1', 'LD *(ptr) m1', 'LD']),
        deviceDataAnnotation(['Data: 0x5a', '0x5a', '5a']),
        commandAnnotation(['LD *(ptr) 0x5a', 'LD *p 5a']),
        opcodeAnnotation(['Insn: STS a1, i3', 'STS a1, i3', 'STS']),
        dataAnnotation(['Data: 0x7f', '0x7f', '7f']),
        dataAnnotation(['Data: 0x030201', '0x030201', '030201']),
        commandAnnotation(['STS 0x7f 0x030201', 'STS 7f 030201']),
        opcodeAnnotation(['Insn: ST *(ptr) i1', 'ST *(ptr) i1', 'ST']),
        dataAnnotation(['Data: 0x42', '0x42', '42']),
        commandAnnotation(['ST *(ptr) 0x42', 'ST *p 42']),
        opcodeAnnotation(['Insn: LDCS ctrl, m1', 'LDCS ctrl, m1', 'LDCS']),
        deviceDataAnnotation(['Data: 0x11', '0x11', '11']),
        commandAnnotation(['LDCS ctrl 0x11', 'LDCS 2 11']),
        opcodeAnnotation(['Insn: REPEAT i2', 'REPEAT i2', 'REP']),
        dataAnnotation(['Data: 0x0002', '0x0002', '0002']),
        commandAnnotation(['REPEAT 0x0002', 'REP 0002']),
        opcodeAnnotation(['Insn: LD *(ptr) m1', 'LD *(ptr) m1', 'LD']),
        deviceDataAnnotation(['Data: 0x21', '0x21', '21']),
        deviceDataAnnotation(['Data: 0x22', '0x22', '22']),
        deviceDataAnnotation(['Data: 0x23', '0x23', '23']),
        commandAnnotation(['LD *(ptr) 0x21 0x22 0x23', 'LD *p 21 22 23']),
        opcodeAnnotation(['Insn: STCS status, i1', 'STCS status, i1', 'STCS']),
        dataAnnotation(['Data: 0xaa', '0xaa', 'aa']),
        commandAnnotation(['STCS status 0xaa', 'STCS 0 aa']),
        opcodeAnnotation(['Insn: KEY i8', 'KEY i8', 'KEY']),
        dataAnnotation(['Data: 0xefcdab8967452301', '0xefcdab8967452301', 'efcdab8967452301']),
        commandAnnotation(['KEY 0xefcdab8967452301', 'KEY efcdab8967452301']),
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 541,
        payloadBits: data.reduce((sum, item) => sum + item.bits.length, 0),
      };
    },
  };

  yield {
    name: 'frame-errors-and-break',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 17n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [3, 31, 2047],
    minimumPayloadBits: 0,
    *generate() {
      const data = [uartFrame(0x55, false), uartFrame(0xaa, true, 0), breakFrame()];
      const expectedAnnotations: ExpectedFrame[] = [
        { classIndex: 4, texts: ['Parity error', 'Par ERR', 'PE'] },
        { classIndex: 2, texts: ['Data: aa', 'D: aa', 'aa'] },
        { classIndex: 6, texts: ['Stop bit error', 'Stop ERR', 'TE'] },
        { classIndex: 7, texts: ['Break condition', 'BREAK', 'BRK'] },
        { classIndex: 14, texts: ['BREAK', 'BRK'] },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 32,
        payloadBits: data.reduce((sum, item) => sum + item.bits.length, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bitsPerInstruction = 22,
    instructions = Math.ceil(required / bitsPerInstruction),
    perBlock = 4_096;
  yield {
    name: 'seeded-long-status-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < instructions; offset += perBlock) {
        const count = Math.min(perBlock, instructions - offset),
          data: AvrPdiFrame[] = [];
        for (let index = 0; index < count; index++) {
          data.push(instruction(6, 0), uartFrame(random() & 0xff));
        }
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations: [opcodeAnnotation(['Insn: STCS status, i1', 'STCS status, i1', 'STCS'])],
          annotationCount: count * 33,
          payloadBits: count * bitsPerInstruction,
        };
      }
    },
  };
}
