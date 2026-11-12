import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { JtagSampleInterval, JtagState } from './index.js';

export interface JtagCaptureStep {
  readonly tms: 0 | 1;
  readonly tdi: 0 | 1;
  readonly tdo: 0 | 1;
}

export interface JtagCase extends RoundtripCase<JtagCaptureStep> {}

const NEXT: Readonly<Record<JtagState, readonly [JtagState, JtagState]>> = {
  'TEST-LOGIC-RESET': ['RUN-TEST/IDLE', 'TEST-LOGIC-RESET'],
  'RUN-TEST/IDLE': ['RUN-TEST/IDLE', 'SELECT-DR-SCAN'],
  'SELECT-DR-SCAN': ['CAPTURE-DR', 'SELECT-IR-SCAN'],
  'CAPTURE-DR': ['SHIFT-DR', 'EXIT1-DR'],
  'UPDATE-DR': ['RUN-TEST/IDLE', 'SELECT-DR-SCAN'],
  'PAUSE-DR': ['PAUSE-DR', 'EXIT2-DR'],
  'SHIFT-DR': ['SHIFT-DR', 'EXIT1-DR'],
  'EXIT1-DR': ['PAUSE-DR', 'UPDATE-DR'],
  'EXIT2-DR': ['SHIFT-DR', 'UPDATE-DR'],
  'SELECT-IR-SCAN': ['CAPTURE-IR', 'TEST-LOGIC-RESET'],
  'CAPTURE-IR': ['SHIFT-IR', 'EXIT1-IR'],
  'UPDATE-IR': ['RUN-TEST/IDLE', 'SELECT-DR-SCAN'],
  'PAUSE-IR': ['PAUSE-IR', 'EXIT2-IR'],
  'SHIFT-IR': ['SHIFT-IR', 'EXIT1-IR'],
  'EXIT1-IR': ['PAUSE-IR', 'UPDATE-IR'],
  'EXIT2-IR': ['SHIFT-IR', 'UPDATE-IR'],
};

const CHANNELS = { tdi: 0, tdo: 1, tck: 2, tms: 3 } as const;
const SAMPLE_RATE = 2_000_000;
const RISE_DELAY = 2n;
const RISE_PERIOD = 2n;

class Capture {
  private state: JtagState = 'RUN-TEST/IDLE';
  private edge = 0;
  private first = true;
  private previousRise = 0n;
  private oldState: JtagState | null = null;
  private priorState: JtagState | null = null;
  private bitsTdi: number[] = [];
  private bitsTdo: number[] = [];
  private intervalsTdi: [bigint, bigint][] = [];
  private intervalsTdo: [bigint, bigint][] = [];
  private ssBitstring = 0n;
  private firstBit = true;
  private steps: JtagCaptureStep[] = [];
  private frames: ExpectedFrame[] = [];

  constructor(private readonly startSample: bigint) {}

  private rise(index = this.edge): bigint {
    return this.startSample + RISE_DELAY + RISE_PERIOD * BigInt(index);
  }

  add(tms: 0 | 1, tdi = 0, tdo = 0): void {
    const step = { tms, tdi: (tdi & 1) as 0 | 1, tdo: (tdo & 1) as 0 | 1 };
    const sample = this.rise();
    this.steps.push(step);
    this.priorState = this.oldState;
    this.oldState = this.state;
    this.state = NEXT[this.state][tms];

    if (this.first) this.first = false;
    else
      this.frames.push({
        ss: this.previousRise,
        es: sample,
        protoId: 'jtag',
        kind: 'protocol',
        data: ['NEW STATE', this.state],
      });

    if (
      this.oldState === 'SHIFT-DR' ||
      this.oldState === 'SHIFT-IR' ||
      (this.oldState === 'EXIT1-DR' && this.priorState === 'SHIFT-DR') ||
      (this.oldState === 'EXIT1-IR' && this.priorState === 'SHIFT-IR')
    ) {
      if (this.firstBit) {
        this.ssBitstring = sample;
        this.firstBit = false;
      } else {
        const lastTdi = this.intervalsTdi.at(-1);
        const lastTdo = this.intervalsTdo.at(-1);
        if (lastTdi) lastTdi[1] = sample;
        if (lastTdo) lastTdo[1] = sample;
      }
      this.bitsTdi.push(tdi & 1);
      this.bitsTdo.push(tdo & 1);
      this.intervalsTdi.push([sample, sample]);
      this.intervalsTdo.push([sample, sample]);
    }

    if (this.state === 'UPDATE-DR' || this.state === 'UPDATE-IR')
      this.emitBitstrings(sample, this.state === 'UPDATE-DR' ? 'DR' : 'IR');
    this.previousRise = sample;
    this.edge++;
  }

  private emitBitstrings(sample: bigint, kind: 'DR' | 'IR'): void {
    this.emitBitstring(sample, kind, 'TDI', this.bitsTdi, this.intervalsTdi);
    this.emitBitstring(sample, kind, 'TDO', this.bitsTdo, this.intervalsTdo);
    this.bitsTdi = [];
    this.bitsTdo = [];
    this.intervalsTdi = [];
    this.intervalsTdo = [];
    this.firstBit = true;
    this.ssBitstring = sample;
  }

  private emitBitstring(
    sample: bigint,
    kind: 'DR' | 'IR',
    direction: 'TDI' | 'TDO',
    bits: number[],
    intervals: [bigint, bigint][],
  ): void {
    const data = [...bits].reverse().slice(1).join('');
    const positions = [...intervals]
      .reverse()
      .slice(1)
      .map(([ss, es]) => [ss, es] as JtagSampleInterval);
    this.frames.push({
      ss: this.ssBitstring,
      es: sample,
      protoId: 'jtag',
      kind: 'protocol',
      data: [`${kind} ${direction}`, [data, positions]],
    });
  }

  scan(kind: 'DR' | 'IR', tdi: readonly number[], tdo: readonly number[]): void {
    this.add(1);
    this.add(kind === 'IR' ? 1 : 0);
    if (kind === 'IR') this.add(0);
    this.add(0);
    for (let index = 0; index < tdi.length; index++) this.add(index === tdi.length - 1 ? 1 : 0, tdi[index], tdo[index]);
    this.add(1);
    this.add(0);
  }

  take(): { data: JtagCaptureStep[]; expected: ExpectedFrame[]; payloadBits: number } {
    const data = this.steps;
    const expected = this.frames;
    this.steps = [];
    this.frames = [];
    return { data, expected, payloadBits: data.length };
  }
}

function bits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >>> index) & 1);
}

function randomBits(random: () => number, count: number): number[] {
  return Array.from({ length: count }, () => random() & 1);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4a544147,
}: GenerationOptions = {}): Iterable<JtagCase> {
  yield {
    name: 'boundary-full-state-tree',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const capture = new Capture(9_007_199_254_740_990n);
      capture.add(0, 0, 1);
      for (const tms of [1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0] as const)
        capture.add(tms, tms, tms ^ 1);
      yield capture.take();
    },
  };

  yield {
    name: 'boundary-minimal-dr-and-ir',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 31n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 17, 257],
    minimumPayloadBits: 0,
    *generate() {
      const capture = new Capture(31n);
      capture.scan('DR', [1], [0]);
      capture.scan('IR', bits(0xa5, 8), bits(0x5a, 8));
      yield capture.take();
    },
  };

  yield {
    name: 'boundary-exit1-after-capture',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 63n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [5, 31, 509],
    minimumPayloadBits: 0,
    *generate() {
      const capture = new Capture(63n);
      capture.add(1);
      capture.add(0);
      capture.add(1);
      capture.add(0, 1, 0);
      capture.add(1);
      capture.add(0);
      capture.add(0, 0, 1);
      capture.add(0, 1, 0);
      capture.add(1, 0, 1);
      capture.add(1);

      capture.add(1);
      capture.add(1);
      capture.add(0);
      capture.add(1);
      capture.add(0, 0, 1);
      capture.add(1);
      capture.add(0);
      capture.add(0, 1, 0);
      capture.add(1, 0, 1);
      capture.add(1);
      yield capture.take();
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerScan = 1000;
  const scansPerBlock = 4;
  const payloadPerBlock = bitsPerScan * scansPerBlock;
  const blocks = Math.ceil(required / payloadPerBlock);
  yield {
    name: 'seeded-long-dr-ir-scans',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      const capture = new Capture(0n);
      for (let block = 0; block < blocks; block++) {
        for (let scan = 0; scan < scansPerBlock; scan++) {
          const kind = (block * scansPerBlock + scan) % 2 === 0 ? 'DR' : 'IR';
          capture.scan(kind, randomBits(random, bitsPerScan), randomBits(random, bitsPerScan));
        }
        const result = capture.take();
        yield { ...result, payloadBits: payloadPerBlock };
      }
    },
  };
}
