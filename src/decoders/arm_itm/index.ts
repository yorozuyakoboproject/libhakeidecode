import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { AnnotationData, DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface ArmItmOptions {
  objdump: string;
  objdump_opts: string;
  elffile: string;
}

type UartData = readonly ['DATA', 0 | 1, readonly [value: number, bits: unknown]];
type PacketOutput = AnnotationData | readonly [] | null;
type PacketType =
  | 'sync'
  | 'overflow'
  | 'timestamp'
  | 'sw_extension'
  | 'hw_extension'
  | 'reserved'
  | 'software'
  | 'hardware';

interface CurrentMode {
  start: bigint;
  mode: string;
}

interface SoftwarePacket {
  start: bigint;
  previousTime: bigint;
  text: string;
}

const ARM_EXCEPTIONS = new Map<number, string>([
  [0, 'Thread'],
  [1, 'Reset'],
  [2, 'NMI'],
  [3, 'HardFault'],
  [4, 'MemManage'],
  [5, 'BusFault'],
  [6, 'UsageFault'],
  [11, 'SVCall'],
  [12, 'Debug Monitor'],
  [14, 'PendSV'],
  [15, 'SysTick'],
]);

export class ArmItmDecoder extends Decoder<ArmItmOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private buffer: number[] = [];
  private syncBuffer: number[] = [];
  private softwarePackets = new Map<number, SoftwarePacket | null>();
  private previousSample = 0n;
  private startSample = 0n;
  private byteLength = 0n;
  private dwtTimestamp = 0;
  private currentMode: CurrentMode | null = null;

  constructor(options: Partial<ArmItmOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.buffer = [];
    this.syncBuffer = [];
    this.softwarePackets = new Map();
    this.previousSample = 0n;
    this.startSample = 0n;
    this.byteLength = 0n;
    this.dwtTimestamp = 0;
    this.currentMode = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private packetType(value: number): PacketType {
    if ((value & 0x7f) === 0) return 'sync';
    if (value === 0x70) return 'overflow';
    if ((value & 0x0f) === 0 && (value & 0xf0) !== 0) return 'timestamp';
    if ((value & 0x0f) === 0x08) return 'sw_extension';
    if ((value & 0x0f) === 0x0c) return 'hw_extension';
    if ((value & 0x0f) === 0x04) return 'reserved';
    if ((value & 0x04) === 0) return 'software';
    return 'hardware';
  }

  private fallback(buffer: readonly number[]): AnnotationData {
    const type = this.packetType(buffer[0]!);
    return [0, [`Unhandled ${type}: ${buffer.map((value) => value.toString(16).padStart(2, '0')).join(' ')}`]];
  }

  private modeChange(mode: string | null): void {
    if (this.currentMode) {
      const { start, mode: oldMode } = this.currentMode;
      const classIndex = oldMode.startsWith('Thread') ? 7 : oldMode.startsWith('IRQ') ? 8 : 9;
      this.put(start, this.startSample, this.outAnn, [classIndex, [oldMode]]);
    }
    this.currentMode = mode === null ? null : { start: this.startSample, mode };
  }

  private handleHardware(buffer: readonly number[]): AnnotationData | null {
    const payloadLength = [0, 1, 2, 4][buffer[0]! & 0x03]!;
    if (buffer.length !== payloadLength + 1) return null;
    const pid = buffer[0]! >> 3;
    if (pid === 0) {
      let text = 'DWT events:';
      if (buffer[1]! & 0x20) text += ' Cyc';
      if (buffer[1]! & 0x10) text += ' Fold';
      if (buffer[1]! & 0x08) text += ' LSU';
      if (buffer[1]! & 0x04) text += ' Sleep';
      if (buffer[1]! & 0x02) text += ' Exc';
      if (buffer[1]! & 0x01) text += ' CPI';
      return [3, [text]];
    }
    if (pid === 1) {
      const exceptionNumber = ((buffer[2]! & 1) << 8) | buffer[1]!;
      const event = buffer[2]! >> 4;
      const name = ARM_EXCEPTIONS.get(exceptionNumber) ?? `IRQ ${exceptionNumber - 16}`;
      if (event === 1) {
        this.modeChange(name);
        return [5, [`Enter: ${name}`, `E ${name}`]];
      }
      if (event === 2) {
        this.modeChange(null);
        return [5, [`Exit: ${name}`, `X ${name}`]];
      }
      if (event === 3) {
        this.modeChange(name);
        return [5, [`Resume: ${name}`, `R ${name}`]];
      }
      return this.fallback(buffer);
    }
    if (pid === 2) {
      const pc = (buffer[1]! | (buffer[2]! << 8) | (buffer[3]! << 16) | (buffer[4]! << 24)) >>> 0;
      return [6, [`PC: 0x${pc.toString(16).padStart(8, '0')}`]];
    }
    if ((buffer[0]! & 0xc4) === 0x84) {
      const comparator = (buffer[0]! & 0x30) >> 4;
      const operation = (buffer[0]! & 0x08) === 0 ? 'Read' : 'Write';
      let data: string;
      if (payloadLength === 1) data = buffer[1]!.toString(16).padStart(2, '0');
      else if (payloadLength === 2) data = (buffer[1]! | (buffer[2]! << 8)).toString(16).padStart(4, '0');
      else
        data =
          (buffer[1]! | (buffer[2]! << 8) | (buffer[3]! << 16) | (buffer[4]! << 24)) >>> 0
            ? ((buffer[1]! | (buffer[2]! << 8) | (buffer[3]! << 16) | (buffer[4]! << 24)) >>> 0)
                .toString(16)
                .padStart(8, '0')
            : '00000000';
      return [
        4,
        [`Watchpoint ${comparator}: ${operation} data 0x${data}`, `WP${comparator}: ${operation[0]} 0x${data}`],
      ];
    }
    if ((buffer[0]! & 0xcf) === 0x47) {
      const comparator = (buffer[0]! & 0x30) >> 4;
      const address = (buffer[1]! | (buffer[2]! << 8) | (buffer[3]! << 16) | (buffer[4]! << 24)) >>> 0;
      const text = address.toString(16).padStart(8, '0');
      return [4, [`Watchpoint ${comparator}: PC 0x${text}`, `WP${comparator}: PC 0x${text}`]];
    }
    if ((buffer[0]! & 0xcf) === 0x4e) {
      const comparator = (buffer[0]! & 0x30) >> 4;
      const offset = buffer[1]! | (buffer[2]! << 8);
      return [
        4,
        [
          `Watchpoint ${comparator}: address 0x????${offset.toString(16).padStart(4, '0')}`,
          `WP${comparator}: A 0x${offset.toString(16).padStart(4, '0')}`,
        ],
      ];
    }
    return this.fallback(buffer);
  }

  private addDelayedSoftware(pid: number, character: string): void {
    const packet = this.softwarePackets.get(pid);
    if (packet) {
      packet.previousTime = this.previousSample;
      packet.text += character;
    } else {
      this.softwarePackets.set(pid, {
        start: this.startSample,
        previousTime: this.previousSample,
        text: character,
      });
    }
  }

  private pushDelayedSoftware(): void {
    for (const [pid, packet] of this.softwarePackets) {
      if (!packet) continue;
      if (this.previousSample - packet.previousTime > 16n * this.byteLength) {
        this.put(packet.start, packet.previousTime, this.outAnn, [2, [`${pid}: "${packet.text}"`]]);
        this.softwarePackets.set(pid, null);
      }
    }
  }

  private handleSoftware(buffer: readonly number[]): PacketOutput {
    const payloadLength = [0, 1, 2, 4][buffer[0]! & 0x03]!;
    if (buffer.length !== payloadLength + 1) return null;
    const pid = buffer[0]! >> 3;
    const value = buffer[1] ?? -1;
    if (payloadLength === 1 && ((value >= 0x20 && value <= 0x7e) || (value >= 0x09 && value <= 0x0d))) {
      this.addDelayedSoftware(pid, String.fromCharCode(value));
      return [];
    }
    this.pushDelayedSoftware();
    if (payloadLength === 1) return [2, [`${pid}: 0x${buffer[1]!.toString(16).padStart(2, '0')}`]];
    if (payloadLength === 2)
      return [2, [`${pid}: 0x${buffer[2]!.toString(16).padStart(2, '0')}${buffer[1]!.toString(16).padStart(2, '0')}`]];
    if (payloadLength === 4)
      return [
        2,
        [
          `${pid}: 0x${buffer[4]!.toString(16).padStart(2, '0')}${buffer[3]!
            .toString(16)
            .padStart(2, '0')}${buffer[2]!.toString(16).padStart(2, '0')}${buffer[1]!.toString(16).padStart(2, '0')}`,
        ],
      ];
    return [];
  }

  private handleTimestamp(buffer: readonly number[]): AnnotationData | null {
    if ((buffer[buffer.length - 1]! & 0x80) !== 0) return null;
    let timestampClass = 0;
    let timestamp = 0;
    if ((buffer[0]! & 0x80) === 0) {
      timestamp = buffer[0]! >> 4;
    } else {
      timestampClass = (buffer[0]! & 0x30) >> 4;
      timestamp = buffer[1]! & 0x7f;
      if (buffer.length > 2) timestamp |= (buffer[2]! & 0x7f) << 7;
      if (buffer.length > 3) timestamp |= (buffer[3]! & 0x7f) << 14;
      if (buffer.length > 4) timestamp |= (buffer[4]! & 0x7f) << 21;
    }
    this.dwtTimestamp += timestamp;
    const description =
      timestampClass === 0
        ? '(exact)'
        : timestampClass === 1
          ? '(timestamp delayed)'
          : timestampClass === 2
            ? '(event delayed)'
            : '(event and timestamp delayed)';
    return [1, [`Timestamp: ${this.dwtTimestamp} ${description}`]];
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const [packetType, , payload] = data as UartData;
    if (packetType !== 'DATA') return;
    const value = payload[0];
    this.byteLength = es - ss;
    if (ss - this.previousSample > 16n * this.byteLength) {
      this.pushDelayedSoftware();
      this.buffer = [];
    }
    this.previousSample = es;
    this.buffer.push(value);
    if (this.buffer.length === 1) this.startSample = ss;

    this.syncBuffer = [...this.syncBuffer.slice(-5), value];
    if (this.syncBuffer.join(',') === '0,0,0,0,0,128') this.buffer = [...this.syncBuffer];

    const type = this.packetType(this.buffer[0]!);
    let output: PacketOutput;
    if (type === 'overflow') output = [0, ['Overflow']];
    else if (type === 'timestamp') output = this.handleTimestamp(this.buffer);
    else if (type === 'software') output = this.handleSoftware(this.buffer);
    else if (type === 'hardware') output = this.handleHardware(this.buffer);
    else output = this.fallback(this.buffer);

    if (output !== null) {
      if (output.length === 2) this.put(this.startSample, es, this.outAnn, output);
      this.buffer = [];
    }
  }
}

export default ArmItmDecoder;
