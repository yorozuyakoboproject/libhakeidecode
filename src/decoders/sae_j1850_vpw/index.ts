import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { AnnotationData, DecoderContext, LogicGenerator, WaitConditions } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

type ByteSpan = readonly [value: number, ss: bigint, es: bigint];

interface FrameFields {
  speed?: 1 | 4;
  prio?: number;
  dest?: number;
  src?: number;
  mode?: number;
  data?: ByteSpan[];
  csum?: number | null;
}

export class SaeJ1850VpwDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private active = 0;
  private bits: ByteSpan[] = [];
  private fields: FrameFields = {};
  private outAnn = -1;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.bits = [];
    this.fields = {};
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private putG(ss: bigint, es: bigint, cls: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [cls, texts] satisfies AnnotationData);
  }

  private invalidateFrameDetails(): void {
    this.bits = [];
    this.fields = {};
  }

  private handleDatabytes(ss: bigint, es: bigint, data: readonly ByteSpan[]): void {
    const mode = this.fields.mode;
    if (mode === undefined) return;
    if (mode !== 1) return;
    const pid = data[0]?.[0] ?? this.fields.csum;
    if (pid === undefined || pid === null) this.putG(ss, es, 11, ['PID missing']);
    else this.putG(ss, es, 10, [pid.toString(16).padStart(2, '0')]);
  }

  private handleByte(ss: bigint, es: bigint, value: number): void {
    const text = value.toString(16).padStart(2, '0');
    this.putG(ss, es, 3, [text]);
    if (this.fields.prio === undefined) {
      this.fields.prio = value;
      this.putG(ss, es, 4, [text]);
      return;
    }
    if (this.fields.dest === undefined) {
      this.fields.dest = value;
      this.putG(ss, es, 5, [text]);
      return;
    }
    if (this.fields.src === undefined) {
      this.fields.src = value;
      this.putG(ss, es, 6, [text]);
      return;
    }
    if (this.fields.mode === undefined) {
      this.fields.mode = value;
      this.putG(ss, es, 7, [text]);
      return;
    }
    if (this.fields.data === undefined) {
      this.fields.data = [];
      this.fields.csum = null;
    }
    this.fields.data.push([value, ss, es]);
  }

  private handleSof(ss: bigint, es: bigint, speed: 1 | 4): void {
    this.putG(ss, es, 0, [`${speed}x SOF`, `S${speed}`, 'S']);
    this.invalidateFrameDetails();
    this.fields.speed = speed;
  }

  private handleBit(ss: bigint, es: bigint, value: number): void {
    this.bits.push([value, ss, es]);
    this.putG(ss, es, 1, [String(value)]);
    if (this.bits.length < 8) return;
    const first = this.bits[0]!;
    const last = this.bits[7]!;
    const byte = this.bits.reduce((value, bit) => (value << 1) | bit[0], 0);
    this.bits = [];
    this.handleByte(first[1], last[2], byte);
  }

  private handleEof(ss: bigint, es: bigint): void {
    const data = this.fields.data ?? [];
    if (!data.length) this.putG(ss, es, 11, ['Short data phase', 'Data']);
    let checksum: number | null = null;
    let checksumSs = ss;
    let checksumEs = es;
    if (data.length) {
      const last = data.pop()!;
      checksum = last[0];
      checksumSs = last[1];
      checksumEs = last[2];
      this.fields.csum = checksum;
    }
    if (data.length) {
      const text = data.map((byte) => byte[0].toString(16).padStart(2, '0')).join(' ');
      this.putG(data[0]![1], data[data.length - 1]![2], 8, [text]);
    }
    if (checksum !== null) this.putG(checksumSs, checksumEs, 9, [checksum.toString(16).padStart(2, '0')]);
    this.putG(ss, es, 2, ['EOF', 'E']);
    this.handleDatabytes(ss, es, data);
    this.invalidateFrameDetails();
  }

  private handleUnknown(ss: bigint, es: bigint): void {
    this.putG(ss, es, 11, ['Unknown condition', 'Unknown', 'UNK']);
    this.invalidateFrameDetails();
  }

  private usecsToSamples(us: number): number {
    return Math.trunc(us * 1e-6 * this.samplerate!);
  }

  private samplesToUsecs(samples: number): number {
    return Math.trunc((samples / this.samplerate!) * 1e6);
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    const edgeOnly: WaitConditions = [{ 0: 'e' }];
    let conditions = edgeOnly;
    yield this.wait(edgeOnly);
    let previous = this.samplenum;
    let speed: 1 | 4 | null = null;
    let shortLower = 0;
    let shortUpper = 0;
    let longLower = 0;
    let longUpper = 0;

    while (true) {
      const ss = previous;
      const pins = yield this.wait(conditions);
      const es = this.samplenum;
      previous = es;
      const time = this.samplesToUsecs(Number(es - ss));

      if (speed === null) {
        if (!this.matched?.[0]) continue;
        if (pins[0] !== this.active) continue;
        if (time >= 164 && time < 245) speed = 1;
        else if (time >= 41 && time < 61) speed = 4;
        else continue;

        shortLower = Math.floor(24 / speed);
        shortUpper = Math.floor(97 / speed);
        longLower = Math.floor(97 / speed);
        longUpper = Math.floor(170 / speed);
        const idleSamples = this.usecsToSamples(Math.floor(240 / speed));
        conditions = [{ 0: 'e' }, { skip: idleSamples }];
        this.handleSof(ss, es, speed);
        continue;
      }

      if (Array.isArray(conditions) && conditions.length > 1 && this.matched?.[1]) {
        this.handleEof(ss, es);
        speed = null;
        conditions = edgeOnly;
        continue;
      }
      if (time >= shortLower && time < shortUpper) {
        this.handleBit(ss, es, pins[0] === this.active ? 1 : 0);
        continue;
      }
      if (time >= longLower && time < longUpper) {
        this.handleBit(ss, es, pins[0] === this.active ? 0 : 1);
        continue;
      }
      if (time <= 2) continue;
      this.handleUnknown(ss, es);
      speed = null;
      conditions = edgeOnly;
    }
  }
}

export default SaeJ1850VpwDecoder;
