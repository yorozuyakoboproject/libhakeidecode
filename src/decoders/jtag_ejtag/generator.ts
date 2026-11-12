import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { JtagSampleInterval } from '../jtag/index.js';
import { EJTAG_CONTROL_FIELDS, EJTAG_INSTRUCTIONS, EJTAG_REGISTERS } from './index.js';

export interface EjtagStep {
  readonly tms: 0 | 1;
  readonly tdi: 0 | 1;
  readonly tdo: 0 | 1;
}

export interface EjtagCase extends RoundtripCase<EjtagStep> {}

const CHANNELS = { tdi: 0, tdo: 1, tck: 2, tms: 3 } as const;
const SAMPLE_RATE = 2_000_000;
const RISE_DELAY = 2n;
const RISE_PERIOD = 2n;
const SUMMARY: ExpectedFrame = { protoId: 'jtag_ejtag', kind: 'summary' };
const PRACC = 1 << 18;
const PRNW = 1 << 19;

const STATE = Object.freeze({
  RESET: 0,
  DEVICE_ID: 1,
  IMPLEMENTATION: 2,
  DATA: 3,
  ADDRESS: 4,
  CONTROL: 5,
  FASTDATA: 6,
} as const);
type State = (typeof STATE)[keyof typeof STATE];

const STATE_FROM_INSTRUCTION: Readonly<Record<number, State>> = {
  0x01: STATE.DEVICE_ID,
  0x03: STATE.IMPLEMENTATION,
  0x08: STATE.ADDRESS,
  0x09: STATE.DATA,
  0x0a: STATE.CONTROL,
  0x0e: STATE.FASTDATA,
};

const FASTDATA_WRITE = [
  ['0', 'SPrAcc: 0', 'Request completion of Fastdata access'],
  ['1', 'SPrAcc: 1', 'No effect'],
] as const;
const FASTDATA_READ = [
  ['0', 'SPrAcc: 0', 'Fastdata access failure'],
  ['1', 'SPrAcc: 1', 'Successful completion of Fastdata access'],
] as const;

interface Scan {
  readonly ss: bigint;
  readonly es: bigint;
  readonly bits: string;
  readonly bitsOut: string;
  readonly positions: readonly JtagSampleInterval[];
}

interface Pracc {
  addressOut: number | null;
  dataIn: number | null;
  dataOut: number | null;
  ss: bigint;
  es: bigint;
}

function bits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >>> index) & 1);
}

function bitsToInt(value: string): number {
  return value ? Number.parseInt(value, 2) : 0;
}

function hexByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

function hexWord(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

class Session {
  private edge = 0;
  private steps: EjtagStep[] = [];
  private annotations: ExpectedFrame[] = [];
  private payload = 0;
  private selected: State = STATE.RESET;
  private lastScan: Scan | null = null;
  private pracc: Pracc = { addressOut: null, dataIn: null, dataOut: null, ss: 0n, es: 0n };

  constructor(private readonly startSample: bigint) {}

  private rise(index = this.edge): bigint {
    return this.startSample + RISE_DELAY + RISE_PERIOD * BigInt(index);
  }

  private add(tms: 0 | 1, tdi = 0, tdo = 0): void {
    this.steps.push({ tms, tdi: (tdi & 1) as 0 | 1, tdo: (tdo & 1) as 0 | 1 });
    this.edge++;
  }

  private annotate(classIndex: number, texts: readonly string[], ss: bigint, es: bigint): void {
    this.annotations.push({ classIndex, texts, ss, es });
  }

  private scan(kind: 'DR' | 'IR', input: readonly number[], output: readonly number[]): Scan {
    this.add(1);
    this.add(kind === 'IR' ? 1 : 0);
    if (kind === 'IR') this.add(0);
    this.add(0);
    const first = this.edge;
    for (let index = 0; index < input.length; index++)
      this.add(index === input.length - 1 ? 1 : 0, input[index], output[index]);
    const update = this.edge;
    this.add(1);
    this.add(0);
    this.payload += input.length;
    const wirePositions = input.map((_, index) => [this.rise(first + index), this.rise(first + index + 1)] as const);
    return {
      ss: this.rise(first),
      es: this.rise(update),
      bits: [...input].reverse().join(''),
      bitsOut: [...output].reverse().join(''),
      positions: [...wirePositions].reverse(),
    };
  }

  instruction(code: number): void {
    const result = this.scan('IR', bits(code, 5), bits(0, 5));
    const description = EJTAG_INSTRUCTIONS[code];
    if (description) {
      const hex = hexByte(code);
      this.annotate(0, [`${description[0]}: ${description[1]} (${hex})`, description[0]], result.ss, result.es);
    } else {
      const hex = hexByte(code);
      this.annotate(0, [hex, `IR TDI (${hex})`], result.ss, result.es);
    }
    this.selected = STATE_FROM_INSTRUCTION[code] ?? STATE.RESET;
  }

  dr(input: readonly number[], output: readonly number[]): void {
    this.beforeDrUpdate();
    const result = this.scan('DR', input, output);
    this.lastScan = result;
    this.pracc.ss = result.ss;
    this.pracc.es = result.es;
    if (this.selected === STATE.ADDRESS) this.pracc.addressOut = bitsToInt(result.bitsOut);
    else if (this.selected === STATE.DATA) {
      this.pracc.dataIn = bitsToInt(result.bits);
      this.pracc.dataOut = bitsToInt(result.bitsOut);
    } else if (this.selected === STATE.FASTDATA) this.fastdata(result);
  }

  drValues(input: number, output: number, width = 32): void {
    this.dr(bits(input, width), bits(output, width));
  }

  private beforeDrUpdate(): void {
    if (!this.lastScan || this.selected === STATE.RESET) return;
    this.annotate(1 + this.selected, [EJTAG_REGISTERS[this.selected]!], this.lastScan.ss, this.lastScan.es);
    if (this.selected !== STATE.CONTROL) return;
    if (this.lastScan.positions.length !== 32) {
      this.annotate(1, ['Error: length != 32'], this.lastScan.ss, this.lastScan.es);
      return;
    }
    this.controlFields(this.lastScan, true);
    this.controlFields(this.lastScan, false);
    this.praccText(this.lastScan);
  }

  private controlFields(scan: Scan, write: boolean): void {
    const data = write ? scan.bits : scan.bitsOut;
    for (const field of EJTAG_CONTROL_FIELDS) {
      const descriptions = write ? field.write : field.read;
      if (!descriptions?.length) continue;
      const startBit = 31 - field.lsb;
      const endBit = 31 - field.msb;
      const start = scan.positions[startBit];
      const end = scan.positions[endBit];
      if (!start || !end) continue;
      const value = data.slice(endBit, startBit + 1);
      this.annotate(
        write ? 10 : 11,
        [descriptions[bitsToInt(value)] ?? '?', `${field.name}: ${value}`],
        start[0],
        end[1],
      );
    }
  }

  private praccText(scan: Scan): void {
    const controlIn = bitsToInt(scan.bits);
    const controlOut = bitsToInt(scan.bitsOut);
    if ((controlIn & PRACC) !== 0 || (controlOut & PRACC) === 0) return;
    const write = (controlOut & PRNW) !== 0;
    let text = `PrAcc: ${write ? 'Store' : 'Load/Fetch'}`;
    if (write) {
      if (this.pracc.addressOut !== null) text += `, A: ${hexWord(this.pracc.addressOut)}`;
      if (this.pracc.dataOut !== null) text += `, D: ${hexWord(this.pracc.dataOut)}`;
    } else {
      if (this.pracc.addressOut !== null) text += `, A: ${hexWord(this.pracc.addressOut)}`;
      if (this.pracc.dataIn !== null) text += `, D: ${hexWord(this.pracc.dataIn)}`;
    }
    this.annotate(12, [text], this.pracc.ss, this.pracc.es);
    this.pracc = { addressOut: null, dataIn: null, dataOut: null, ss: 0n, es: 0n };
  }

  private fastdata(scan: Scan): void {
    if (scan.bits.length < 33 || scan.positions.length < 33) return;
    const writeState = Number.parseInt(scan.bits[32]!, 2);
    const readState = Number.parseInt(scan.bitsOut[32]!, 2);
    const dataIn = bitsToInt(scan.bits.slice(0, 32));
    const dataOut = bitsToInt(scan.bitsOut.slice(0, 32));
    const stateIn = scan.positions[32]!;
    const stateOut = scan.positions[32]!;
    const firstData = scan.positions[31]!;
    const lastData = scan.positions[0]!;
    this.annotate(10, [...FASTDATA_WRITE[writeState]!], stateIn[0], stateIn[1]);
    this.annotate(10, [hexWord(dataIn)], firstData[0], lastData[1]);
    this.annotate(11, [...FASTDATA_READ[readState]!], stateOut[0], stateOut[1]);
    this.annotate(11, [hexWord(dataOut)], firstData[0], lastData[1]);
  }

  take(summary: boolean, payloadBits = this.payload) {
    const block = {
      data: this.steps,
      expected: summary ? [SUMMARY] : [],
      expectedAnnotations: this.annotations,
      annotationCount: this.annotations.length,
      payloadBits,
    };
    this.steps = [];
    this.annotations = [];
    this.payload = 0;
    return block;
  }
}

function randomBits(random: () => number, count: number): number[] {
  return Array.from({ length: count }, () => random() & 1);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x454a5441,
}: GenerationOptions = {}): Iterable<EjtagCase> {
  yield {
    name: 'boundary-instructions-and-registers',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 7n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 17, 257],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'jtag', options: {} }],
    *generate() {
      const session = new Session(7n);
      session.instruction(0x01);
      session.drValues(0x12345678, 0x3ba00477);
      session.drValues(1, 0, 1);
      session.instruction(0x03);
      session.drValues(0x0000abcd, 0x00001234);
      session.drValues(1, 0, 1);
      session.instruction(0x1f);
      session.drValues(0, 0, 1);
      yield session.take(true);
    },
  };

  yield {
    name: 'boundary-control-fields-and-pracc',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 23n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 31, 511],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'jtag', options: {} }],
    *generate() {
      const session = new Session(23n);
      const controlIn = (1 << 31) | (1 << 20);
      const controlOut =
        (1 << 31) |
        (2 << 29) |
        (1 << 23) |
        (1 << 21) |
        (1 << 18) |
        (1 << 15) |
        (1 << 14) |
        (1 << 13) |
        (1 << 12) |
        (1 << 3);
      session.instruction(0x08);
      session.drValues(0, 0x10000000);
      session.drValues(0, 0x10002000);
      session.instruction(0x09);
      session.drValues(controlIn, controlOut);
      session.drValues(controlIn, controlOut);
      session.instruction(0x0a);
      session.drValues(controlIn, controlOut);
      session.drValues(controlIn, controlOut);
      yield session.take(true);
    },
  };

  yield {
    name: 'boundary-fastdata',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 41n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 37, 257],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'jtag', options: {} }],
    *generate() {
      const session = new Session(41n);
      session.instruction(0x0e);
      session.dr([0, ...bits(0x12345678, 32)], [1, ...bits(0x9abcdef0, 32)]);
      session.dr([0, ...bits(0x0badf00d, 32)], [1, ...bits(0xfeedface, 32)]);
      yield session.take(true);
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerScan = 800;
  const scansPerBlock = 4;
  const payloadPerBlock = bitsPerScan * scansPerBlock;
  const blocks = Math.ceil(required / payloadPerBlock);
  yield {
    name: 'seeded-long-idcode-stream',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'jtag', options: {} }],
    *generate() {
      const random = randomWords(seed);
      const session = new Session(0n);
      session.instruction(0x01);
      for (let block = 0; block < blocks; block++) {
        for (let scan = 0; scan < scansPerBlock; scan++)
          session.dr(randomBits(random, bitsPerScan), randomBits(random, bitsPerScan));
        yield session.take(block === 0, payloadPerBlock);
      }
    },
  };
}
