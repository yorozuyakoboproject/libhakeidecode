import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface SPIByte {
  readonly mosi?: number;
  readonly miso?: number;
}

export interface SpiflashFrame {
  readonly words: readonly SPIByte[];
}

export interface SpiflashCase extends RoundtripCase<SpiflashFrame> {}

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
const CHANNELS = { clk: 3, miso: 0, mosi: 7, cs: 1 } as const;
const SUMMARY: ExpectedFrame = { protoId: 'spiflash', kind: 'summary' };

const COMMANDS: Readonly<Record<string, readonly [string, string, number]>> = {
  WRSR: ['Write status register', 'WRSR', 0],
  PP: ['Page program', 'PP', 1],
  READ: ['Read data', 'READ', 2],
  WRDI: ['Write disable', 'WRDI', 3],
  RDSR: ['Read status register', 'RDSR', 4],
  WREN: ['Write enable', 'WREN', 5],
  FAST: ['Fast read data', 'FAST/READ', 6],
  SE: ['Sector erase', 'SE', 7],
  RDSCUR: ['Read security register', 'RDSCUR', 8],
  WRSCUR: ['Write security register', 'WRSCUR', 9],
  RDSR2: ['Read status register 2', 'RDSR2', 10],
  CE: ['Chip erase', 'CE', 11],
  DP: ['Deep power down', 'DP', 21],
  REMS: ['Read electronic manufacturer & device ID', 'REMS', 16],
  RDID: ['Read identification', 'RDID', 17],
  RDP: ['Release from deep powerdown / Read electronic ID', 'RDP/RES', 18],
  TWO_READ: ['2x I/O read', '2READ', 22],
  STATUS: ['Status register read', 'STATUS', 25],
  BE: ['Block erase', 'BE', 26],
  REMS2: ['Read ID for 2x I/O mode', 'REMS2', 27],
};

function word(mosi?: number, miso?: number): SPIByte {
  return { ...(mosi === undefined ? {} : { mosi }), ...(miso === undefined ? {} : { miso }) };
}

function frame(...words: SPIByte[]): SpiflashFrame {
  return { words };
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function commandTexts(key: keyof typeof COMMANDS): string[] {
  const [description, name] = COMMANDS[key]!;
  return [`Command: ${description} (${name})`, `Command: ${description}`, `Cmd: ${description}`, `Cmd: ${name}`, name];
}

function commandAnnotation(key: keyof typeof COMMANDS): ExpectedFrame {
  return { classIndex: COMMANDS[key]![2], texts: commandTexts(key) };
}

function field(texts: readonly string[]): ExpectedFrame {
  return { classIndex: 29, texts };
}

function bit(texts: readonly string[]): ExpectedFrame {
  return { classIndex: 28, texts };
}

function addressText(address: number): string {
  const text = `0x${hex(address, 6)}`;
  return text;
}

function addressAnnotations(address: number): ExpectedFrame[] {
  const bytes = [address >>> 16, address >>> 8, address].map((value) => value & 0xff);
  let high = 23;
  const result: ExpectedFrame[] = [];
  for (const value of bytes) {
    const low = high - 7;
    result.push(
      bit([
        `Address bits ${high}..${low}: 0x${hex(value, 2)}`,
        `Addr bits ${high}..${low}: 0x${hex(value, 2)}`,
        `Addr bits ${high}..${low}`,
        `A${high}..A${low}`,
      ]),
    );
    high -= 8;
  }
  result.push(field([`Address: ${addressText(address)}`, `Addr: ${addressText(address)}`, addressText(address)]));
  return result;
}

function vendorDeviceTexts(key: keyof typeof COMMANDS, vendor: string, device: string): string[] {
  const [description, name] = COMMANDS[key]!;
  const deviceText = `Device = ${vendor} ${device}`;
  return [
    `${description} (${name}): ${deviceText}`,
    `${description}: ${deviceText}`,
    `${name}: ${deviceText}`,
    deviceText,
    `${vendor} ${device}`,
  ];
}

function dualEncode(value: number): [number, number] {
  let even = 0,
    odd = 0;
  for (let bitIndex = 0; bitIndex < 4; bitIndex++) {
    if (value & (1 << (bitIndex * 2))) even |= 1 << bitIndex;
    if (value & (1 << (bitIndex * 2 + 1))) odd |= 1 << bitIndex;
  }
  return [even, odd];
}

function dualWord(first: number, second: number): SPIByte {
  const [evenFirst, oddFirst] = dualEncode(first),
    [evenSecond, oddSecond] = dualEncode(second);
  return word((evenFirst << 4) | evenSecond, (oddFirst << 4) | oddSecond);
}

function options(): Record<string, string> {
  return { chip: 'macronix_mx25l3205d', format: 'hex' };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53464c53,
}: GenerationOptions = {}): Iterable<SpiflashCase> {
  yield {
    name: 'memory-commands-and-identifiers',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_000n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [
        frame(word(0x06)),
        frame(word(0x02), word(0x00), word(0x01), word(0x02), word(0xaa), word(0xbb)),
        frame(word(0x03), word(0x00), word(0x01), word(0x02), word(0xff, 0xaa), word(0xff, 0xbb)),
        frame(word(0x20), word(0x00), word(0x10), word(0x00)),
        frame(word(0xd8), word(0x01), word(0x00), word(0x00)),
        frame(word(0x9f), word(0xff, 0xc2), word(0xff, 0x20), word(0xff, 0x15)),
        frame(word(0x90), word(0xff), word(0xff), word(0x00), word(0xff, 0xc2), word(0xff, 0x15)),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        field(commandTexts('WREN')),
        commandAnnotation('WREN'),
        field(commandTexts('PP')),
        ...addressAnnotations(0x000102),
        field(['Data (2 bytes)']),
        { classIndex: 1, texts: ['Page program (addr 0x000102, 2 bytes): aa bb'] },
        field(commandTexts('READ')),
        ...addressAnnotations(0x000102),
        field(['Data (2 bytes)']),
        { classIndex: 2, texts: ['Read data (addr 0x000102, 2 bytes): aa bb'] },
        field(commandTexts('SE')),
        ...addressAnnotations(0x001000),
        { classIndex: 7, texts: ['Erase sector 4096 (0x001000)'] },
        field(commandTexts('BE')),
        ...addressAnnotations(0x010000),
        { classIndex: 26, texts: ['Erase block 65536 (0x010000)'] },
        field(commandTexts('RDID')),
        field(['Manufacturer ID: 0xc2']),
        field(['Memory type: 0x20']),
        field(['Device ID: 0x15']),
        { classIndex: 17, texts: vendorDeviceTexts('RDID', 'Macronix', 'MX25L3205D') },
        field(commandTexts('REMS')),
        field(['Dummy byte: 0xff']),
        field(['Dummy byte: 0xff']),
        field(['Master wants manufacturer ID first']),
        field(['Manufacturer ID: 0xc2']),
        field(['Device ID: 0x15']),
        { classIndex: 16, texts: vendorDeviceTexts('REMS', 'Macronix', 'MX25L3205D') },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 40,
        payloadBits: data.reduce((sum, item) => sum + item.words.length * 8, 0),
      };
    },
  };

  yield {
    name: 'status-power-and-security',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 77n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [3, 31, 2047],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [
        frame(word(0x06)),
        frame(word(0x05), word(0xff, 0x02), word(0xff, 0x00)),
        frame(word(0x60)),
        frame(word(0xb9)),
        frame(word(0x01), word(0x02)),
        frame(word(0xd7), word(0xff, 0x10), word(0xff, 0x20)),
        frame(word(0x2b), word(0xff, 0x5a)),
        frame(word(0x2f), word(0x3c)),
        frame(word(0x42)),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        field(commandTexts('WREN')),
        commandAnnotation('WREN'),
        field(commandTexts('RDSR')),
        field(['Status register']),
        commandAnnotation('RDSR'),
        field(['Status register']),
        commandAnnotation('RDSR'),
        field(commandTexts('CE')),
        commandAnnotation('CE'),
        { classIndex: 30, texts: ['Warning: WREN might be missing'] },
        field(commandTexts('DP')),
        commandAnnotation('DP'),
        field(commandTexts('WRSR')),
        field(['Status register 1']),
        commandAnnotation('WRSR'),
        field(commandTexts('STATUS')),
        commandAnnotation('STATUS'),
        field(commandTexts('RDSCUR')),
        field(['Security register byte: 0x5a']),
        commandAnnotation('RDSCUR'),
        field(commandTexts('WRSCUR')),
        field(['Security register byte: 0x3c']),
        commandAnnotation('WRSCUR'),
        bit(['Unknown command: 0x42']),
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 29,
        payloadBits: data.reduce((sum, item) => sum + item.words.length * 8, 0),
      };
    },
  };

  yield {
    name: 'identifiers-and-dual-io',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 1n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [5, 47],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [
        frame(word(0x9f), word(0xff, 0xc2), word(0xff, 0x20), word(0xff, 0x15)),
        frame(word(0x90), word(0xff), word(0xff), word(0x00), word(0xff, 0xc2), word(0xff, 0x15)),
        frame(word(0xab), word(0xff), word(0xff), word(0xff), word(0xff, 0x14)),
        frame(word(0xef), dualWord(0x00, 0x13)),
        frame(word(0xbb), dualWord(0x00, 0x01), dualWord(0x02, 0x00), dualWord(0xaa, 0xbb)),
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        field(commandTexts('RDID')),
        field(['Manufacturer ID: 0xc2']),
        field(['Memory type: 0x20']),
        field(['Device ID: 0x15']),
        { classIndex: 17, texts: vendorDeviceTexts('RDID', 'Macronix', 'MX25L3205D') },
        field(commandTexts('REMS')),
        field(['Dummy byte: 0xff']),
        field(['Dummy byte: 0xff']),
        field(['Master wants manufacturer ID first']),
        field(['Manufacturer ID: 0xc2']),
        field(['Device ID: 0x15']),
        { classIndex: 16, texts: vendorDeviceTexts('REMS', 'Macronix', 'MX25L3205D') },
        field(commandTexts('RDP')),
        field(['Dummy byte: ff']),
        field(['Dummy byte: ff']),
        field(['Dummy byte: ff']),
        field(['Device ID: MX25L1605D']),
        { classIndex: 18, texts: vendorDeviceTexts('RDP', 'Macronix', 'MX25L1605D') },
        field(commandTexts('REMS2')),
        field(['Device ID: 0x13']),
        { classIndex: 27, texts: vendorDeviceTexts('REMS2', 'Macronix', 'MX25L8006') },
        field(commandTexts('TWO_READ')),
        ...addressAnnotations(0x000102).slice(0, 3),
        field(['Address: 0x000102', 'Addr: 0x000102', '0x000102']),
        bit(['Dummy byte: 0x00']),
        field(['Data (2 bytes)']),
        { classIndex: 22, texts: ['2x I/O read (addr 0x000102, 2 bytes): aa bb'] },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 29,
        payloadBits: data.reduce((sum, item) => sum + item.words.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    dataBytes = 256,
    wordsPerFrame = 4 + dataBytes,
    bitsPerFrame = wordsPerFrame * 8,
    frameCount = Math.ceil(required / bitsPerFrame),
    perBlock = 20;
  yield {
    name: 'seeded-long-read-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: options(),
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < frameCount; offset += perBlock) {
        const count = Math.min(perBlock, frameCount - offset);
        const data: SpiflashFrame[] = [];
        for (let index = 0; index < count; index++) {
          const address = (offset + index) & 0xffffff;
          data.push(
            frame(
              word(0x03),
              word(address >>> 16),
              word((address >>> 8) & 0xff),
              word(address & 0xff),
              ...Array.from({ length: dataBytes }, () => word(0xff, random() & 0xff)),
            ),
          );
        }
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations: [field([`Data (${dataBytes} bytes)`])],
          annotationCount: count * 7,
          payloadBits: count * bitsPerFrame,
        };
      }
    },
  };
}
