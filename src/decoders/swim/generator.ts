import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface SwimStep {
  readonly level: 0 | 1;
  readonly samples: number;
}

export interface SwimCase extends RoundtripCase<SwimStep> {}

const CHANNELS = { swim: 0 } as const;
const SAMPLE_RATE = 2_000_000;
const ZERO_LOW = 4;
const ZERO_HIGH = 2;
const ONE_LOW = 2;
const ONE_HIGH = 4;
const SUMMARY: ExpectedFrame = { protoId: 'swim', kind: 'summary' };

class Session {
  private steps: SwimStep[] = [];
  private annotations: ExpectedFrame[] = [];
  private level: 0 | 1 = 1;
  private protoState: 'CMD' | 'N' | '@E' | '@H' | '@L' | 'D' = 'CMD';
  private byteCount = 0;
  private payload = 0;

  constructor(private readonly debug: boolean) {
    this.add(1, 1);
  }

  private add(level: 0 | 1, samples: number): void {
    if (level === this.level) {
      const last = this.steps.at(-1);
      if (last) this.steps[this.steps.length - 1] = { level, samples: last.samples + samples };
      else this.steps.push({ level, samples });
    } else this.steps.push({ level, samples });
    this.level = level;
  }

  private annotate(classIndex: number, texts: readonly string[]): void {
    this.annotations.push({ classIndex, texts });
  }

  private bit(value: 0 | 1): void {
    if (value === 0) {
      this.add(0, ZERO_LOW);
      this.add(1, ZERO_HIGH);
    } else {
      this.add(0, ONE_LOW);
      this.add(1, ONE_HIGH);
    }
  }

  private parity(values: readonly number[]): number {
    return values.reduce((odd, bit) => odd ^ bit, 0);
  }

  private frame(start: 0 | 1, data: readonly number[], ack = 1): void {
    const bits = [start, ...data, this.parity([start, ...data]), ack];
    for (const bit of bits) this.bit(bit as 0 | 1);
  }

  command(value: number): void {
    const data = [(value >>> 2) & 1, (value >>> 1) & 1, value & 1];
    this.frame(0, data);
    if (value === 0) this.annotate(10, ['system reset', 'SRST', '!']);
    else if (value === 1) {
      this.protoState = 'N';
      this.annotate(10, ['read on-the-fly', 'ROTF', 'r']);
    } else if (value === 2) {
      this.protoState = 'N';
      this.annotate(10, ['write on-the-fly', 'WOTF', 'w']);
    } else this.annotate(9, ['unknown', 'UNK']);
    this.payload += 3;
  }

  byte(value: number, start: 0 | 1, ack = 1): void {
    const data = Array.from({ length: 8 }, (_, index) => (value >>> (7 - index)) & 1);
    this.frame(start, data, ack);
    const hex = value.toString(16).padStart(2, '0');
    this.annotate(7 + start, [`0x${hex}`, hex, value.toString(16)]);
    if (!ack) return;
    if (this.protoState === 'N') {
      this.byteCount = value;
      this.protoState = '@E';
      this.annotate(11, [`byte count 0x${hex}`, `bytes 0x${hex}`, `0x${hex}`, hex, value.toString(16)]);
    } else if (this.protoState === '@E') this.protoState = '@H';
    else if (this.protoState === '@H') this.protoState = '@L';
    else if (this.protoState === '@L') this.protoState = 'D';
    else {
      if (this.byteCount > 0) {
        this.byteCount--;
        if (this.byteCount === 0) this.protoState = 'CMD';
      }
      this.annotate(13 + start, [`0x${hex}`, hex, value.toString(16)]);
      if (this.debug) this.annotate(15, [`${this.byteCount} more`, String(this.byteCount)]);
    }
  }

  syncFrame(): void {
    this.add(0, 64);
    this.add(1, 12);
    this.annotate(1, ['synchronization frame', 'synchronization', 'sync', 's']);
    this.protoState = 'CMD';
  }

  enterSequence(): void {
    for (let index = 0; index < 4; index++) {
      this.add(0, 5);
      this.add(1, 40);
    }
    for (let index = 0; index < 5; index++) {
      this.add(0, 5);
      this.add(1, 17);
    }
    this.annotate(1, ['enter sequence', 'enter seq', 'enter', 'ent', 'e']);
  }

  transaction(kind: 'read' | 'write', address: number, data: readonly number[]): void {
    this.command(kind === 'read' ? 1 : 2);
    this.byte(data.length, 0);
    this.byte((address >>> 16) & 0xff, 0);
    this.byte((address >>> 8) & 0xff, 0);
    this.byte(address & 0xff, 0);
    for (const value of data) {
      this.byte(value, kind === 'read' ? 1 : 0);
      this.payload += 8;
    }
  }

  take(summary = false): {
    data: SwimStep[];
    expected: ExpectedFrame[];
    expectedAnnotations: ExpectedFrame[];
    payloadBits: number;
  } {
    const block = {
      data: this.steps,
      expected: summary ? [SUMMARY] : [],
      expectedAnnotations: this.annotations,
      payloadBits: this.payload,
    };
    this.steps = [];
    this.annotations = [];
    this.payload = 0;
    return block;
  }
}

function randomBytes(random: () => number, count: number): number[] {
  return Array.from({ length: count }, () => random() & 0xff);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x5357494d,
}: GenerationOptions = {}): Iterable<SwimCase> {
  yield {
    name: 'boundary-write-and-read',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 7n,
    channels: CHANNELS,
    options: { debug: 'yes' },
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const session = new Session(true);
      session.command(0);
      session.transaction('write', 0x005000, [0x00, 0x12, 0x34, 0xff]);
      session.transaction('read', 0x005004, [0xaa, 0x55, 0x80, 0x01]);
      yield session.take(true);
    },
  };

  yield {
    name: 'boundary-sync-enter-and-nack',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: { debug: 'no' },
    chunkSamples: [1, 17, 257],
    minimumPayloadBits: 0,
    *generate() {
      const session = new Session(false);
      session.syncFrame();
      session.enterSequence();
      session.syncFrame();
      session.command(7);
      session.command(2);
      session.byte(1, 0, 0);
      yield session.take(true);
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bytesPerTransaction = 200;
  const transactionsPerBlock = 8;
  const payloadPerBlock = bytesPerTransaction * transactionsPerBlock * 8;
  const blocks = Math.ceil(required / payloadPerBlock);
  yield {
    name: 'seeded-long-write-stream',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: { debug: 'no' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      const session = new Session(false);
      session.syncFrame();
      for (let block = 0; block < blocks; block++) {
        for (let transaction = 0; transaction < transactionsPerBlock; transaction++) {
          const address = (block * transactionsPerBlock + transaction) & 0xffffff;
          session.transaction('write', address, randomBytes(random, bytesPerTransaction));
        }
        yield session.take(block === 0);
      }
    },
  };
}
