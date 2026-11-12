import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const ANN_TO_ROW = [0, 0, 0, 1, 1, 2] as const;

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

interface BitInterval {
  readonly ss: bigint;
  readonly es: bigint;
}

type AnnotationText = string | readonly string[];

function byteWidth(value: number): number {
  if (value === 0) return 1;
  return Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
}

function hex(value: number, upper = true): string {
  const text = value.toString(16).padStart(2, '0');
  return upper ? text.toUpperCase() : text;
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

export class Rfm12Decoder extends Decoder {
  static descriptor = descriptor;

  private outAnn = -1;
  private mosiBytes: WireByte[] = [];
  private misoBytes: WireByte[] = [];
  private mosiBits: BitInterval[] = [];
  private rowPosition = [0, 8, 8];
  private lastStatus = [0, 0];
  private lastConfig = 0x08;
  private lastPower = 0x08;
  private lastFrequency = 0x680;
  private lastDataRate = 0x23;
  private lastFifoAndReset = 0x80;
  private lastAfc = 0xf7;
  private lastTransceiver = 0;
  private lastPll = 0x77;

  override reset(): void {
    this.mosiBytes = [];
    this.misoBytes = [];
    this.mosiBits = [];
    this.rowPosition = [0, 8, 8];
    this.lastStatus = [0, 0];
    this.lastConfig = 0x08;
    this.lastPower = 0x08;
    this.lastFrequency = 0x680;
    this.lastDataRate = 0x23;
    this.lastFifoAndReset = 0x80;
    this.lastAfc = 0xf7;
    this.lastTransceiver = 0;
    this.lastPll = 0x77;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private advance(annotation: number, length: number): void {
    this.rowPosition[ANN_TO_ROW[annotation]!]! += length;
  }

  private putx(annotation: number, length: number, description: AnnotationText): void {
    const row = ANN_TO_ROW[annotation]!,
      bit = this.rowPosition[row]!,
      start = this.mosiBits[bit]?.ss ?? this.mosiBits.at(-1)?.es ?? 0n,
      end = this.mosiBits[bit + length - 1]?.es ?? start;
    this.put(start, end, this.outAnn, [annotation, typeof description === 'string' ? [description] : description]);
    this.rowPosition[row] = bit + length;
  }

  private describeBits(value: number, names: readonly AnnotationText[]): void {
    let mask = 1 << (names.length - 1);
    for (let bit = 0; mask !== 0; bit++, mask >>= 1) if (names[bit]) this.putx(value & mask ? 1 : 2, 1, names[bit]!);
  }

  private describeReturnBits(value: number, names: readonly string[]): void {
    let mask = 1 << (names.length - 1);
    for (let bit = 0; mask !== 0; bit++, mask >>= 1) {
      if (names[bit]) this.putx(value & mask ? 3 : 4, 1, names[bit]!);
      else this.advance(3, 1);
    }
  }

  private describeChangedBits(value: number, oldValue: number, names: readonly AnnotationText[]): void {
    const changes = value ^ oldValue;
    let mask = 1 << (names.length - 1);
    for (let bit = 0; mask !== 0; bit++, mask >>= 1) {
      if (names[bit] && changes & mask) this.putx(5, 1, value & mask ? ['+', 'Turning on'] : ['-', 'Turning off']);
      else this.advance(5, 1);
    }
  }

  private configuration(cmd: readonly number[]): void {
    this.putx(0, 8, ['Configuration command', 'Configuration']);
    const names = [
        ['Internal data register', 'el'],
        ['FIFO mode', 'ef'],
      ],
      bits = (cmd[1]! & 0xc0) >> 6,
      oldBits = (this.lastConfig & 0xc0) >> 6;
    this.describeBits(bits, names);
    this.describeChangedBits(
      bits,
      oldBits,
      names.map((item) => item[0]!),
    );
    const frequency = ['315', '433', '868', '915'][(cmd[1]! & 0x30) >> 4]! + 'MHz';
    this.putx(1, 2, [`Frequency: ${frequency}`, frequency]);
    if ((cmd[1]! & 0x30) !== (this.lastConfig & 0x30)) this.putx(5, 2, ['Changed', '~']);
    const capacitance = `${(8.5 + (cmd[1]! & 0x0f) * 0.5).toFixed(1)}pF`;
    this.putx(1, 4, [`Capacitance: ${capacitance}`, capacitance]);
    if ((cmd[1]! & 0x0f) !== (this.lastConfig & 0x0f)) this.putx(5, 4, ['Changed', '~']);
    this.lastConfig = cmd[1]!;
  }

  private powerManagement(cmd: readonly number[]): void {
    this.putx(0, 8, ['Power management', 'Power']);
    const names = [
      ['Receiver chain', 'er'],
      ['Baseband circuit', 'ebb'],
      ['Transmission', 'et'],
      ['Synthesizer', 'es'],
      ['Crystal oscillator', 'ex'],
      ['Low battery detector', 'eb'],
      ['Wake-up timer', 'ew'],
      ['Clock output off switch', 'dc'],
    ];
    this.describeBits(cmd[1]!, names);
    let power = cmd[1]!;
    if (power & 0x80) power |= 0x58;
    if (power & 0x20) power |= 0x18;
    this.describeChangedBits(power, this.lastPower, names);
    this.lastPower = power;
  }

  private frequencySetting(cmd: readonly number[]): void {
    this.putx(0, 4, ['Frequency setting', 'Frequency']);
    const frequency = ((cmd[0]! & 0x0f) << 8) + cmd[1]!;
    this.putx(0, 12, [`F = ${frequency.toFixed(4)}`]);
    this.rowPosition[2] = this.rowPosition[2]! - 4;
    if (this.lastFrequency !== frequency) this.putx(5, 12, ['Changing', '~']);
    this.lastFrequency = frequency;
  }

  private dataRate(cmd: readonly number[]): void {
    this.putx(0, 8, ['Data rate command', 'Data rate']);
    const value = cmd[1]! & 0x7f,
      cs = (cmd[1]! & 0x80) >> 7,
      rate = 10000 / 29 / (value + 1) / (1 + 7 * cs);
    this.putx(0, 8, [`${rate.toFixed(1)}kbps`]);
    if (this.lastDataRate !== cmd[1]!) this.putx(5, 8, ['Changing', '~']);
    this.lastDataRate = cmd[1]!;
  }

  private receiverControl(cmd: readonly number[]): void {
    this.putx(0, 5, ['Receiver control command']);
    this.putx(0, 1, [`pin16 = ${cmd[0]! & 0x04 ? 'interrupt input' : 'VDI output'}`]);
    this.putx(0, 2, [`VDI: ${['Fast', 'Medium', 'Slow', 'Always on'][cmd[0]! & 3]}`]);
    this.putx(0, 3, [
      `Bandwidth: ${['Reserved', '400kHz', '340kHz', '270kHz', '200kHz', '134kHz', '67kHz', 'Reserved'][(cmd[1]! & 0xe0) >> 5]}`,
    ]);
    this.putx(0, 2, [`LNA gain: ${[0, -6, -14, -20][(cmd[1]! & 0x18) >> 3]}dB`]);
    this.putx(0, 3, [
      `RSSI threshold: ${['-103', '-97', '-91', '-85', '-79', '-73', 'Reserved', 'Reserved'][cmd[1]! & 7]}`,
    ]);
  }

  private dataFilter(cmd: readonly number[]): void {
    this.putx(0, 8, ['Data filter command']);
    const clockRecovery = cmd[1]! & 0x80 ? 'auto' : cmd[1]! & 0x40 ? 'fast' : 'slow';
    this.putx(0, 2, [`Clock recovery: ${clockRecovery} mode`]);
    this.advance(0, 1);
    this.putx(0, 1, [`Data filter: ${cmd[1]! & 0x10 ? 'analog' : 'digital'}`]);
    this.advance(0, 1);
    this.putx(0, 3, [`DQD threshold: ${cmd[1]! & 7}`]);
  }

  private fifoAndReset(cmd: readonly number[]): void {
    this.putx(0, 8, ['FIFO and reset command']);
    const fifoLevel = (cmd[1]! & 0xf0) >> 4;
    this.putx(0, 4, [`FIFO trigger level: ${fifoLevel}`]);
    if (fifoLevel !== (this.lastFifoAndReset & 0xf0) >> 4) this.putx(5, 4, ['Changing', '~']);
    else this.advance(5, 4);
    this.putx(0, 1, [`Synchron length: ${cmd[1]! & 0x08 ? 'one byte' : 'two bytes'}`]);
    if ((cmd[1]! & 0x08) !== (this.lastFifoAndReset & 0x08)) this.putx(5, 1, ['Changing', '~']);
    else this.advance(5, 1);
    const fill = cmd[1]! & 0x04 ? 'Always' : cmd[1]! & 0x02 ? 'After synchron pattern' : 'Never';
    this.putx(0, 2, [`FIFO fill: ${fill}`]);
    if ((cmd[1]! & 0x06) !== (this.lastFifoAndReset & 0x06)) this.putx(5, 2, ['Changing', '~']);
    else this.advance(5, 2);
    this.putx(0, 1, [`Reset mode: ${cmd[1]! & 1 ? 'non-sensitive' : 'sensitive'}`]);
    if ((cmd[1]! & 1) !== (this.lastFifoAndReset & 1)) this.putx(5, 1, ['Changing', '~']);
    else this.advance(5, 1);
    this.lastFifoAndReset = cmd[1]!;
  }

  private synchronPattern(cmd: readonly number[]): void {
    this.putx(0, 8, ['Synchron pattern command']);
    const pattern = hex(cmd[1]!);
    this.putx(0, 8, [this.lastFifoAndReset & 0x08 ? `Pattern: 0x2D${pattern}` : `Pattern: ${pattern}`]);
  }

  private fifoRead(): void {
    this.putx(0, 8, ['FIFO read command', 'FIFO read']);
    this.putx(3, 8, [`Data: ${hex(this.misoBytes[1]!.value)}`]);
  }

  private afc(cmd: readonly number[]): void {
    this.putx(0, 8, ['AFC command']);
    this.putx(0, 2, [`Mode: ${['Off', 'Once', 'During receiving', 'Always'][(cmd[1]! & 0xc0) >> 6]}`]);
    if ((cmd[1]! & 0xc0) !== (this.lastAfc & 0xc0)) this.putx(5, 2, ['Changing', '~']);
    else this.advance(5, 2);
    const limit = (cmd[1]! & 0x30) >> 4,
      delta = [0, 2.5, 5, 7.5][(this.lastConfig & 0x30) >> 4]!;
    let range: string;
    if (limit === 0) range = 'No limit';
    else if (limit === 1) range = `+/-${Math.trunc(15 * delta)}kHz`;
    else if (limit === 2) range = `+/-${Math.trunc(7 * delta)}kHz`;
    else range = `+/-${Math.trunc(3 * delta)}kHz`;
    this.putx(0, 2, [`Range: ${range}`]);
    if ((cmd[1]! & 0x30) !== (this.lastAfc & 0x30)) this.putx(5, 2, ['Changing', '~']);
    else this.advance(5, 2);
    const names = ['Strobe edge', 'High accuracy mode', 'Enable offset register', 'Enable offset calculation'];
    this.describeBits(cmd[1]! & 0x0f, names);
    this.describeChangedBits(cmd[1]! & 0x0f, this.lastAfc & 0x0f, names);
    this.lastAfc = cmd[1]!;
  }

  private transceiverControl(cmd: readonly number[]): void {
    this.putx(0, 8, ['Transceiver control command']);
    this.putx(0, 4, [`FSK frequency delta: ${15 * ((cmd[1]! & 0xf0) >> 4)}kHz`]);
    if ((cmd[1]! & 0xf0) !== (this.lastTransceiver & 0xf0)) this.putx(5, 4, ['Changing', '~']);
    else this.advance(5, 4);
    this.advance(0, 1);
    this.advance(5, 1);
    this.putx(0, 3, [`Relative power: ${cmd[1]! & 7}dB`]);
    if ((cmd[1]! & 7) !== (this.lastTransceiver & 7)) this.putx(5, 3, ['Changing', '~']);
    else this.advance(5, 3);
    this.lastTransceiver = cmd[1]!;
  }

  private pllSetting(cmd: readonly number[]): void {
    this.putx(0, 8, ['PLL setting command']);
    this.advance(0, 1);
    this.putx(0, 2, ['Clock buffer rise and fall time']);
    this.advance(0, 1);
    this.advance(5, 4);
    const names = [
        ['Delay in phase detector', 'dly'],
        ['Disable dithering', 'ddit'],
      ],
      bits = (cmd[1]! & 0x0c) >> 2;
    this.describeBits(bits, names);
    this.describeChangedBits(bits, (this.lastPll & 0x0c) >> 2, names);
    this.putx(0, 1, [`Max bit rate: ${cmd[1]! & 1 ? '256kbps, high' : '86.2kbps, low'} noise`]);
    this.advance(5, 1);
    if ((cmd[1]! & 1) !== (this.lastPll & 1)) this.putx(5, 1, ['Changing', '~']);
    this.lastPll = cmd[1]!;
  }

  private transmitterRegister(cmd: readonly number[]): void {
    this.putx(0, 8, ['Transmitter register command', 'Transmit']);
    this.putx(0, 8, [`Data: ${cmd[1]!}`, `${cmd[1]!}`]);
  }

  private softwareReset(): void {
    this.putx(0, 16, ['Software reset command']);
  }

  private wakeUpTimer(cmd: readonly number[]): void {
    this.putx(0, 3, ['Wake-up timer command', 'Timer']);
    const exponent = cmd[0]! & 0x1f,
      value = 1.03 * cmd[1]! * 2 ** exponent + 0.5;
    this.putx(0, 13, [`Time: ${value.toFixed(2).padStart(7, ' ')}`]);
  }

  private lowDutyCycle(): void {
    this.putx(0, 16, ['Low duty cycle command']);
  }

  private lowBattery(cmd: readonly number[]): void {
    this.putx(0, 8, ['Low battery detector command']);
    const clock = ['1', '1.25', '1.66', '2', '2.5', '3.33', '5', '10'][(cmd[1]! & 0xe0) >> 5]!;
    this.putx(0, 3, [`Clock output: ${clock}MHz`, `${clock}MHz`]);
    this.advance(0, 1);
    const voltage = `${(2.25 + (cmd[1]! & 0x0f) * 0.1).toFixed(2)}V`;
    this.putx(0, 4, [`Low battery voltage: ${voltage}`, voltage]);
  }

  private statusRead(): void {
    this.putx(0, 8, ['Status read command', 'Status']);
    const names = ['RGIT/FFIT', 'POR', 'RGUR/FFOV', 'WKUP', 'EXT', 'LBD', 'FFEM', 'RSSI/ATS', 'DQD', 'CRL', 'ATGL'],
      status = (this.misoBytes[0]!.value << 3) + (this.misoBytes[1]!.value >> 5);
    this.rowPosition[1] = this.rowPosition[1]! - 8;
    this.rowPosition[2] = this.rowPosition[2]! - 8;
    this.describeReturnBits(status, names);
    const receiverEnabled = (this.lastPower & 0x80) >> 7,
      first = this.misoBytes[0]!.value,
      second = this.misoBytes[1]!.value;
    const bits: readonly (readonly [boolean, string])[] = [
      [Boolean(first & 0x80), receiverEnabled ? 'Received data in FIFO' : 'Transmit register ready'],
      [Boolean(first & 0x40), 'Power on Reset'],
      [Boolean(first & 0x20), receiverEnabled ? 'RX FIFO overflow' : 'Transmit register under run'],
      [Boolean(first & 0x10), 'Wake-up timer'],
      [Boolean(first & 0x08), 'External interrupt'],
      [Boolean(first & 0x04), 'Low battery'],
      [Boolean(first & 0x02), 'FIFO is empty'],
      [Boolean(first & 0x01), receiverEnabled ? 'Incoming signal above limit' : 'Antenna detected RF signal'],
      [Boolean(second & 0x80), 'Data quality detector'],
      [Boolean(second & 0x40), 'Clock recovery locked'],
    ];
    for (const [set, text] of bits) {
      if (set) this.putx(5, 1, text);
      else this.advance(5, 1);
    }
    this.advance(5, 1);
    this.putx(3, 5, ['AFC offset']);
    if ((this.lastStatus[1]! & 0x1f) !== (second & 0x1f)) this.putx(5, 5, ['Changed', '~']);
    else this.advance(5, 5);
    this.lastStatus = [first, second];
  }

  private handleCommand(cmd: readonly number[], ret: readonly number[]): void {
    this.rowPosition = [0, 8, 8];
    const command = cmd[0]!;
    if (command === 0x80) this.configuration(cmd);
    else if (command === 0x82) this.powerManagement(cmd);
    else if ((command & 0xf0) === 0xa0) this.frequencySetting(cmd);
    else if (command === 0xc6) this.dataRate(cmd);
    else if ((command & 0xf8) === 0x90) this.receiverControl(cmd);
    else if (command === 0xc2) this.dataFilter(cmd);
    else if (command === 0xca) this.fifoAndReset(cmd);
    else if (command === 0xce) this.synchronPattern(cmd);
    else if (command === 0xb0) this.fifoRead();
    else if (command === 0xc4) this.afc(cmd);
    else if ((command & 0xfe) === 0x98) this.transceiverControl(cmd);
    else if (command === 0xcc) this.pllSetting(cmd);
    else if (command === 0xb8) this.transmitterRegister(cmd);
    else if (command === 0xfe) this.softwareReset();
    else if ((command & 0xe0) === 0xe0) this.wakeUpTimer(cmd);
    else if (command === 0xc8) this.lowDutyCycle();
    else if (command === 0xc0) this.lowBattery(cmd);
    else if (command === 0x00) this.statusRead();
    else
      this.putx(0, 16, [
        `Unknown command: ${hex(command, false)} ${hex(cmd[1]!, false)} (reply: ${hex(ret[0] ?? 0, false)} ${hex(ret[1] ?? 0, false)})!`,
      ]);
  }

  private appendByte(mosi: WireByte, miso: WireByte): void {
    this.mosiBytes.push(mosi);
    this.misoBytes.push(miso);
    const span = mosi.es > mosi.ss ? mosi.es - mosi.ss : 0n;
    for (let index = 0; index < 8; index++)
      this.mosiBits.push({
        ss: mosi.ss + (span * BigInt(index)) / 8n,
        es: mosi.ss + (span * BigInt(index + 1)) / 8n,
      });
    if (this.mosiBytes.length < 2) return;
    this.handleCommand(
      this.mosiBytes.map((byte) => byte.value),
      this.misoBytes.map((byte) => byte.value),
    );
    this.mosiBytes = [];
    this.misoBytes = [];
    this.mosiBits = [];
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING') {
      this.mosiBytes = [];
      this.misoBytes = [];
      this.mosiBits = [];
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word || word.mosi === null || word.miso === null) return;
    const [mosi, miso] = splitWord(word);
    for (let index = 0; index < mosi.length; index++) this.appendByte(mosi[index]!, miso[index]!);
  }
}

export default Rfm12Decoder;
