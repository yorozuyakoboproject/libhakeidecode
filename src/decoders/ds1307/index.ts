import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { bcd2int } from '../common.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import type { I2CProtocolPacket } from '../i2c/index.js';
import { descriptor } from './descriptor.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const RATES: Readonly<Record<number, string>> = {
  0b00: '1Hz',
  0b01: '4096Hz',
  0b10: '8192Hz',
  0b11: '32768Hz',
};
const DS1307_ADDRESS = 0x68;

interface BitSpan {
  value: number;
  ss: bigint;
  es: bigint;
}

type State = 'IDLE' | 'GET SLAVE ADDR' | 'GET REG ADDR' | 'WRITE RTC REGS' | 'READ RTC REGS' | 'READ RTC REGS2';

function bitsOf(value: number, ss: bigint, es: bigint): BitSpan[] {
  const span = es - ss;
  return Array.from({ length: 8 }, (_, index) => {
    const position = 7 - index;
    return {
      value: (value >>> index) & 1,
      ss: ss + (span * BigInt(position)) / 8n,
      es: ss + (span * BigInt(position + 1)) / 8n,
    };
  });
}

function sevenBitAddress(address: number): number {
  return address > 0x7f ? address >>> 1 : address;
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function pad(value: number, size: number): string {
  return value.toString().padStart(size, '0');
}

export class Ds1307Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private state: State = 'IDLE';
  private blockStart = 0n;
  private bits: BitSpan[] = [];
  private reg = 0;
  private hours = -1;
  private minutes = -1;
  private seconds = -1;
  private days = -1;
  private date = -1;
  private months = -1;
  private years = -1;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = 'IDLE';
    this.blockStart = 0n;
    this.bits = [];
    this.reg = 0;
    this.hours = -1;
    this.minutes = -1;
    this.seconds = -1;
    this.days = -1;
    this.date = -1;
    this.months = -1;
    this.years = -1;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private putBits(first: number, last: number, classIndex: number, texts: readonly string[]): void {
    this.annotate(this.bits[first]!.ss, this.bits[last]!.es, classIndex, texts);
  }

  private putReserved(bit: number): void {
    this.putBits(bit, bit, 11, ['Reserved bit', 'Reserved', 'Rsvd', 'R']);
  }

  private handleSeconds(value: number): void {
    this.putBits(7, 0, 0, ['Seconds', 'Sec', 'S']);
    const halted = value >>> 7;
    this.putBits(7, 7, 9, [`Clock halt: ${halted}`, `Clk hlt: ${halted}`, `CH: ${halted}`, 'CH']);
    this.seconds = bcd2int(value & 0x7f);
    this.putBits(6, 0, 10, [`Second: ${this.seconds}`, `Sec: ${this.seconds}`, `S: ${this.seconds}`, 'S']);
  }

  private handleMinutes(value: number): void {
    this.putBits(7, 0, 1, ['Minutes', 'Min', 'M']);
    this.putReserved(7);
    this.minutes = bcd2int(value & 0x7f);
    this.putBits(6, 0, 12, [`Minute: ${this.minutes}`, `Min: ${this.minutes}`, `M: ${this.minutes}`, 'M']);
  }

  private handleHours(value: number): void {
    this.putBits(7, 0, 2, ['Hours', 'H']);
    this.putReserved(7);
    if (value & 0x40) {
      this.putBits(6, 6, 13, ['12-hour mode', '12h mode', '12h']);
      const marker = value & 0x20 ? 'PM' : 'AM';
      this.putBits(5, 5, 14, [marker, marker[0]!]);
      this.hours = bcd2int(value & 0x1f);
      this.putBits(4, 0, 15, [`Hour: ${this.hours}`, `H: ${this.hours}`, 'H']);
    } else {
      this.putBits(6, 6, 13, ['24-hour mode', '24h mode', '24h']);
      this.hours = bcd2int(value & 0x3f);
      this.putBits(5, 0, 15, [`Hour: ${this.hours}`, `H: ${this.hours}`, 'H']);
    }
  }

  private handleDay(value: number): void {
    this.putBits(7, 0, 3, ['Day of week', 'Day', 'D']);
    for (const bit of [7, 6, 5, 4, 3]) this.putReserved(bit);
    this.days = bcd2int(value & 0x07);
    const day = DAYS[this.days - 1] ?? 'Invalid';
    this.putBits(2, 0, 16, [`Weekday: ${day}`, `WD: ${day}`, 'WD', 'W']);
  }

  private handleDate(value: number): void {
    this.putBits(7, 0, 4, ['Date', 'D']);
    for (const bit of [7, 6]) this.putReserved(bit);
    this.date = bcd2int(value & 0x3f);
    this.putBits(5, 0, 17, [`Date: ${this.date}`, `D: ${this.date}`, 'D']);
  }

  private handleMonth(value: number): void {
    this.putBits(7, 0, 5, ['Month', 'Mon', 'M']);
    for (const bit of [7, 6, 5]) this.putReserved(bit);
    this.months = bcd2int(value & 0x1f);
    this.putBits(4, 0, 18, [`Month: ${this.months}`, `Mon: ${this.months}`, `M: ${this.months}`, 'M']);
  }

  private handleYear(value: number): void {
    this.putBits(7, 0, 6, ['Year', 'Y']);
    const year = bcd2int(value);
    this.years = year + 2000;
    this.putBits(7, 0, 19, [`Year: ${year}`, `Y: ${year}`, 'Y']);
  }

  private handleControl(value: number): void {
    this.putBits(7, 0, 7, ['Control', 'Ctrl', 'C']);
    for (const bit of [6, 5, 3, 2]) this.putReserved(bit);
    const output = (value >>> 7) & 1,
      squareWave = (value >>> 4) & 1,
      action = squareWave ? 'en' : 'dis',
      rate = RATES[value & 0x03]!;
    this.putBits(7, 7, 20, [`Output control: ${output}`, `OUT: ${output}`, `O: ${output}`, 'O']);
    this.putBits(4, 4, 21, [
      `Square wave output: ${action}abled`,
      `SQWE: ${action}abled`,
      `SQWE: ${squareWave}`,
      `S: ${squareWave}`,
      'S',
    ]);
    this.putBits(1, 0, 22, [
      `Square wave output rate: ${rate}`,
      `Square wave rate: ${rate}`,
      `SQW rate: ${rate}`,
      `Rate: ${rate}`,
      `RS: ${squareWave}`,
      'RS',
      'R',
    ]);
  }

  private handleRam(value: number): void {
    this.putBits(7, 0, 8, ['RAM', 'R']);
    this.putBits(7, 0, 23, [`SRAM: 0x${hex(value)}`, `0x${hex(value)}`]);
  }

  private handleRegister(value: number): void {
    switch (this.reg < 8 ? this.reg : 0x3f) {
      case 0x00:
        this.handleSeconds(value);
        break;
      case 0x01:
        this.handleMinutes(value);
        break;
      case 0x02:
        this.handleHours(value);
        break;
      case 0x03:
        this.handleDay(value);
        break;
      case 0x04:
        this.handleDate(value);
        break;
      case 0x05:
        this.handleMonth(value);
        break;
      case 0x06:
        this.handleYear(value);
        break;
      case 0x07:
        this.handleControl(value);
        break;
      default:
        this.handleRam(value);
    }
    this.reg++;
    if (this.reg > 0x3f) this.reg = 0;
  }

  private outputDatetime(classIndex: number, action: string, es: bigint): void {
    if (
      this.days < 1 ||
      this.days > 7 ||
      this.date < 1 ||
      this.months < 1 ||
      this.hours < 0 ||
      this.minutes < 0 ||
      this.seconds < 0 ||
      this.years < 2000
    )
      return;
    const date =
      `${DAYS[this.days - 1]}, ${pad(this.date, 2)}.${pad(this.months, 2)}.${pad(this.years, 4)} ` +
      `${pad(this.hours, 2)}:${pad(this.minutes, 2)}:${pad(this.seconds, 2)}`;
    this.annotate(this.blockStart, es, classIndex, [`${action} date/time: ${date}`]);
  }

  decode(_ss: bigint, es: bigint, data: unknown): void {
    const packet = data as I2CProtocolPacket;
    switch (packet[0]) {
      case 'START':
        if (packet[1]) {
          if (this.state === 'WRITE RTC REGS') this.state = 'READ RTC REGS';
        } else if (this.state === 'IDLE') {
          this.state = 'GET SLAVE ADDR';
          this.blockStart = _ss;
        }
        return;
      case 'STOP':
        if (this.state === 'WRITE RTC REGS') this.outputDatetime(25, 'Written', es);
        else if (this.state === 'READ RTC REGS2') this.outputDatetime(24, 'Read', es);
        this.state = 'IDLE';
        return;
      case 'ADDRESS': {
        const address = sevenBitAddress(packet[2]);
        if (this.state === 'GET SLAVE ADDR' && packet[1] === 'write') {
          if (address !== DS1307_ADDRESS) {
            this.annotate(this.blockStart, es, 28, [`Ignoring non-DS1307 data (slave 0x${hex(address)})`]);
            this.state = 'IDLE';
            return;
          }
          this.state = 'GET REG ADDR';
        } else if (this.state === 'READ RTC REGS' && packet[1] === 'read') {
          if (address !== DS1307_ADDRESS) {
            this.annotate(this.blockStart, es, 28, [`Ignoring non-DS1307 data (slave 0x${hex(address)})`]);
            this.state = 'IDLE';
            return;
          }
          this.state = 'READ RTC REGS2';
        }
        return;
      }
      case 'DATA': {
        this.bits = bitsOf(packet[2], _ss, es);
        if (this.state === 'GET REG ADDR' && packet[1] === 'write') {
          this.reg = packet[2];
          this.state = 'WRITE RTC REGS';
        } else if (this.state === 'WRITE RTC REGS' && packet[1] === 'write') {
          this.handleRegister(packet[2]);
        } else if (this.state === 'READ RTC REGS2' && packet[1] === 'read') {
          this.handleRegister(packet[2]);
        }
        return;
      }
      default:
        return;
    }
  }
}

export default Ds1307Decoder;
