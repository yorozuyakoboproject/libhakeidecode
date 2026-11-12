import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

interface BitField {
  readonly name: string;
  readonly start: number;
  readonly bits: number;
  readonly options?: Readonly<Record<number, string>>;
}

const CONFIG_REGISTERS: Readonly<Record<number, readonly BitField[]>> = {
  0: [{ name: 'CH_NO', start: 7, bits: 8 }],
  1: [
    {
      name: 'AUTO_RETRAN',
      start: 5,
      bits: 1,
      options: { 0: 'No retransmission', 1: 'Retransmission of data packet' },
    },
    { name: 'RX_RED_PWR', start: 4, bits: 1, options: { 0: 'Normal operation', 1: 'Reduced power' } },
    { name: 'PA_PWR', start: 3, bits: 2, options: { 0: '-10 dBm', 1: '-2 dBm', 2: '+6 dBm', 3: '+10 dBm' } },
    { name: 'HFREQ_PLL', start: 1, bits: 1, options: { 0: '433 MHz', 1: '868 / 915 MHz' } },
    { name: 'CH_NO_8', start: 0, bits: 1 },
  ],
  2: [
    { name: 'TX_AFW (TX addr width)', start: 6, bits: 3 },
    { name: 'RX_AFW (RX addr width)', start: 2, bits: 3 },
  ],
  3: [{ name: 'RW_PW (RX payload width)', start: 5, bits: 6 }],
  4: [{ name: 'TX_PW (TX payload width)', start: 5, bits: 6 }],
  5: [{ name: 'RX_ADDR_0', start: 7, bits: 8 }],
  6: [{ name: 'RX_ADDR_1', start: 7, bits: 8 }],
  7: [{ name: 'RX_ADDR_2', start: 7, bits: 8 }],
  8: [{ name: 'RX_ADDR_3', start: 7, bits: 8 }],
  9: [
    { name: 'CRC_MODE', start: 7, bits: 1, options: { 0: '8 CRC check bit', 1: '16 CRC check bit' } },
    { name: 'CRC_EN', start: 6, bits: 1, options: { 0: 'Disabled', 1: 'Enabled' } },
    {
      name: 'XOR',
      start: 5,
      bits: 3,
      options: { 0: '4 MHz', 1: '8 MHz', 2: '12 MHz', 3: '16 MHz', 4: '20 MHz' },
    },
    {
      name: 'UP_CLK_EN',
      start: 2,
      bits: 1,
      options: { 0: 'No external clock signal avail.', 1: 'External clock signal enabled' },
    },
    {
      name: 'UP_CLK_FREQ',
      start: 1,
      bits: 2,
      options: { 0: '4 MHz', 1: '2 MHz', 2: '1 MHz', 3: '500 kHz' },
    },
  ],
};

const CHANNEL_FIELDS: readonly BitField[] = [
  { name: 'PA_PWR', start: 3, bits: 2, options: { 0: '-10 dBm', 1: '-2 dBm', 2: '+6 dBm', 3: '+10 dBm' } },
  { name: 'HFREQ_PLL', start: 1, bits: 1, options: { 0: '433 MHz', 1: '868 / 915 MHz' } },
];

const STATUS_FIELDS: readonly BitField[] = [
  { name: 'AM', start: 7, bits: 1 },
  { name: 'DR', start: 5, bits: 1 },
];

interface SPIWord {
  readonly ss: bigint;
  readonly es: bigint;
  readonly mosi: number | null;
  readonly miso: number | null;
  readonly cs: boolean | null;
}

interface WireByte {
  readonly value: number;
  readonly ss: bigint;
  readonly es: bigint;
}

function byteWidth(value: number): number {
  if (value === 0) return 1;
  return Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
}

function spiWord(ss: bigint, es: bigint, data: unknown): SPIWord | null {
  if (!Array.isArray(data) || data.length !== 5 || data[0] !== 'WORD') return null;
  const mosi = data[1],
    miso = data[2],
    cs = data[3];
  for (const value of [mosi, miso])
    if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) return null;
  if (cs !== null && typeof cs !== 'boolean') return null;
  return { ss, es, mosi, miso, cs };
}

function splitWord(word: SPIWord): [WireByte[], WireByte[]] {
  const count = Math.max(byteWidth(word.mosi ?? 0), byteWidth(word.miso ?? 0), 1),
    span = word.es - word.ss,
    mosi: WireByte[] = [],
    miso: WireByte[] = [];
  for (let index = 0; index < count; index++) {
    const ss = word.ss + (span * BigInt(index)) / BigInt(count),
      es = word.ss + (span * BigInt(index + 1)) / BigInt(count),
      shift = 8 * (count - index - 1);
    mosi.push({ value: word.mosi === null ? 0 : Math.floor(word.mosi / 2 ** shift) & 0xff, ss, es });
    miso.push({ value: word.miso === null ? 0 : Math.floor(word.miso / 2 ** shift) & 0xff, ss, es });
  }
  return [mosi, miso];
}

function extractBits(byte: number, start: number, count: number): number {
  const begin = 7 - start,
    end = begin + count;
  if (begin < 0 || end > 8) return 0;
  return (byte >> (8 - end)) & ((1 << count) - 1);
}

function extractFields(fields: readonly BitField[], value: number): string {
  return fields
    .map((field) => {
      const result = extractBits(value, field.start, field.bits),
        option = field.options?.[result];
      return `${field.name} = ${result}${option === undefined ? '' : ` (${option})`}`;
    })
    .join(' | ');
}

export class Nrf905Decoder extends Decoder {
  static descriptor = descriptor;

  private outAnn = -1;
  private active = false;
  private mosi: WireByte[] = [];
  private miso: WireByte[] = [];
  private commandStart: bigint | null = null;
  private commandEnd: bigint | null = null;
  private lastWordEnd: bigint | null = null;
  private lastWordSpan = 0n;

  override reset(): void {
    this.active = false;
    this.mosi = [];
    this.miso = [];
    this.commandStart = null;
    this.commandEnd = null;
    this.lastWordEnd = null;
    this.lastWordSpan = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  onEof(): void {
    if (this.active) this.processCommand(this.lastWordEnd ?? this.samplenum);
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private parseConfigRegister(address: number, value: WireByte, write: boolean): void {
    const fields = CONFIG_REGISTERS[address];
    if (!fields) {
      this.annotate(value.ss, value.es, 6, ['Invalid reg. addr']);
      return;
    }
    this.annotate(value.ss, value.es, write ? 1 : 2, [
      `CFG_REG[0x${address.toString(16)}] -> ${extractFields(fields, value.value)}`,
    ]);
  }

  private parseConfigRegisters(start: number, registers: readonly WireByte[], write: boolean): void {
    for (let index = 0; index < registers.length; index++) {
      const address = index + start;
      if (address <= 9) this.parseConfigRegister(address, registers[index]!, write);
    }
  }

  private dumpBytes(prefix: string, bytes: readonly WireByte[], annotation: number): void {
    if (bytes.length < 2) return;
    const text = bytes
      .slice(1)
      .map((byte) => `${byte.value.toString(16).toUpperCase().padStart(2, '0')} `)
      .join('');
    this.annotate(bytes[1]!.ss, bytes.at(-1)!.es, annotation, [prefix + text]);
  }

  private handleCommand(): void {
    const command = this.mosi[0]!.value;
    let name = '';
    let handler: (() => void) | null = null;
    if ((command & 0xf0) === 0x00) {
      name = 'CMD: W_CONFIG (WC)';
      handler = () => this.parseConfigRegisters(command & 0x0f, this.mosi.slice(1), true);
    } else if ((command & 0xf0) === 0x10) {
      name = 'CMD: R_CONFIG (RC)';
      handler = () => this.parseConfigRegisters(command & 0x0f, this.miso.slice(1), false);
    } else if (command === 0x20) {
      name = 'CMD: W_TX_PAYLOAD (WTP)';
      handler = () => this.dumpBytes('Write TX payload.: ', this.mosi, 3);
    } else if (command === 0x21) {
      name = 'CMD: R_TX_PAYLOAD (RTP)';
      handler = () => this.dumpBytes('Read TX payload: ', this.miso, 5);
    } else if (command === 0x22) {
      name = 'CMD: W_TX_ADDRESS (WTA)';
      handler = () => this.dumpBytes('Write TX addr: ', this.mosi, 1);
    } else if (command === 0x23) {
      name = 'CMD: R_TX_ADDRESS (RTA)';
      handler = () => this.dumpBytes('Read TX addr: ', this.miso, 5);
    } else if (command === 0x24) {
      name = 'CMD: R_RX_PAYLOAD (RRP)';
      handler = () => this.dumpBytes('Read RX payload: ', this.miso, 4);
    } else if ((command & 0xf0) === 0x80 && this.mosi.length >= 2) {
      name = 'CMD: CHANNEL_CONFIG (CC)';
      handler = () => {
        const channel = ((command & 1) << 8) + this.mosi[1]!.value;
        this.annotate(this.mosi[0]!.ss, this.mosi[1]!.es, 1, [
          `${extractFields(CHANNEL_FIELDS, command)}| CHN = ${channel}`,
        ]);
      };
    }
    this.annotate(this.commandStart!, this.commandEnd!, 0, [name]);
    const status = this.miso[0]!;
    this.annotate(status.ss, status.es, 2, [`STAT = ${extractFields(STATUS_FIELDS, status.value)}`]);
    handler?.();
  }

  private processCommand(end: bigint): void {
    if (!this.active) return;
    this.commandEnd = end;
    if (this.mosi.length) this.handleCommand();
    this.active = false;
    this.mosi = [];
    this.miso = [];
    this.commandStart = null;
    this.commandEnd = null;
  }

  private appendWord(word: SPIWord): void {
    if (!this.active) {
      this.active = true;
      this.commandStart = word.ss;
      this.mosi = [];
      this.miso = [];
    }
    const [mosi, miso] = splitWord(word);
    this.mosi.push(...mosi);
    this.miso.push(...miso);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING' && typeof data[1] === 'string') {
      if (data[1].startsWith('Chip select deasserted') && this.active) this.processCommand(this.lastWordEnd ?? es);
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word || word.mosi === null || word.miso === null) return;
    if (this.active && this.lastWordEnd !== null && ss - this.lastWordEnd > this.lastWordSpan)
      this.processCommand(this.lastWordEnd);
    if (word.cs === false) {
      if (this.active) this.processCommand(es);
      this.lastWordEnd = es;
      this.lastWordSpan = es > ss ? es - ss : 0n;
      return;
    }
    this.appendWord(word);
    this.lastWordEnd = es;
    this.lastWordSpan = es > ss ? es - ss : 0n;
  }
}

export default Nrf905Decoder;
