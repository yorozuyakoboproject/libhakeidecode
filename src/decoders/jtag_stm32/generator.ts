import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Stm32Step {
  readonly tms: 0 | 1;
  readonly tdi: 0 | 1;
  readonly tdo: 0 | 1;
}

export interface Stm32Case extends RoundtripCase<Stm32Step> {}

const CHANNELS = { tdi: 0, tdo: 1, tck: 2, tms: 3 } as const;
const SAMPLE_RATE = 2_000_000;
const RISE_DELAY = 2n;
const RISE_PERIOD = 2n;
const SUMMARY: ExpectedFrame = { protoId: 'jtag_stm32', kind: 'summary' };

const IR: Readonly<Record<string, string>> = {
  '1111': 'BYPASS',
  '1110': 'IDCODE',
  '1010': 'DPACC',
  '1011': 'APACC',
  '1000': 'ABORT',
};
const VERSION: Readonly<Record<number, string>> = { 0x3: 'JTAG-DP', 0x2: 'SW-DP' };
const PART: Readonly<Record<number, string>> = { 0xba00: 'JTAG-DP', 0xba10: 'SW-DP' };
const JEDEC: Readonly<Record<number, Readonly<Record<number, string>>>> = { 5: { 0x3b: 'ARM Ltd.' } };
const DP_REGISTER: Readonly<Record<string, string>> = {
  '00': 'Reserved',
  '01': 'DP CTRL/STAT',
  '10': 'DP SELECT',
  '11': 'DP RDBUFF',
};
const ACK: Readonly<Record<string, string>> = { '001': 'WAIT', '010': 'OK/FAULT' };

interface Scan {
  readonly firstEdge: number;
  readonly ss: bigint;
  readonly es: bigint;
  readonly bits: string;
  readonly bitsOut: string;
}

function bits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >>> index) & 1);
}

function binary(value: number, width: number): string {
  return (value >>> 0).toString(2).padStart(width, '0').slice(-width);
}

function lowerHex(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}

class Session {
  private edge = 0;
  private steps: Stm32Step[] = [];
  private annotations: ExpectedFrame[] = [];
  private payload = 0;
  private state = 'IDLE';

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
    const firstEdge = this.edge;
    for (let index = 0; index < input.length; index++)
      this.add(index === input.length - 1 ? 1 : 0, input[index], output[index]);
    const update = this.edge;
    this.add(1);
    this.add(0);
    this.payload += input.length;
    return {
      firstEdge,
      ss: this.rise(firstEdge),
      es: this.rise(update),
      bits: [...input].reverse().join(''),
      bitsOut: [...output].reverse().join(''),
    };
  }

  private span(scan: Scan, start: number, end: number): readonly [bigint, bigint] {
    return [this.rise(scan.firstEdge + start), this.rise(scan.firstEdge + end + 1)];
  }

  instruction(code: number, bsCode = 0b11111): void {
    const result = this.scan('IR', [...bits(code, 4), ...bits(bsCode, 5)], bits(0, 9));
    const bs = binary(bsCode, 5) === '11111' ? 'BYPASS' : 'UNKNOWN';
    this.state = IR[binary(code, 4)] ?? 'UNKNOWN';
    const bsSpan = this.span(result, 4, 8);
    const m3Span = this.span(result, 0, 3);
    this.annotate(1, [`IR (BS TAP): ${bs}`], bsSpan[0], bsSpan[1]);
    this.annotate(1, [`IR (M3 TAP): ${this.state}`], m3Span[0], m3Span[1]);
    this.annotate(2, [`IR: ${this.state}`], result.ss, result.es);
  }

  idcode(id: number): void {
    const result = this.scan('DR', bits(0, 33), [...bits(id, 32), 0]);
    if (this.state !== 'IDCODE') return;
    const version = VERSION[(id >>> 28) & 0xf] ?? 'UNKNOWN';
    const part = PART[(id >>> 12) & 0xffff] ?? 'UNKNOWN';
    const continuation = (id >>> 8) & 0xf;
    const identity = (id >>> 1) & 0x7f;
    const manufacturer = JEDEC[continuation + 1]?.[identity] ?? 'UNKNOWN';
    const fields: readonly (readonly [number, number, number, readonly string[]])[] = [
      [0, 0, 1, ['Reserved', 'Res', 'R']],
      [8, 11, 0, [`Continuation code: ${lowerHex(continuation)}`, 'CC', 'C']],
      [1, 7, 0, [`Identity code: ${lowerHex(identity)}`, 'IC', 'I']],
      [1, 11, 1, [`Manufacturer: ${manufacturer}`, 'Manuf', 'M']],
      [12, 27, 1, [`Part: ${part}`, 'Part', 'P']],
      [28, 31, 1, [`Version: ${version}`, 'Version', 'V']],
      [32, 32, 1, ['BYPASS (BS TAP)', 'BS', 'B']],
    ];
    for (const [start, end, classIndex, texts] of fields) {
      const span = this.span(result, start, end);
      this.annotate(classIndex, texts, span[0], span[1]);
    }
    this.annotate(2, [`IDCODE: ${lowerHex(id)} (${manufacturer}: ${version}/${part})`], result.ss, result.es);
    this.state = 'IDLE';
  }

  bypass(input: readonly number[]): void {
    const result = this.scan('DR', input, bits(0, input.length));
    if (this.state !== 'BYPASS') return;
    this.annotate(0, [`BYPASS: ${result.bits}`], result.ss, result.es);
    this.state = 'IDLE';
  }

  dpacc(request: readonly number[], response: readonly number[], description: string): void {
    const result = this.scan('DR', request, response);
    if (this.state !== 'DPACC') return;
    this.annotate(2, [description], result.ss, result.es);
    this.annotate(2, [responseText(response)], result.ss, result.es);
    this.state = 'IDLE';
  }

  apacc(request: readonly number[], response: readonly number[], description: string): void {
    const result = this.scan('DR', request, response);
    if (this.state !== 'APACC') return;
    this.annotate(2, [description], result.ss, result.es);
    this.annotate(2, [responseText(response)], result.ss, result.es);
    this.state = 'IDLE';
  }

  abort(input: readonly number[]): void {
    const result = this.scan('DR', bits(0, input.length), input);
    if (this.state !== 'ABORT') return;
    const abort = result.bitsOut.slice(1);
    this.annotate(
      2,
      [`DAPABORT = ${abort[0]}: ${abort[0] === '1' ? '' : 'No '}DAP abort generated`],
      result.ss,
      result.es,
    );
    if (abort.slice(0, -1) !== '0'.repeat(31))
      this.annotate(3, ['WARNING: DAPABORT[31:1] reserved!'], result.ss, result.es);
    this.state = 'IDLE';
  }

  unknown(input: readonly number[]): void {
    const result = this.scan('DR', bits(0, input.length), input);
    if (this.state !== 'UNKNOWN') return;
    this.annotate(2, [`Unknown instruction: ${result.bitsOut.slice(1)}`], result.ss, result.es);
    this.state = 'IDLE';
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

function dpRequest(data: number, address: number, read: boolean): number[] {
  const wire = Array.from({ length: 36 }, () => 0);
  for (let index = 0; index < 32; index++) wire[index + 3] = (data >>> index) & 1;
  wire[1] = address & 1;
  wire[2] = (address >>> 1) & 1;
  wire[0] = read ? 1 : 0;
  return wire;
}

function dpResponse(data: number, ack: string): number[] {
  const wire = Array.from({ length: 36 }, () => 0);
  for (let index = 0; index < 32; index++) wire[index + 3] = (data >>> index) & 1;
  for (let index = 0; index < 3; index++) wire[index] = Number(ack[2 - index]);
  return wire;
}

function requestText(data: number, address: string, read: boolean): string {
  return `New transaction: DATA: ${lowerHex(data)}, A: ${address}, RnW: ${read ? 'Read request' : 'Write request'}`;
}

function responseText(wire: readonly number[]): string {
  const data = wire.slice(3, 35).reduce((value, bit, index) => value + bit * 2 ** index, 0) >>> 0;
  const ack = [wire[2], wire[1], wire[0]].join('');
  return `Previous transaction result: DATA: ${lowerHex(data)}, ACK: ${ACK[ack] ?? 'Reserved'}`;
}

function randomBits(random: () => number, count: number): number[] {
  return Array.from({ length: count }, () => random() & 1);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53544d33,
}: GenerationOptions = {}): Iterable<Stm32Case> {
  yield {
    name: 'boundary-idcode-bypass-and-unknown',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 11n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 19, 257],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'jtag', options: {} }],
    *generate() {
      const session = new Session(11n);
      session.instruction(0xe);
      session.idcode(0x3ba00477);
      session.instruction(0xf);
      session.bypass([1, 0, 1, 1]);
      session.instruction(0, 0b00011);
      session.unknown(bits(0xa5, 8));
      yield session.take(true);
    },
  };

  yield {
    name: 'boundary-dp-ap-and-abort',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 29n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 23, 509],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'jtag', options: {} }],
    *generate() {
      const session = new Session(29n);
      const dpRequestBits = dpRequest(0x12345678, 1, true);
      const dpResponseBits = dpResponse(0x87654321, '001');
      session.instruction(0xa);
      session.dpacc(dpRequestBits, dpResponseBits, requestText(0x12345678, DP_REGISTER['01']!, true));
      const apRequestBits = dpRequest(0x0badf00d, 2, false);
      const apResponseBits = dpResponse(0xfeedface, '010');
      session.instruction(0xb);
      session.apacc(apRequestBits, apResponseBits, requestText(0x0badf00d, '10', false));
      session.instruction(0x8);
      const abortBits = bits(0, 33);
      abortBits[31] = 1;
      session.abort(abortBits);
      session.instruction(0x8);
      session.abort(bits(0, 33));
      yield session.take(true);
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerBypass = 2048;
  const iterationsPerBlock = 8;
  const payloadPerBlock = iterationsPerBlock * (9 + bitsPerBypass);
  const blocks = Math.ceil(required / payloadPerBlock);
  yield {
    name: 'seeded-long-bypass-stream',
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
      for (let block = 0; block < blocks; block++) {
        for (let iteration = 0; iteration < iterationsPerBlock; iteration++) {
          session.instruction(0xf);
          session.bypass(randomBits(random, bitsPerBypass));
        }
        yield session.take(block === 0, payloadPerBlock);
      }
    },
  };
}
