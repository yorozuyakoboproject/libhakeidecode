import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface AvrCommand {
  readonly cmd: readonly [number, number, number, number];
  readonly ret: readonly [number, number, number, number];
}

export interface AvrCase extends RoundtripCase<AvrCommand> {}

const CHANNELS = { clk: 3, miso: 0, mosi: 7, cs: 1 } as const;
const CHAIN = [
  {
    decoder: 'spi',
    options: {
      cs_polarity: 'active-low',
      cpol: 0,
      cpha: 0,
      bitorder: 'msb-first',
      wordsize: 8,
    },
  },
] as const;
const SUMMARY: ExpectedFrame = { protoId: 'avr_isp', kind: 'summary' };

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x41565249,
}: GenerationOptions = {}): Iterable<AvrCase> {
  yield {
    name: 'boundary-commands-devices-and-warnings',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data: AvrCommand[] = [
        { cmd: [0xac, 0x53, 0x00, 0x00], ret: [0x00, 0xac, 0x53, 0x00] },
        { cmd: [0x30, 0x00, 0x00, 0x00], ret: [0x00, 0x30, 0x00, 0x1e] },
        { cmd: [0x30, 0x00, 0x01, 0x00], ret: [0x00, 0x30, 0x00, 0x93] },
        { cmd: [0x30, 0x00, 0x02, 0x0b], ret: [0x00, 0x30, 0x00, 0x0b] },
        { cmd: [0xac, 0x80, 0x11, 0x00], ret: [0x00, 0xac, 0x80, 0x11] },
        { cmd: [0x50, 0x00, 0x00, 0x00], ret: [0x00, 0x00, 0x00, 0x62] },
        { cmd: [0x58, 0x08, 0x00, 0x00], ret: [0x00, 0x00, 0x00, 0xd9] },
        { cmd: [0x50, 0x08, 0x00, 0x00], ret: [0x00, 0x00, 0x00, 0xff] },
        { cmd: [0x58, 0x00, 0x00, 0x00], ret: [0x00, 0x00, 0x00, 0x3f] },
        { cmd: [0xa0, 0x00, 0x00, 0x00], ret: [0x00, 0x00, 0x00, 0x00] },
        { cmd: [0xa0, 0x01, 0xff, 0x00], ret: [0x00, 0x00, 0x00, 0xff] },
        { cmd: [0x20, 0x00, 0x00, 0x00], ret: [0x00, 0x00, 0x00, 0x00] },
        { cmd: [0x28, 0x0f, 0xff, 0x00], ret: [0x00, 0x00, 0x00, 0xff] },
        { cmd: [0x40, 0x00, 0x00, 0xff], ret: [0x00, 0x00, 0x00, 0x00] },
        { cmd: [0x48, 0x00, 0x1f, 0x80], ret: [0x00, 0x00, 0x00, 0x00] },
        { cmd: [0x4c, 0x0f, 0xff, 0x00], ret: [0x00, 0x00, 0x00, 0x00] },
        { cmd: [0x11, 0x22, 0x33, 0x44], ret: [0xaa, 0xbb, 0xcc, 0xdd] },
        { cmd: [0xac, 0x53, 0x01, 0x02], ret: [0x00, 0xac, 0x00, 0x00] },
        { cmd: [0xac, 0x80, 0x00, 0x00], ret: [0x00, 0x00, 0x00, 0x00] },
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        { classIndex: 0, texts: ['Programming enable'] },
        { classIndex: 1, texts: ['Vendor code: 0x1e (Atmel)'] },
        { classIndex: 2, texts: ['Part family / memory size: 0x93'] },
        { classIndex: 3, texts: ['Part number: 0x0b'] },
        { classIndex: 14, texts: ['Device: Atmel ATtiny85'] },
        { classIndex: 4, texts: ['Chip erase'] },
        { classIndex: 5, texts: ['Read fuse bits: 0x62'] },
        { classIndex: 6, texts: ['Read fuse high bits: 0xd9'] },
        { classIndex: 7, texts: ['Read extended fuse bits: 0xff'] },
        { classIndex: 8, texts: ['Read lock bits: 0x3f'] },
        { classIndex: 9, texts: ['Read EEPROM Memory: [0x000]: 0x00'] },
        { classIndex: 9, texts: ['Read EEPROM Memory: [0x1ff]: 0xff'] },
        { classIndex: 10, texts: ['Read program memory Low: [0x000]: 0x00', '[000L]:00', '00'] },
        { classIndex: 10, texts: ['Read program memory High: [0xfff]: 0xff', '[fffH]:ff', 'ff'] },
        { classIndex: 11, texts: ['Load program memory page Low: [0x000]: 0xff', '[000L]=ff', 'ff'] },
        { classIndex: 11, texts: ['Load program memory page High: [0x01f]: 0x80', '[01fH]=80', '80'] },
        { classIndex: 12, texts: ['Write program memory page: 0x2058'] },
        { classIndex: 13, texts: ['Unknown command: 11 22 33 44 (reply: aa bb cc dd)!'] },
        { classIndex: 0, texts: ['Programming enable'] },
        { classIndex: 13, texts: ['Warning: Unexpected bytes in reply!'] },
        { classIndex: 4, texts: ['Chip erase'] },
        { classIndex: 13, texts: ['Warning: Unexpected bytes in reply!'] },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 32,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    total = Math.ceil(required / 32),
    perBlock = 8192,
    blocks = Math.ceil(total / perBlock);
  yield {
    name: 'seeded-long-fuse-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: AvrCommand[] = [];
        for (let index = block * perBlock; index < Math.min(total, (block + 1) * perBlock); index++)
          data.push({
            cmd: [0x50, 0x00, 0x00, 0x00],
            ret: [0x00, 0x00, 0x00, random() & 0xff],
          });
        const expectedAnnotations = [
          { classIndex: 5, texts: [`Read fuse bits: 0x${hex(data[0]!.ret[3])}`] },
        ] satisfies ExpectedFrame[];
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: data.length,
          payloadBits: data.length * 32,
        };
      }
    },
  };
}
