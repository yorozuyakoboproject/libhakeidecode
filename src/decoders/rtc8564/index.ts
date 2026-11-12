import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { bcd2int } from '../common.js';
import { descriptor } from './descriptor.js';

type State = 'idle' | 'get-address' | 'get-register' | 'write' | 'read' | 'read-data';

interface StartPacket {
  readonly 0: 'START';
  readonly 1: boolean;
}

interface StopPacket {
  readonly 0: 'STOP';
}

interface AddressPacket {
  readonly 0: 'ADDRESS';
  readonly 1: 'read' | 'write';
  readonly 2: number;
  readonly 3: boolean;
}

interface DataPacket {
  readonly 0: 'DATA';
  readonly 1: 'read' | 'write';
  readonly 2: number;
  readonly 3: boolean;
  readonly 4: number;
}

type I2CPacket = StartPacket | StopPacket | AddressPacket | DataPacket | readonly ['WARNING', string];

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function decimal(value: number): string {
  return value < 0 ? `-${Math.abs(value)}` : value.toString().padStart(2, '0');
}

export class Rtc8564Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private state: State = 'idle';
  private registerAddress = 0;
  private hours = -1;
  private minutes = -1;
  private seconds = -1;
  private days = -1;
  private weekdays = -1;
  private months = -1;
  private years = -1;
  private ss = 0n;
  private es = 0n;
  private blockStart = 0n;

  override reset(): void {
    this.state = 'idle';
    this.registerAddress = 0;
    this.hours = -1;
    this.minutes = -1;
    this.seconds = -1;
    this.days = -1;
    this.weekdays = -1;
    this.months = -1;
    this.years = -1;
    this.ss = 0n;
    this.es = 0n;
    this.blockStart = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putAnnotation(classIndex: number, texts: readonly string[], ss = this.ss, es = this.es): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private bitSpacing(): bigint {
    return (this.es - this.ss) / 8n;
  }

  private putBits(first: number, last: number, classIndex: number, texts: readonly string[]): void {
    const spacing = this.bitSpacing();
    this.putAnnotation(classIndex, texts, this.ss + BigInt(7 - first) * spacing, this.ss + BigInt(8 - last) * spacing);
  }

  private putReserved(bit: number): void {
    this.putBits(bit, bit, 11, ['Reserved bit', 'Reserved', 'Rsvd', 'R']);
  }

  private handleRegister(value: number): void {
    switch (this.registerAddress) {
      case 0:
        return;
      case 1: {
        const tiTp = (value & 0x10) !== 0 ? 1 : 0;
        const af = (value & 0x08) !== 0 ? 1 : 0;
        const tf = (value & 0x04) !== 0 ? 1 : 0;
        const aie = (value & 0x02) !== 0 ? 1 : 0;
        const tie = (value & 0x01) !== 0 ? 1 : 0;
        this.putAnnotation(1, [
          `TI/TP = ${tiTp}: ${tiTp ? 'repeated' : 'single-shot'} operation upon fixed-cycle timer interrupt events\n` +
            `AF = ${af}: ${af ? '' : 'no '}alarm interrupt detected\n` +
            `TF = ${tf}: ${tf ? '' : 'no '}fixed-cycle timer interrupt detected\n` +
            `AIE = ${aie}: INT# pin output ${aie ? 'enabled' : 'prohibited'} when an alarm interrupt occurs\n` +
            `TIE = ${tie}: INT# pin output ${tie ? 'enabled' : 'prohibited'} when a fixed-cycle interrupt event occurs`,
        ]);
        return;
      }
      case 2: {
        const vl = (value & 0x80) !== 0 ? 1 : 0;
        this.putBits(7, 7, 12, [`Voltage low: ${vl}`, `Volt. low: ${vl}`, `VL: ${vl}`, 'VL']);
        this.seconds = bcd2int(value & 0x7f);
        this.putBits(6, 0, 2, [`Second: ${this.seconds}`, `Sec: ${this.seconds}`, `S: ${this.seconds}`, 'S']);
        return;
      }
      case 3:
        this.putReserved(7);
        this.minutes = bcd2int(value & 0x7f);
        this.putBits(6, 0, 3, [`Minute: ${this.minutes}`, `Min: ${this.minutes}`, `M: ${this.minutes}`, 'M']);
        return;
      case 4:
        this.putReserved(7);
        this.putReserved(6);
        this.hours = bcd2int(value & 0x3f);
        this.putBits(5, 0, 4, [`Hour: ${this.hours}`, `H: ${this.hours}`, 'H']);
        return;
      case 5:
        this.putReserved(7);
        this.putReserved(6);
        this.days = bcd2int(value & 0x3f);
        this.putBits(5, 0, 5, [`Day: ${this.days}`, `D: ${this.days}`, 'D']);
        return;
      case 6:
        for (const bit of [7, 6, 5, 4, 3]) this.putReserved(bit);
        this.weekdays = bcd2int(value & 0x07);
        this.putBits(2, 0, 6, [`Weekday: ${this.weekdays}`, `WD: ${this.weekdays}`, 'WD', 'W']);
        return;
      case 7: {
        const century = (value & 0x80) !== 0 ? 1 : 0;
        this.putBits(7, 7, 13, [
          `Century bit: ${century}`,
          `Century: ${century}`,
          `Cent: ${century}`,
          `C: ${century}`,
          'C',
        ]);
        this.putReserved(6);
        this.putReserved(5);
        this.months = bcd2int(value & 0x1f);
        this.putBits(4, 0, 7, [`Month: ${this.months}`, `Mon: ${this.months}`, `M: ${this.months}`, 'M']);
        return;
      }
      case 8:
        this.years = bcd2int(value);
        this.putAnnotation(8, [`Year: ${this.years}`, `Y: ${this.years}`, 'Y']);
    }
  }

  private putRegisterAccess(direction: 'read' | 'write', value: number): void {
    const access = `${hex(this.registerAddress)}: ${hex(value)}`;
    this.putAnnotation(
      15,
      direction === 'write'
        ? [`Write register ${access}`, `Write reg ${access}`, `WR ${access}`, 'WR', 'W']
        : [`Read register ${access}`, `Read reg ${access}`, `RR ${access}`, 'RR', 'R'],
    );
  }

  private putDateTime(classIndex: 9 | 10): void {
    const date =
      `${decimal(this.days)}.${decimal(this.months)}.${decimal(this.years)} ` +
      `${decimal(this.hours)}:${decimal(this.minutes)}:${decimal(this.seconds)}`;
    this.putAnnotation(
      classIndex,
      classIndex === 9
        ? [`Write date/time: ${date}`, `Write: ${date}`, `W: ${date}`]
        : [`Read date/time: ${date}`, `Read: ${date}`, `R: ${date}`],
      this.blockStart,
      this.es,
    );
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || typeof data[0] !== 'string') return;
    const packet = data as unknown as I2CPacket;
    this.ss = ss;
    this.es = es;

    switch (packet[0]) {
      case 'START':
        if (packet[1] && this.state === 'write') {
          this.state = 'read';
        } else if (!packet[1] && this.state === 'idle') {
          this.state = 'get-address';
          this.blockStart = ss;
        }
        return;
      case 'STOP':
        if (this.state === 'write') {
          this.putDateTime(9);
          this.state = 'idle';
        } else if (this.state === 'read-data') {
          this.putDateTime(10);
          this.state = 'idle';
        }
        return;
      case 'WARNING':
        return;
      case 'ADDRESS':
        if (this.state === 'get-address' && packet[1] === 'write') this.state = 'get-register';
        else if (this.state === 'read' && packet[1] === 'read') this.state = 'read-data';
        return;
      case 'DATA':
        if (this.state === 'get-register' && packet[1] === 'write') {
          this.registerAddress = packet[2];
          this.state = 'write';
        } else if (this.state === 'write' && packet[1] === 'write') {
          this.putRegisterAccess('write', packet[2]);
          this.handleRegister(packet[2]);
          this.registerAddress++;
        } else if (this.state === 'read-data' && packet[1] === 'read') {
          this.putRegisterAccess('read', packet[2]);
          this.handleRegister(packet[2]);
          this.registerAddress++;
        }
    }
  }
}

export default Rtc8564Decoder;
