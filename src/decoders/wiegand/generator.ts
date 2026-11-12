import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface WiegandRun {
  readonly d0: 0 | 1;
  readonly d1: 0 | 1;
  readonly hold: number;
}

export interface WiegandCase extends RoundtripCase<WiegandRun> {
  readonly initialHold: number;
}

class WiegandModel {
  private readonly active: number;
  private readonly inactive: number;
  private readonly samplesPerBit: number;
  private d0Previous: number | null = null;
  private d1Previous: number | null = null;
  private state: 'data' | 'invalid' | 'idle' | null = null;
  private stateStart: bigint | null = null;
  private bitStart: bigint | null = null;
  private bitEnd: bigint | null = null;
  private bit: number | null = null;
  private bits: number[] = [];
  readonly annotations: ExpectedFrame[] = [];

  constructor(
    active: number,
    sampleRate: number,
    bitwidthMs: number,
    readonly startSample: bigint,
  ) {
    this.active = active;
    this.inactive = active ^ 1;
    this.samplesPerBit = Math.max(1, Math.floor(bitwidthMs / (1000 / sampleRate)));
  }

  private updateState(state: 'data' | 'invalid' | 'idle', bit: number | null, now: bigint): void {
    if (this.bit !== null) {
      this.bits.push(this.bit);
      if (this.bitStart !== null)
        this.annotations.push({ ss: this.bitStart, es: now, classIndex: 0, texts: [String(this.bit)] });
    }
    this.bit = bit;
    this.bitStart = now;
    this.bitEnd = bit === null ? null : now + BigInt(this.samplesPerBit);
    if (state === this.state) return;
    if (this.state === 'data') {
      const value = this.bits.join('');
      this.annotations.push({
        ss: this.stateStart ?? now,
        es: now,
        classIndex: 1,
        texts: [`${this.bits.length} bits ${value}`, `${this.bits.length} bits`],
      });
    } else if (this.state === 'invalid') {
      this.annotations.push({ ss: this.stateStart ?? now, es: now, classIndex: 1, texts: ['invalid'] });
    }
    this.stateStart = now;
    this.state = state;
    this.bits = [];
  }

  consume(run: WiegandRun, sample: bigint): bigint {
    for (let index = 0; index < run.hold; index++) {
      const now = sample + BigInt(index);
      if (run.d0 === this.d0Previous && run.d1 === this.d1Previous) {
        if (this.bitEnd !== null && now >= this.bitEnd)
          this.updateState(run.d0 === this.inactive && run.d1 === this.inactive ? 'idle' : 'invalid', null, now);
        continue;
      }
      if (this.state === null || this.state === 'idle' || this.state === 'data') {
        if (run.d0 === this.active && run.d1 === this.inactive) this.updateState('data', 0, now);
        else if (run.d0 === this.inactive && run.d1 === this.active) this.updateState('data', 1, now);
        else if (run.d0 === this.active && run.d1 === this.active) this.updateState('invalid', null, now);
      } else if (this.state === 'invalid' && run.d0 === this.inactive && run.d1 === this.inactive) {
        this.updateState('idle', null, now);
      }
      this.d0Previous = run.d0;
      this.d1Previous = run.d1;
    }
    return sample + BigInt(run.hold);
  }
}

function bitRuns(bits: readonly number[], active: number, gap = 1): WiegandRun[] {
  const inactive = active ^ 1;
  return bits.flatMap((bit): WiegandRun[] => [
    bit === 0
      ? { d0: active as 0 | 1, d1: inactive as 0 | 1, hold: gap }
      : { d0: inactive as 0 | 1, d1: active as 0 | 1, hold: gap },
    { d0: inactive as 0 | 1, d1: inactive as 0 | 1, hold: gap },
  ]);
}

function summary(): ExpectedFrame {
  return { protoId: 'wiegand', kind: 'summary' };
}

function boundary(
  name: string,
  bits: readonly number[],
  activeOption: 'low' | 'high',
  sampleRate: number,
  bitwidthMs: number,
  startSample: bigint,
  extraRuns: readonly WiegandRun[] = [],
): WiegandCase {
  const active = activeOption === 'high' ? 1 : 0;
  return {
    name,
    kind: 'boundary',
    seed: 0x57494547,
    sampleRate,
    startSample,
    channels: { d0: 4, d1: 1 },
    options: { active: activeOption, bitwidth_ms: bitwidthMs },
    chunkSamples: [1, 13, 257, 4093],
    minimumPayloadBits: 0,
    initialHold: 2,
    *generate() {
      const model = new WiegandModel(active, sampleRate, bitwidthMs, startSample);
      let sample = model.consume(
        { d0: (active ^ 1) as 0 | 1, d1: (active ^ 1) as 0 | 1, hold: this.initialHold },
        startSample,
      );
      const data: WiegandRun[] = [];
      const gap = Math.max(1, Math.floor(bitwidthMs / (1000 / sampleRate)));
      for (const run of [...bitRuns(bits, active, gap), ...extraRuns]) {
        data.push(run);
        sample = model.consume(run, sample);
      }
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: model.annotations,
        annotationCount: model.annotations.length,
        payloadBits: Math.max(1, bits.length),
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x57494547,
}: GenerationOptions = {}): Iterable<WiegandCase> {
  yield boundary('active-low-bits', [0, 1, 0, 0, 1], 'low', 2_000_000, 2, 17n);
  yield boundary('active-high-invalid-recovery', [1, 0, 1], 'high', 1_000_000, 4, 9_007_199_254_740_990n, [
    { d0: 1, d1: 1, hold: 1 },
    { d0: 0, d1: 0, hold: 1 },
  ]);
  yield boundary('long-bit-width', [0, 0, 1, 1], 'low', 10_000, 32, 31n);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerBlock = 4096;
  const blocks = Math.ceil(required / bitsPerBlock);
  yield {
    name: 'seeded-long-bits',
    kind: 'long',
    seed,
    sampleRate: 1_000,
    startSample: 0n,
    channels: { d0: 2, d1: 5 },
    options: { active: 'low', bitwidth_ms: 2 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    initialHold: 2,
    *generate() {
      const random = randomWords(seed);
      const model = new WiegandModel(0, this.sampleRate, 2, this.startSample);
      let sample = model.consume({ d0: 1, d1: 1, hold: this.initialHold }, this.startSample);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(bitsPerBlock, required - block * bitsPerBlock);
        const bits = Array.from({ length: count }, () => random() & 1);
        const data = bitRuns(bits, 0, 2);
        const before = model.annotations.length;
        for (const run of data) sample = model.consume(run, sample);
        const added = model.annotations.slice(before);
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: [added[0]!, added[added.length - 1]!],
          annotationCount: added.length,
          payloadBits: count,
        };
      }
    },
  };
}
