import { descriptor } from './descriptor.js';
import { Decoder, generatorPlugin, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator } from '../../libhakeidecode/index.js';

export interface Am230xOptions {
  device: string;
}

export const AM230X_ANN = Object.freeze({
  START: 0,
  RESPONSE: 1,
  BIT: 2,
  END: 3,
  BYTE: 4,
  HUMIDITY: 5,
  TEMPERATURE: 6,
  CHECKSUM: 7,
});

const AM230X_TIMING = {
  'START LOW': { min: 750, max: 25_000 },
  'START HIGH': { min: 10, max: 10_000 },
  'RESPONSE LOW': { min: 50, max: 90 },
  'RESPONSE HIGH': { min: 50, max: 90 },
  'BIT LOW': { min: 45, max: 90 },
  'BIT 0 HIGH': { min: 20, max: 35 },
  'BIT 1 HIGH': { min: 65, max: 80 },
} as const;

type TimingName = keyof typeof AM230X_TIMING;
type State =
  | 'WAIT FOR START LOW'
  | 'WAIT FOR START HIGH'
  | 'WAIT FOR RESPONSE LOW'
  | 'WAIT FOR RESPONSE HIGH'
  | 'WAIT FOR FIRST BIT'
  | 'WAIT FOR BIT HIGH'
  | 'WAIT FOR BIT LOW'
  | 'WAIT FOR END';

interface TimingRange {
  readonly min: number;
  readonly max: number;
}

export function am230xBitsToNumber(bits: readonly number[], start = 0, end = bits.length): number {
  let value = 0;
  for (let index = start; index < end; index++) value = (value << 1) | (bits[index] & 1);
  return value;
}

export function am230xHumidity(bytes: readonly number[], device: string): number {
  if (device === 'dht11') return bytes[0] ?? 0;
  return (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) / 10;
}

export function am230xTemperature(bytes: readonly number[], device: string): number {
  if (device === 'dht11') return bytes[2] ?? 0;
  const high = bytes[2] ?? 0;
  const value = (((high & 0x7f) << 8) | (bytes[3] ?? 0)) / 10;
  return high & 0x80 ? -value : value;
}

export function am230xChecksum(bytes: readonly number[]): number {
  return bytes.reduce((sum, value) => sum + (value & 0xff), 0) % 256;
}

export function formatAm230xNumber(value: number): string {
  return Object.is(value, -0) ? '-0.0' : value.toFixed(1);
}

export class Am230xDecoder extends Decoder<Am230xOptions> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outAnn = -1;
  private state: State = 'WAIT FOR START LOW';
  private fall = 0n;
  private rise = 0n;
  private bits: number[] = [];
  private bytepos: bigint[] = [];
  private limits: Partial<Record<TimingName, TimingRange>> = {};

  constructor(options: Partial<Am230xOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.limits = {};
    this.resetVariables();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.limits = Object.fromEntries(
      Object.entries(AM230X_TIMING).map(([name, range]) => [
        name,
        {
          min: (range.min * value) / 1_000_000,
          max: (range.max * value) / 1_000_000,
        },
      ]),
    );
  }

  private resetVariables(): void {
    this.state = 'WAIT FOR START LOW';
    this.fall = 0n;
    this.rise = 0n;
    this.bits = [];
    this.bytepos = [];
  }

  private isValid(name: TimingName): boolean {
    const range = this.limits[name];
    if (!range) return false;
    const duration = Number(this.samplenum - (name.endsWith('LOW') ? this.fall : this.rise));
    return duration >= range.min && duration <= range.max;
  }

  private putFromFall(classIndex: number, texts: readonly string[]): void {
    this.put(this.fall, this.samplenum, this.outAnn, [classIndex, texts]);
  }

  private putByte(classIndex: number, texts: readonly string[]): void {
    this.put(this.bytepos.at(-1) ?? this.samplenum, this.samplenum, this.outAnn, [classIndex, texts]);
  }

  private putValue(classIndex: number, texts: readonly string[]): void {
    this.put(this.bytepos.at(-2) ?? this.samplenum, this.samplenum, this.outAnn, [classIndex, texts]);
  }

  private handleBit(bit: number): void {
    this.bits.push(bit);
    this.putFromFall(AM230X_ANN.BIT, [`Bit: ${bit}`, String(bit)]);
    this.fall = this.samplenum;
    this.state = 'WAIT FOR BIT HIGH';

    const length = this.bits.length;
    if (length % 8 !== 0) return;
    const byte = am230xBitsToNumber(this.bits, length - 8, length);
    const byteText = `0x${byte.toString(16).padStart(2, '0')}`;
    this.putByte(AM230X_ANN.BYTE, [`Byte: ${byteText}`, byteText]);

    const bytes = Array.from({ length: length / 8 }, (_, index) =>
      am230xBitsToNumber(this.bits, index * 8, (index + 1) * 8),
    );
    if (length === 16) {
      const value = formatAm230xNumber(am230xHumidity(bytes, this.options.device));
      this.putValue(AM230X_ANN.HUMIDITY, [`Humidity: ${value} %`, `RH = ${value} %`]);
    } else if (length === 32) {
      const value = formatAm230xNumber(am230xTemperature(bytes, this.options.device));
      this.putValue(AM230X_ANN.TEMPERATURE, [`Temperature: ${value} °C`, `T = ${value} °C`]);
    } else if (length === 40) {
      const valid = bytes[4] === am230xChecksum(bytes.slice(0, 4));
      this.putByte(AM230X_ANN.CHECKSUM, valid ? ['Checksum: OK', 'OK'] : ['Checksum: not OK', 'NOK']);
      this.state = 'WAIT FOR END';
    }
    this.bytepos.push(this.samplenum);
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    while (true) {
      switch (this.state) {
        case 'WAIT FOR START LOW':
          yield this.wait({ sda: 'f' });
          this.fall = this.samplenum;
          this.state = 'WAIT FOR START HIGH';
          break;
        case 'WAIT FOR START HIGH':
          yield this.wait({ sda: 'r' });
          if (this.isValid('START LOW')) {
            this.rise = this.samplenum;
            this.state = 'WAIT FOR RESPONSE LOW';
          } else this.resetVariables();
          break;
        case 'WAIT FOR RESPONSE LOW':
          yield this.wait({ sda: 'f' });
          if (this.isValid('START HIGH')) {
            this.putFromFall(AM230X_ANN.START, ['Start', 'S']);
            this.fall = this.samplenum;
            this.state = 'WAIT FOR RESPONSE HIGH';
          } else this.resetVariables();
          break;
        case 'WAIT FOR RESPONSE HIGH':
          yield this.wait({ sda: 'r' });
          if (this.isValid('RESPONSE LOW')) {
            this.rise = this.samplenum;
            this.state = 'WAIT FOR FIRST BIT';
          } else this.resetVariables();
          break;
        case 'WAIT FOR FIRST BIT':
          yield this.wait({ sda: 'f' });
          if (this.isValid('RESPONSE HIGH')) {
            this.putFromFall(AM230X_ANN.RESPONSE, ['Response', 'R']);
            this.fall = this.samplenum;
            this.bytepos.push(this.samplenum);
            this.state = 'WAIT FOR BIT HIGH';
          } else this.resetVariables();
          break;
        case 'WAIT FOR BIT HIGH':
          yield this.wait({ sda: 'r' });
          if (this.isValid('BIT LOW')) {
            this.rise = this.samplenum;
            this.state = 'WAIT FOR BIT LOW';
          } else this.resetVariables();
          break;
        case 'WAIT FOR BIT LOW':
          yield this.wait({ sda: 'f' });
          if (this.isValid('BIT 0 HIGH')) this.handleBit(0);
          else if (this.isValid('BIT 1 HIGH')) this.handleBit(1);
          else {
            this.resetVariables();
            continue;
          }
          break;
        case 'WAIT FOR END':
          yield this.wait({ sda: 'r' });
          this.putFromFall(AM230X_ANN.END, ['End', 'E']);
          this.resetVariables();
          break;
      }
    }
  }
}

export const am230xPlugin: DecoderPlugin<any, any> = {
  decoder: Am230xDecoder,
  descriptor,
  createEngine: (context) => generatorPlugin(Am230xDecoder).createEngine(context),
};

export default Am230xDecoder;
