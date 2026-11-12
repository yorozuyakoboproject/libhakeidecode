import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import type { JtagBitstring, JtagProtocolPacket, JtagSampleInterval } from '../jtag/index.js';
import { descriptor } from './descriptor.js';

type Cm3State = 'IDLE' | 'BYPASS' | 'IDCODE' | 'DPACC' | 'APACC' | 'ABORT' | 'UNKNOWN';

const IR: Readonly<Record<string, Cm3State>> = {
  '1111': 'BYPASS',
  '1110': 'IDCODE',
  '1010': 'DPACC',
  '1011': 'APACC',
  '1000': 'ABORT',
};
const BS_IR: Readonly<Record<string, Cm3State>> = {
  '11111': 'BYPASS',
};
const VERSION: Readonly<Record<number, string>> = { 0x3: 'JTAG-DP', 0x2: 'SW-DP' };
const PART: Readonly<Record<number, string>> = { 0xba00: 'JTAG-DP', 0xba10: 'SW-DP' };
const JEDEC: Readonly<Record<number, Readonly<Record<number, string>>>> = {
  5: { 0x3b: 'ARM Ltd.' },
};
const ACK: Readonly<Record<string, string>> = {
  '001': 'WAIT',
  '010': 'OK/FAULT',
};
const DP_REGISTER: Readonly<Record<string, string>> = {
  '00': 'Reserved',
  '01': 'DP CTRL/STAT',
  '10': 'DP SELECT',
  '11': 'DP RDBUFF',
};

function binaryToInt(bits: string): number {
  return bits ? Number.parseInt(bits, 2) : 0;
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function decodeDeviceId(bits: string): readonly [string, string, string, string] {
  const id = binaryToInt(bits);
  const version = VERSION[binaryToInt(bits.slice(-32, -28))] ?? 'UNKNOWN';
  const part = PART[binaryToInt(bits.slice(-28, -12))] ?? 'UNKNOWN';
  const continuation = binaryToInt(bits.slice(-12, -8)) + 1;
  const manufacturer = JEDEC[continuation]?.[binaryToInt(bits.slice(-7, -1))] ?? 'UNKNOWN';
  return [hex(id), manufacturer, version, part];
}

function dataIn(instruction: 'DPACC' | 'APACC', bits: string): string {
  const data = binaryToInt(bits.slice(0, -3));
  const address = bits.slice(-3, -1);
  const read = bits.at(-1) === '1';
  const register = instruction === 'DPACC' ? DP_REGISTER[address] : address;
  return `New transaction: DATA: ${hex(data)}, A: ${register}, RnW: ${read ? 'Read request' : 'Write request'}`;
}

function dataOut(bits: string): string {
  const data = binaryToInt(bits.slice(0, -3));
  const ack = bits.slice(-3);
  return `Previous transaction result: DATA: ${hex(data)}, ACK: ${ACK[ack] ?? 'Reserved'}`;
}

export class JtagStm32Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private state: Cm3State = 'IDLE';
  private samples: readonly JtagSampleInterval[] = [];
  private ss = 0n;
  private es = 0n;

  override reset(): void {
    this.state = 'IDLE';
    this.samples = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putX(classIndex: number, texts: readonly string[]): void {
    this.put(this.ss, this.es, this.outAnn, [classIndex, texts]);
  }

  private putField(start: number, end: number, classIndex: number, texts: readonly string[]): void {
    const first = this.samples[start];
    const last = this.samples[end];
    if (!first || !last) return;
    this.put(first[0], last[1], this.outAnn, [classIndex, texts]);
  }

  private handleBypass(bits: string): void {
    this.putX(0, [`BYPASS: ${bits}`]);
  }

  private handleIdcode(bits: string): void {
    bits = bits.slice(1);
    const [id, manufacturer, version, part] = decodeDeviceId(bits);
    const continuation = hex(binaryToInt(bits.slice(-12, -8)));
    const identity = hex(binaryToInt(bits.slice(-7, -1)));
    this.putField(0, 0, 1, ['Reserved', 'Res', 'R']);
    this.putField(8, 11, 0, [`Continuation code: ${continuation}`, 'CC', 'C']);
    this.putField(1, 7, 0, [`Identity code: ${identity}`, 'IC', 'I']);
    this.putField(1, 11, 1, [`Manufacturer: ${manufacturer}`, 'Manuf', 'M']);
    this.putField(12, 27, 1, [`Part: ${part}`, 'Part', 'P']);
    this.putField(28, 31, 1, [`Version: ${version}`, 'Version', 'V']);
    this.putField(32, 32, 1, ['BYPASS (BS TAP)', 'BS', 'B']);
    this.putX(2, [`IDCODE: ${id} (${manufacturer}: ${version}/${part})`]);
  }

  private handleDpacc(bits: string, command: string): void {
    bits = bits.slice(1);
    this.putX(2, [command === 'DR TDI' ? dataIn('DPACC', bits) : dataOut(bits)]);
  }

  private handleApacc(bits: string, command: string): void {
    bits = bits.slice(1);
    this.putX(2, [command === 'DR TDI' ? dataIn('APACC', bits) : dataOut(bits)]);
  }

  private handleAbort(bits: string): void {
    bits = bits.slice(1);
    const generated = bits[0] === '1';
    this.putX(2, [`DAPABORT = ${bits[0]}: ${generated ? '' : 'No '}DAP abort generated`]);
    if (bits.slice(0, -1) !== '0'.repeat(31)) this.putX(3, ['WARNING: DAPABORT[31:1] reserved!']);
  }

  private handleUnknown(bits: string): void {
    this.putX(2, [`Unknown instruction: ${bits.slice(1)}`]);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || data.length < 2 || typeof data[0] !== 'string') return;
    const [command, value] = data as unknown as JtagProtocolPacket;
    this.ss = ss;
    this.es = es;
    let bits = '';
    if (command !== 'NEW STATE') {
      const payload = value as JtagBitstring;
      bits = payload[0];
      this.samples = [...payload[1]].reverse();
    }

    if (command === 'IR TDI') {
      this.state = IR[bits.slice(5, 9)] ?? 'UNKNOWN';
      const bsState = BS_IR[bits.slice(0, 5)] ?? 'UNKNOWN';
      this.putField(4, 8, 1, [`IR (BS TAP): ${bsState}`]);
      this.putField(0, 3, 1, [`IR (M3 TAP): ${this.state}`]);
      this.putX(2, [`IR: ${this.state}`]);
    }

    if (this.state === 'BYPASS') {
      if (command !== 'DR TDI') return;
      this.handleBypass(bits);
      this.state = 'IDLE';
    } else if (this.state === 'IDCODE' || this.state === 'ABORT' || this.state === 'UNKNOWN') {
      if (command !== 'DR TDO') return;
      if (this.state === 'IDCODE') this.handleIdcode(bits);
      else if (this.state === 'ABORT') this.handleAbort(bits);
      else this.handleUnknown(bits);
      this.state = 'IDLE';
    } else if (this.state === 'DPACC' || this.state === 'APACC') {
      if (command !== 'DR TDI' && command !== 'DR TDO') return;
      if (this.state === 'DPACC') this.handleDpacc(bits, command);
      else this.handleApacc(bits, command);
      if (command === 'DR TDO') this.state = 'IDLE';
    }
  }
}

export default JtagStm32Decoder;
