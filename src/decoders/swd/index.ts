import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pin } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface SwdOptions {
  strict_start: 'yes' | 'no';
}

export type SwdPacket =
  | readonly ['LINE_RESET', null]
  | readonly ['AP_READ' | 'AP_WRITE' | 'DP_READ' | 'DP_WRITE', readonly [number, number | string, string | null]];

type SwdState = 'UNKNOWN' | 'REQ' | 'ACK' | 'DATA' | 'DPARITY';

const RISING = 1;
const FALLING = 0;
const ADDR_DP_SELECT = 0x8;
const ADDR_DP_CTRLSTAT = 0x4;
const BIT_SELECT_CTRLSEL = 1;
const BIT_CTRLSTAT_ORUNDETECT = 1;
const SWD_SWITCH = '0111100111100111';
const ANN = Object.freeze({
  RESET: 0,
  ENABLE: 1,
  READ: 2,
  WRITE: 3,
  ACK: 4,
  DATA: 5,
  PARITY: 6,
});

export class SwdDecoder extends Decoder<SwdOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outProtocol = -1;
  private state: SwdState = 'UNKNOWN';
  private sampleEdge = RISING;
  private ack: string | null = null;
  private ssRequest = 0n;
  private turnaround = 0;
  private bits = '';
  private samples: bigint[] = [];
  private lineResetCount = 0;
  private data: number | string = '';
  private addr: number | null = null;
  private rw: 'R' | 'W' | null = null;
  private apdp: 'AP' | 'DP' | null = null;
  private ctrlsel = 0;
  private orundetect = 0;
  private dparity = 0;

  override reset(): void {
    this.state = 'UNKNOWN';
    this.sampleEdge = RISING;
    this.ack = null;
    this.ssRequest = 0n;
    this.turnaround = 0;
    this.bits = '';
    this.samples = [];
    this.lineResetCount = 0;
    this.data = '';
    this.addr = null;
    this.rw = null;
    this.apdp = null;
    this.ctrlsel = 0;
    this.orundetect = 0;
    this.dparity = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'swd');
    if (this.options.strict_start === 'no') this.state = 'REQ';
  }

  private level(pin: Pin | undefined, name: string): 0 | 1 {
    if (pin !== 0 && pin !== 1) throw new Error(`SWD ${name} is not a digital level.`);
    return pin;
  }

  private putAnnotation(classIndex: number, length: number, text: string): void {
    const start =
      this.samples.length >= length ? this.samples[this.samples.length - length]! : (this.samples[0] ?? this.samplenum);
    if (this.state === 'REQ') this.ssRequest = start;
    this.put(start, this.samplenum, this.outAnn, [classIndex, [text]]);
  }

  private putPacket(packet: SwdPacket): void {
    this.put(this.ssRequest, this.samplenum, this.outProtocol, packet);
  }

  private putPacketData(): void {
    if (!this.apdp || !this.rw || this.addr === null) return;
    const type = `${this.apdp}_${this.rw === 'R' ? 'READ' : 'WRITE'}` as
      | 'AP_READ'
      | 'AP_WRITE'
      | 'DP_READ'
      | 'DP_WRITE';
    this.putPacket([type, [this.addr, this.data, this.ack]]);
  }

  private nextState(): void {
    this.bits = '';
    this.samples = [];
    this.lineResetCount = 0;
    if (this.state === 'UNKNOWN') {
      this.state = 'REQ';
      this.sampleEdge = RISING;
      this.turnaround = 0;
    } else if (this.state === 'REQ') {
      this.state = 'ACK';
      this.sampleEdge = FALLING;
      this.turnaround = 1;
    } else if (this.state === 'ACK') {
      this.state = 'DATA';
      this.sampleEdge = this.rw === 'W' ? RISING : FALLING;
      this.turnaround = this.rw === 'R' ? 0 : 2;
    } else if (this.state === 'DATA') {
      this.state = 'DPARITY';
    } else {
      this.putPacketData();
      this.state = 'REQ';
      this.sampleEdge = RISING;
      this.turnaround = this.rw === 'R' ? 1 : 0;
    }
  }

  private resetState(): void {
    if (this.state !== 'REQ') this.putPacketData();
    this.bits = '';
    this.samples = [];
    this.lineResetCount = 0;
    this.turnaround = 0;
    this.sampleEdge = RISING;
    this.data = '';
    this.ack = null;
    this.state = 'REQ';
  }

  private addressDescription(): string {
    if (this.apdp === 'DP') {
      if (this.rw === 'R') {
        if (this.addr === 0) return 'IDCODE';
        if (this.addr === 4) return this.ctrlsel === 0 ? 'R CTRL/STAT' : 'R DLCR';
        if (this.addr === 8) return 'RESEND';
        if (this.addr === 12) return 'RDBUFF';
      } else if (this.rw === 'W') {
        if (this.addr === 0) return 'W ABORT';
        if (this.addr === 4) return this.ctrlsel === 0 ? 'W CTRL/STAT' : 'W DLCR';
        if (this.addr === 8) return 'W SELECT';
        if (this.addr === 12) return 'W RESERVED';
      }
    } else if (this.apdp === 'AP') {
      if (this.rw === 'R') return `R AP${this.addr!.toString(16)}`;
      if (this.rw === 'W') return `W AP${this.addr!.toString(16)}`;
    }
    return `? ${this.rw ?? '?'}${this.apdp ?? '?'}${this.addr?.toString(16) ?? '?'}`;
  }

  private handleRequest(): void {
    if (this.bits.endsWith(SWD_SWITCH)) {
      this.putAnnotation(ANN.ENABLE, 16, 'JTAG->SWD');
      this.resetState();
      return;
    }
    if (this.bits.length < 8) return;
    const request = this.bits.slice(-8);
    if (request[0] !== '1' || request[6] !== '0' || request[7] !== '1') return;
    const apdp = request[1]!,
      rw = request[2]!,
      addressBits = request.slice(3, 5);
    this.rw = rw === '1' ? 'R' : 'W';
    this.apdp = apdp === '1' ? 'AP' : 'DP';
    this.addr = Number.parseInt([...addressBits].reverse().join(''), 2) << 2;
    this.putAnnotation(this.rw === 'R' ? ANN.READ : ANN.WRITE, 8, this.addressDescription());
    this.nextState();
  }

  private handleAck(): void {
    if (this.bits.length < 3) return;
    const ack = this.bits;
    if (ack === '100') {
      this.putAnnotation(ANN.ACK, 3, 'OK');
      this.ack = 'OK';
      this.nextState();
    } else if (ack === '001') {
      this.putAnnotation(ANN.ACK, 3, 'FAULT');
      this.ack = 'FAULT';
      if (this.orundetect === 1) this.nextState();
      else this.resetState();
      this.turnaround = 1;
    } else if (ack === '010') {
      this.putAnnotation(ANN.ACK, 3, 'WAIT');
      this.ack = 'WAIT';
      if (this.orundetect === 1) this.nextState();
      else this.resetState();
      this.turnaround = 1;
    } else if (ack === '111') {
      this.putAnnotation(ANN.ACK, 3, 'NOREPLY');
      this.ack = 'NOREPLY';
      this.resetState();
    } else {
      this.putAnnotation(ANN.ACK, 3, 'ERROR');
      this.ack = 'ERROR';
      this.resetState();
    }
  }

  private handleData(): void {
    if (this.bits.length < 32) return;
    this.data = 0;
    this.dparity = 0;
    for (let index = 0; index < 32; index++) {
      if (this.bits[index] === '1') {
        this.data += 2 ** index;
        this.dparity++;
      }
    }
    this.dparity %= 2;
    this.putAnnotation(ANN.DATA, 32, `0x${this.data.toString(16).padStart(8, '0')}`);
    this.nextState();
  }

  private handleDataParity(): void {
    if (String(this.dparity) !== this.bits) {
      this.putAnnotation(ANN.PARITY, 1, String(this.dparity) + this.bits);
    } else if (this.rw === 'W') {
      this.handleCompletedWrite();
    }
    this.nextState();
  }

  private handleCompletedWrite(): void {
    if (this.apdp !== 'DP' || typeof this.data !== 'number') return;
    if (this.addr === ADDR_DP_SELECT) this.ctrlsel = this.data & BIT_SELECT_CTRLSEL;
    else if (this.addr === ADDR_DP_CTRLSTAT && this.ctrlsel === 0)
      this.orundetect = this.data & BIT_CTRLSTAT_ORUNDETECT;
  }

  *decode(): LogicGenerator {
    while (true) {
      const pins = yield this.wait({ swclk: 'e' });
      const clock = this.level(pins[0], 'SWCLK'),
        dio = this.level(pins[1], 'SWDIO');
      if (clock === RISING) {
        if (dio === 1) this.lineResetCount++;
        else {
          if (this.lineResetCount >= 50) {
            this.putAnnotation(ANN.RESET, this.lineResetCount, 'LINERESET');
            this.putPacket(['LINE_RESET', null]);
            this.resetState();
          }
          this.lineResetCount = 0;
        }
      }
      if (clock !== this.sampleEdge) continue;
      if (this.turnaround > 0) {
        this.turnaround--;
        continue;
      }
      this.bits += String(dio);
      this.samples.push(this.samplenum);
      if (this.state === 'REQ') this.handleRequest();
      else if (this.state === 'ACK') this.handleAck();
      else if (this.state === 'DATA') this.handleData();
      else if (this.state === 'DPARITY') this.handleDataParity();
    }
  }
}

export default SwdDecoder;
