import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { CjtagSampleInterval, CjtagState } from './index.js';

export interface CjtagStep {
  readonly tckc: 0 | 1;
  readonly tmsc: 0 | 1;
}

export interface CjtagCase extends RoundtripCase<CjtagStep> {}

type JtagState = (typeof JTAG_STATES)[number];

const CHANNELS = { tckc: 0, tmsc: 1 } as const;
const SAMPLE_RATE = 2_000_000;
const JTAG_STATES = [
  'TEST-LOGIC-RESET',
  'RUN-TEST/IDLE',
  'SELECT-DR-SCAN',
  'CAPTURE-DR',
  'UPDATE-DR',
  'PAUSE-DR',
  'SHIFT-DR',
  'EXIT1-DR',
  'EXIT2-DR',
  'SELECT-IR-SCAN',
  'CAPTURE-IR',
  'UPDATE-IR',
  'PAUSE-IR',
  'SHIFT-IR',
  'EXIT1-IR',
  'EXIT2-IR',
] as const;
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

interface Levels {
  readonly tckc: 0 | 1;
  readonly tmsc: 0 | 1;
}

class Capture {
  private steps: CjtagStep[] = [];
  private expected: ExpectedFrame[] = [];
  private levels: Levels = { tckc: 0, tmsc: 0 };
  private state: JtagState = 'RUN-TEST/IDLE';
  private cjtagState: CjtagState = 'FOUR_WIRE';
  private escapeEdges = 0;
  private oacLength = 0;
  private oacPosition = 0;
  private oscanCycle = 0;
  private oscanTdi = 0;
  private oscanTms: 0 | 1 = 0;
  private oldState: JtagState | null = null;
  private bitsTdi: number[] = [];
  private bitsTdo: number[] = [];
  private intervalsTdi: [bigint, bigint][] = [];
  private intervalsTdo: [bigint, bigint][] = [];
  private ssItem: bigint | null = null;
  private ssBitstring: bigint | null = null;
  private first = true;
  private firstBit = true;
  private payload = 0;
  private nextSample: bigint;

  constructor(startSample: bigint) {
    this.nextSample = startSample;
  }

  private sample(): bigint {
    this.nextSample += 1n;
    return this.nextSample;
  }

  private add(tckc: 0 | 1, tmsc: 0 | 1): void {
    const previous = this.levels,
      sample = this.sample();
    this.steps.push({ tckc, tmsc });
    this.levels = { tckc, tmsc };
    if (tckc === 1 && previous.tckc === 0) {
      this.handleTapcState();
      if (this.cjtagState === 'OSCAN1') {
        if (this.oscanCycle === 0) {
          this.oscanTdi = tmsc === 0 ? 1 : 0;
          this.oscanCycle = 1;
        } else if (this.oscanCycle === 1) {
          this.oscanTms = tmsc;
          this.oscanCycle = 2;
        } else {
          this.risingEdge(this.oscanTdi as 0 | 1, tmsc, sample, this.oscanTms);
          this.oscanCycle = 0;
        }
      } else this.risingEdge(undefined, undefined, sample, tmsc);
    } else if (tckc === 1 && previous.tckc === 1 && tmsc !== previous.tmsc) this.escapeEdges++;
  }

  pulse(tmsc: 0 | 1, escapes = 0): void {
    this.add(0, tmsc);
    this.add(1, tmsc);
    let level = tmsc;
    for (let index = 0; index < escapes; index++) {
      level = level === 0 ? 1 : 0;
      this.add(1, level);
    }
  }

  private advance(tms: 0 | 1): void {
    this.oldState = this.state;
    if (this.cjtagState.startsWith('CJTAG_')) {
      this.oacPosition++;
      if (this.oacPosition > 4 && this.oacLength === 12) this.cjtagState = 'CJTAG_EC';
      if (this.oacPosition === 8 && tms === 0) this.oacLength = 36;
      if (this.oacPosition > 8 && this.oacLength === 36) this.cjtagState = 'CJTAG_SPARE';
      if (this.oacPosition > 13 && this.oacLength === 36) this.cjtagState = 'CJTAG_TPDEL';
      if (this.oacPosition > 16 && this.oacLength === 36) this.cjtagState = 'CJTAG_TPREV';
      if (this.oacPosition > 18 && this.oacLength === 36) this.cjtagState = 'CJTAG_TPST';
      if (this.oacPosition > 23 && this.oacLength === 36) this.cjtagState = 'CJTAG_RDYC';
      if (this.oacPosition > 25 && this.oacLength === 36) this.cjtagState = 'CJTAG_DLYC';
      if (this.oacPosition > 27 && this.oacLength === 36) this.cjtagState = 'CJTAG_SCNFMT';
      if (this.oacPosition > 8 && this.oacLength === 12) this.cjtagState = 'CJTAG_CP';
      if (this.oacPosition > 32 && this.oacLength === 36) this.cjtagState = 'CJTAG_CP';
      if (this.oacPosition > this.oacLength) {
        this.cjtagState = 'OSCAN1';
        this.oscanCycle = 1;
        this.state = 'TEST-LOGIC-RESET';
      }
      return;
    }
    this.state = NEXT[this.state][tms];
  }

  private collectBit(tdi: 0 | 1, tdo: 0 | 1, sample: bigint): void {
    if (this.firstBit) {
      this.ssBitstring = sample;
      this.firstBit = false;
    } else {
      if (this.intervalsTdi[0]) this.intervalsTdi[0][1] = sample;
      if (this.intervalsTdo[0]) this.intervalsTdo[0][1] = sample;
    }
    this.bitsTdi.unshift(tdi);
    this.bitsTdo.unshift(tdo);
    this.intervalsTdi.unshift([sample, sample]);
    this.intervalsTdo.unshift([sample, sample]);
  }

  private emitBitstring(
    kind: 'DR' | 'IR',
    direction: 'TDI' | 'TDO',
    sample: bigint,
    bits: number[],
    intervals: [bigint, bigint][],
  ): void {
    const data = bits.slice(1).join(''),
      positions = intervals.slice(1).map(([ss, es]) => [ss, es] as CjtagSampleInterval);
    this.expected.push({
      protoId: 'jtag',
      kind: 'protocol',
      ss: this.ssBitstring ?? sample,
      es: sample,
      data: [`${kind} ${direction}`, [data, positions]],
    });
  }

  private emitBitstrings(sample: bigint): void {
    const kind = this.state === 'UPDATE-DR' ? 'DR' : 'IR';
    this.emitBitstring(kind, 'TDI', sample, this.bitsTdi, this.intervalsTdi);
    this.emitBitstring(kind, 'TDO', sample, this.bitsTdo, this.intervalsTdo);
    this.bitsTdi = [];
    this.bitsTdo = [];
    this.intervalsTdi = [];
    this.intervalsTdo = [];
    this.firstBit = true;
    this.ssBitstring = sample;
  }

  private risingEdge(tdi: 0 | 1 | undefined, tdo: 0 | 1 | undefined, sample: bigint, tms: 0 | 1): void {
    this.advance(tms);
    if (this.first) {
      this.ssItem = sample;
      this.first = false;
    } else {
      this.expected.push({
        protoId: 'jtag',
        kind: 'protocol',
        ss: this.ssItem ?? sample,
        es: sample,
        data: ['NEW STATE', this.state],
      });
    }
    if (
      this.oldState === 'SHIFT-DR' ||
      this.oldState === 'EXIT1-DR' ||
      this.oldState === 'SHIFT-IR' ||
      this.oldState === 'EXIT1-IR'
    )
      this.collectBit(tdi ?? 0, tdo ?? 0, sample);
    if (this.state === 'UPDATE-DR' || this.state === 'UPDATE-IR') this.emitBitstrings(sample);
    this.ssItem = sample;
  }

  private handleTapcState(): void {
    if (this.escapeEdges >= 8) this.cjtagState = 'FOUR_WIRE';
    if (this.escapeEdges === 6) {
      this.cjtagState = 'CJTAG_OAC';
      this.oacPosition = 0;
      this.oacLength = 12;
    }
    this.escapeEdges = 0;
  }

  activate(): void {
    this.pulse(0, 6);
    this.pulse(0);
    for (let guard = 0; this.cjtagState !== 'OSCAN1' && guard < 64; guard++) this.pulse(0);
    if (this.cjtagState !== 'OSCAN1') throw new Error('Failed to enter cJTAG OSCAN1 mode');
  }

  logical(tms: 0 | 1, tdi: 0 | 1, tdo: 0 | 1): void {
    if (this.oscanCycle === 1) {
      this.pulse(tms);
      this.pulse(tdo);
      return;
    }
    this.pulse(tdi === 0 ? 1 : 0);
    this.pulse(tms);
    this.pulse(tdo);
  }

  scan(kind: 'DR' | 'IR', tdi: readonly number[], tdo: readonly number[]): void {
    if (this.state === 'TEST-LOGIC-RESET') this.logical(0, 0, 0);
    this.logical(1, 0, 0);
    this.logical(kind === 'IR' ? 1 : 0, 0, 0);
    if (kind === 'IR') this.logical(0, 0, 0);
    this.logical(0, 0, 0);
    for (let index = 0; index < tdi.length; index++)
      this.logical(index === tdi.length - 1 ? 1 : 0, tdi[index] as 0 | 1, tdo[index] as 0 | 1);
    this.logical(1, 0, 0);
    this.logical(0, 0, 0);
    this.payload += tdi.length;
  }

  take(payloadBits = this.payload): {
    data: CjtagStep[];
    expected: ExpectedFrame[];
    payloadBits: number;
  } {
    const block = { data: this.steps, expected: this.expected, payloadBits };
    this.steps = [];
    this.expected = [];
    this.payload = 0;
    return block;
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
  seed = 0x434a5441,
}: GenerationOptions = {}): Iterable<CjtagCase> {
  yield {
    name: 'boundary-activation',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 5n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const capture = new Capture(5n);
      capture.activate();
      yield capture.take(37);
    },
  };

  yield {
    name: 'boundary-oscans-dr-and-ir',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 17, 257],
    minimumPayloadBits: 0,
    *generate() {
      const capture = new Capture(9_007_199_254_740_990n);
      capture.activate();
      capture.scan('DR', [1], [0]);
      capture.scan('IR', bits(0xa5, 8), bits(0x5a, 8));
      capture.scan('DR', bits(0x1234, 16), bits(0xedcb, 16));
      yield capture.take();
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerScan = 1000;
  const scansPerBlock = 4;
  const payloadPerBlock = bitsPerScan * scansPerBlock;
  const blocks = Math.ceil(required / payloadPerBlock);
  yield {
    name: 'seeded-long-oscans',
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
      capture.activate();
      for (let block = 0; block < blocks; block++) {
        for (let scan = 0; scan < scansPerBlock; scan++) {
          const kind = (block * scansPerBlock + scan) % 2 === 0 ? 'DR' : 'IR';
          capture.scan(kind, randomBits(random, bitsPerScan), randomBits(random, bitsPerScan));
        }
        yield capture.take(payloadPerBlock);
      }
    },
  };
}
