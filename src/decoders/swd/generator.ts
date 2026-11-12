import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface SwdStep {
  readonly swclk: 0 | 1;
  readonly swdio: 0 | 1;
}

export interface SwdCase extends RoundtripCase<SwdStep> {}

interface Transaction {
  readonly apdp: 'AP' | 'DP';
  readonly rw: 'R' | 'W';
  readonly addr: number;
  readonly data: number;
  readonly ack?: 'OK' | 'WAIT' | 'FAULT' | 'NOREPLY' | 'ERROR';
  readonly parityError?: boolean;
}

const CHANNELS = { swclk: 0, swdio: 1 } as const;
const SAMPLE_RATE = 2_000_000;
const SWITCH = '0111100111100111';

function addressText(apdp: 'AP' | 'DP', rw: 'R' | 'W', addr: number, ctrlsel: number): string {
  if (apdp === 'AP') return `${rw} AP${addr.toString(16)}`;
  if (rw === 'R') {
    if (addr === 0) return 'IDCODE';
    if (addr === 4) return ctrlsel === 0 ? 'R CTRL/STAT' : 'R DLCR';
    if (addr === 8) return 'RESEND';
    if (addr === 12) return 'RDBUFF';
  } else {
    if (addr === 0) return 'W ABORT';
    if (addr === 4) return ctrlsel === 0 ? 'W CTRL/STAT' : 'W DLCR';
    if (addr === 8) return 'W SELECT';
    if (addr === 12) return 'W RESERVED';
  }
  return '?';
}

function requestBits(apdp: 'AP' | 'DP', rw: 'R' | 'W', addr: number): number[] {
  const a0 = (addr >>> 2) & 1,
    a1 = (addr >>> 3) & 1,
    ap = apdp === 'AP' ? 1 : 0,
    write = rw === 'R' ? 1 : 0,
    parity = (ap + write + a0 + a1) % 2;
  return [1, ap, write, a0, a1, parity, 0, 1];
}

function valueBits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >>> index) & 1);
}

function parity(value: number): number {
  let count = 0;
  for (; value > 0; value >>>= 1) count ^= value & 1;
  return count;
}

class Session {
  private steps: SwdStep[] = [];
  private frames: ExpectedFrame[] = [];
  private annotations: ExpectedFrame[] = [];
  private payload = 0;
  private ctrlsel = 0;
  private orundetect = 0;
  private lastData: number | string = '';
  private nextSample: bigint;

  constructor(startSample: bigint) {
    this.nextSample = startSample;
  }

  private sample(): bigint {
    this.nextSample += 1n;
    return this.nextSample;
  }

  private add(clock: 0 | 1, dio: 0 | 1): bigint {
    const sample = this.sample();
    this.steps.push({ swclk: clock, swdio: dio });
    return sample;
  }

  private cycle(dio: 0 | 1): { fall: bigint; rise: bigint } {
    const fall = this.add(0, dio),
      rise = this.add(1, dio);
    return { fall, rise };
  }

  private annotation(classIndex: number, texts: readonly string[]): void {
    this.annotations.push({ classIndex, texts });
  }

  resetLine(high = 51): void {
    for (let index = 0; index < high; index++) this.cycle(1);
    this.cycle(0);
    this.cycle(0);
    this.annotation(0, ['LINERESET']);
    this.frames.push({ protoId: 'swd', kind: 'protocol', data: ['LINE_RESET', null] });
    this.lastData = '';
    this.payload += high + 2;
  }

  enable(): void {
    for (const bit of SWITCH) this.cycle(bit === '1' ? 1 : 0);
    this.annotation(1, ['JTAG->SWD']);
    this.payload += 16;
  }

  transaction(transaction: Transaction): void {
    const request = requestBits(transaction.apdp, transaction.rw, transaction.addr),
      rising: bigint[] = [];
    for (const bit of request) rising.push(this.cycle(bit === 1 ? 1 : 0).rise);
    const requestStart = rising[0]!;
    this.annotation(transaction.rw === 'R' ? 2 : 3, [
      addressText(transaction.apdp, transaction.rw, transaction.addr, this.ctrlsel),
    ]);
    const ack = transaction.ack ?? 'OK';
    this.cycle(0);
    const ackBits =
      ack === 'OK'
        ? [1, 0, 0]
        : ack === 'WAIT'
          ? [0, 1, 0]
          : ack === 'FAULT'
            ? [0, 0, 1]
            : ack === 'NOREPLY'
              ? [1, 1, 1]
              : [1, 1, 0];
    const ackSamples = ackBits.map((bit) => this.cycle(bit === 1 ? 1 : 0).fall);
    this.annotation(4, [ack]);
    this.payload += 11;

    if (ack !== 'OK') {
      if ((ack === 'WAIT' || ack === 'FAULT') && this.orundetect === 1) {
        this.dataPhase(transaction, ack, requestStart);
        return;
      }
      const kind = `${transaction.apdp}_${transaction.rw === 'R' ? 'READ' : 'WRITE'}`;
      this.frames.push({
        protoId: 'swd',
        kind: 'protocol',
        ss: requestStart,
        es: ackSamples[2],
        data: [kind, [transaction.addr, this.lastData, ack]],
      });
      this.lastData = '';
      if (ack === 'WAIT' || ack === 'FAULT') this.cycle(0);
      return;
    }

    this.dataPhase(transaction, ack, requestStart);
  }

  private dataPhase(transaction: Transaction, ack: string, requestStart: bigint): void {
    if (transaction.rw === 'W') this.cycle(0);
    const bits = valueBits(transaction.data, 32);
    for (let index = 0; index < bits.length; index++) {
      const dio = bits[index] === 1 ? 1 : 0;
      this.cycle(dio);
    }
    let parityValue = parity(transaction.data);
    if (transaction.parityError) parityValue ^= 1;
    const paritySample =
      transaction.rw === 'W' ? this.cycle(parityValue === 1 ? 1 : 0).rise : this.cycle(parityValue === 1 ? 1 : 0).fall;
    this.annotation(5, [`0x${transaction.data.toString(16).padStart(8, '0')}`]);
    if (transaction.parityError) this.annotation(6, [String(parity(transaction.data)) + String(parityValue)]);
    const kind = `${transaction.apdp}_${transaction.rw === 'R' ? 'READ' : 'WRITE'}`;
    this.frames.push({
      protoId: 'swd',
      kind: 'protocol',
      ss: requestStart,
      es: paritySample,
      data: [kind, [transaction.addr, transaction.data, ack]],
    });
    this.lastData = transaction.data;
    if (transaction.rw === 'W' && !transaction.parityError) {
      if (transaction.apdp === 'DP' && transaction.addr === 8) this.ctrlsel = transaction.data & 1;
      else if (transaction.apdp === 'DP' && transaction.addr === 4 && this.ctrlsel === 0)
        this.orundetect = transaction.data & 1;
    }
    if (transaction.rw === 'R') this.cycle(0);
    this.payload += 33;
  }

  take(): { data: SwdStep[]; expected: ExpectedFrame[]; expectedAnnotations: ExpectedFrame[]; payloadBits: number } {
    const block = {
      data: this.steps,
      expected: this.frames,
      expectedAnnotations: this.annotations,
      payloadBits: this.payload,
    };
    this.steps = [];
    this.frames = [];
    this.annotations = [];
    this.payload = 0;
    return block;
  }
}

function randomValue(random: () => number): number {
  return random() >>> 0;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x535744,
}: GenerationOptions = {}): Iterable<SwdCase> {
  yield {
    name: 'boundary-reset-enable-and-transactions',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 11n,
    channels: CHANNELS,
    options: { strict_start: 'yes' },
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const session = new Session(11n);
      session.resetLine();
      session.enable();
      session.transaction({ apdp: 'DP', rw: 'R', addr: 0, data: 0x2ba01477 });
      session.transaction({ apdp: 'DP', rw: 'W', addr: 8, data: 1 });
      session.transaction({ apdp: 'DP', rw: 'W', addr: 4, data: 0x50000002 });
      session.transaction({ apdp: 'AP', rw: 'W', addr: 0, data: 0x23000012 });
      session.transaction({ apdp: 'AP', rw: 'R', addr: 12, data: 0x12345678 });
      yield session.take();
    },
  };

  yield {
    name: 'boundary-ack-errors-and-parity',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: { strict_start: 'no' },
    chunkSamples: [1, 17, 257],
    minimumPayloadBits: 0,
    *generate() {
      const session = new Session(9_007_199_254_740_990n);
      session.resetLine();
      session.transaction({ apdp: 'DP', rw: 'W', addr: 0, data: 0x1e, ack: 'WAIT' });
      session.transaction({ apdp: 'DP', rw: 'R', addr: 4, data: 0xf0000000, ack: 'FAULT' });
      session.transaction({ apdp: 'AP', rw: 'W', addr: 4, data: 0xabcdef01, ack: 'NOREPLY' });
      session.transaction({ apdp: 'AP', rw: 'R', addr: 0, data: 0x87654321, ack: 'ERROR' });
      session.transaction({ apdp: 'AP', rw: 'W', addr: 12, data: 0x0badf00d, parityError: true });
      yield session.take();
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const transactionsPerBlock = 128;
  const payloadPerBlock = transactionsPerBlock * 44;
  const blocks = Math.ceil(required / payloadPerBlock);
  yield {
    name: 'seeded-long-ap-transactions',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: { strict_start: 'no' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      const session = new Session(0n);
      session.resetLine();
      for (let block = 0; block < blocks; block++) {
        for (let index = 0; index < transactionsPerBlock; index++) {
          session.transaction({
            apdp: 'AP',
            rw: (block * transactionsPerBlock + index) % 2 === 0 ? 'W' : 'R',
            addr: (random() & 3) << 2,
            data: randomValue(random),
          });
        }
        yield session.take();
      }
    },
  };
}
