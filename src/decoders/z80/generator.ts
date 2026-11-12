import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export type Z80CycleKind = 'fetch' | 'memread' | 'memwrite' | 'ioread' | 'iowrite';

export interface Z80Cycle {
  readonly kind: Z80CycleKind;
  readonly address: number;
  readonly data: number;
}

export interface Z80Case extends RoundtripCase<Z80Cycle> {}

const CHANNELS = {
  d0: 0,
  d1: 1,
  d2: 2,
  d3: 3,
  d4: 4,
  d5: 5,
  d6: 6,
  d7: 7,
  m1: 8,
  rd: 9,
  wr: 10,
  mreq: 11,
  iorq: 12,
  a0: 13,
  a1: 14,
  a2: 15,
  a3: 16,
  a4: 17,
  a5: 18,
  a6: 19,
  a7: 20,
  a8: 21,
  a9: 22,
  a10: 23,
  a11: 24,
  a12: 25,
  a13: 26,
  a14: 27,
  a15: 28,
} as const;

const SAMPLE_RATE = 2_000_000;
const SUMMARY: ExpectedFrame = { protoId: 'z80', kind: 'summary' };

function fetch(address: number, data: number): Z80Cycle {
  return { kind: 'fetch', address, data };
}

function memory(address: number, data: number): Z80Cycle {
  return { kind: 'memread', address, data };
}

function write(address: number, data: number): Z80Cycle {
  return { kind: 'memwrite', address, data };
}

function ioRead(address: number, data: number): Z80Cycle {
  return { kind: 'ioread', address, data };
}

function ioWrite(address: number, data: number): Z80Cycle {
  return { kind: 'iowrite', address, data };
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

function boundaryCycles(): Z80Cycle[] {
  return [
    fetch(0x0000, 0x00),
    fetch(0x0001, 0x01),
    memory(0x0002, 0x34),
    memory(0x0003, 0x12),
    fetch(0x0004, 0xcb),
    fetch(0x0005, 0x00),
    fetch(0x0006, 0xed),
    fetch(0x0007, 0xb0),
    memory(0x1000, 0x5a),
    write(0x2000, 0xa5),
    fetch(0x0008, 0xdd),
    fetch(0x0009, 0x21),
    memory(0x000a, 0x34),
    memory(0x000b, 0x12),
    fetch(0x000c, 0xfd),
    fetch(0x000d, 0xcb),
    memory(0x000e, 0x05),
    memory(0x000f, 0x06),
    memory(0x2105, 0x3c),
    write(0x2105, 0x79),
    fetch(0x0010, 0xdb),
    memory(0x0011, 0x34),
    ioRead(0x1234, 0x5a),
    fetch(0x0012, 0xd3),
    memory(0x0013, 0x56),
    ioWrite(0x5678, 0xa5),
    fetch(0x0014, 0x34),
    memory(0x1234, 0x10),
    write(0x1234, 0x11),
    fetch(0x0015, 0x18),
    memory(0x0016, 0x02),
    fetch(0x001a, 0x00),
  ];
}

function randomInstruction(random: () => number, address: number, data: number): Z80Cycle[] {
  switch (random() % 7) {
    case 0:
      return [fetch(address, 0x00)];
    case 1:
      return [fetch(address, 0x3e), memory(address + 1, data)];
    case 2:
      return [fetch(address, 0x3c)];
    case 3:
      return [
        fetch(address, 0x32),
        memory(address + 1, data),
        memory(address + 2, random() & 0xff),
        write(address + 3, random() & 0xff),
      ];
    case 4:
      return [fetch(address, 0xdb), memory(address + 1, data), ioRead(address + 2, random() & 0xff)];
    case 5:
      return [fetch(address, 0xd3), memory(address + 1, data), ioWrite(address + 2, random() & 0xff)];
    default: {
      const register = data & 7;
      return [fetch(address, 0xcb), fetch(address + 1, register === 6 ? 7 : register)];
    }
  }
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x5a3830,
}: GenerationOptions = {}): Iterable<Z80Case> {
  yield {
    name: 'prefix-and-bus-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = boundaryCycles();
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(5, 'NOP'),
          annotation(5, 'LD BC,1234h'),
          annotation(5, 'RLC B'),
          annotation(5, 'LDIR'),
          annotation(5, 'LD IX,1234h'),
          annotation(5, 'RLC (IY+5)'),
          annotation(5, 'IN A,(34h)'),
          annotation(6, '5A'),
          annotation(5, 'OUT (56h),A'),
          annotation(7, 'A5'),
          annotation(5, 'INC (HL)'),
        ],
        payloadBits: data.length * 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const instructionsPerBlock = 16_384;
  const minimumBitsPerBlock = instructionsPerBlock * 8;
  const blocks = Math.ceil(required / minimumBitsPerBlock);
  yield {
    name: 'seeded-long-mixed-instructions',
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
      let address = 0;
      for (let block = 0; block < blocks; block++) {
        const data: Z80Cycle[] = [fetch(address, 0x00)];
        address = (address + 1) & 0xffff;
        for (let index = 1; index < instructionsPerBlock; index++) {
          const instruction = randomInstruction(random, address, random() & 0xff);
          data.push(...instruction);
          address = (address + instruction.length) & 0xffff;
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [annotation(5, 'NOP')],
          payloadBits: data.length * 8,
        };
      }
    },
  };
}
