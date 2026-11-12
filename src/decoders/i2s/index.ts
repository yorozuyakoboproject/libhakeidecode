import { Decoder } from '../../libhakeidecode/index.js';
import { OUTPUT_ANN, OUTPUT_BINARY, OUTPUT_PROTOCOL, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

const WAV_CHANNELS = 2;

interface PendingSample {
  readonly value: number;
  readonly bits: number;
  readonly ss: bigint;
}

function writeU16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = Math.floor(value / 0x100) & 0xff;
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = Math.floor(value / 0x100) & 0xff;
  bytes[offset + 2] = Math.floor(value / 0x10000) & 0xff;
  bytes[offset + 3] = Math.floor(value / 0x1000000) & 0xff;
}

function wavHeader(sampleRate: number, bitsPerSample: number): Uint8Array {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = WAV_CHANNELS * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x80, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x61,
    0x74, 0x61, 0xff, 0xff, 0xff, 0xff,
  ]);
  writeU32LE(header, 24, sampleRate);
  writeU32LE(header, 28, Math.min(0xffffffff, byteRate));
  writeU16LE(header, 32, blockAlign);
  writeU16LE(header, 34, bitsPerSample);
  return header;
}

function sampleBytes(value: number, sourceBits: number, targetBits: number): Uint8Array {
  const bytes = new Uint8Array(targetBits / 8);
  const bits = Math.min(32, Math.max(1, sourceBits));
  let normalized = value;
  if (targetBits > bits) normalized *= 2 ** (targetBits - bits);
  else if (targetBits < bits) normalized = Math.floor(normalized / 2 ** (bits - targetBits));
  normalized = ((normalized % 2 ** targetBits) + 2 ** targetBits) % 2 ** targetBits;
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Math.floor(normalized / 2 ** (index * 8)) & 0xff;
  }
  return bytes;
}

export class I2sDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outProtocol = -1;
  private outBinary = -1;
  private samplerate: number | null = null;
  private oldws: number | null = null;
  private bitcount = 0;
  private data = 0;
  private blockStart: bigint | null = null;
  private wordlength = -1;
  private wavBits = 0;
  private pendingLeft: PendingSample | null = null;
  private wroteWavHeader = false;

  override reset(): void {
    this.samplerate = null;
    this.oldws = null;
    this.bitcount = 0;
    this.data = 0;
    this.blockStart = null;
    this.wordlength = -1;
    this.wavBits = 0;
    this.pendingLeft = null;
    this.wroteWavHeader = false;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'i2s');
    this.outBinary = this.register(OUTPUT_BINARY);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private writeWavPair(left: PendingSample, value: number, bits: number, ss: bigint, es: bigint): void {
    if (!this.wroteWavHeader) {
      if (!this.samplerate || this.samplerate <= 0) return;
      const frameSamples = Number(es - left.ss);
      if (!Number.isFinite(frameSamples) || frameSamples <= 0) return;
      const sampleRate = Math.max(1, Math.min(0xffffffff, Math.round(this.samplerate / frameSamples)));
      this.wavBits = Math.min(32, Math.max(8, Math.ceil(Math.max(left.bits, bits) / 8) * 8));
      this.put(0n, 0n, this.outBinary, [0, wavHeader(sampleRate, this.wavBits)]);
      this.wroteWavHeader = true;
    }
    this.put(ss, es, this.outBinary, [0, sampleBytes(left.value, left.bits, this.wavBits)]);
    this.put(ss, es, this.outBinary, [0, sampleBytes(value, bits, this.wavBits)]);
  }

  private putWord(left: boolean, ss: bigint, es: bigint): void {
    const value = this.data;
    const bits = this.bitcount;
    const channel = left ? 'L' : 'R';
    const hex = value.toString(16).padStart(8, '0');
    const texts = left
      ? [`Left channel: ${hex}`, `Left: ${hex}`, `L: ${hex}`, 'L']
      : [`Right channel: ${hex}`, `Right: ${hex}`, `R: ${hex}`, 'R'];
    this.put(ss, es, this.outProtocol, ['DATA', [channel, value]]);
    this.put(ss, es, this.outAnn, [left ? 0 : 1, texts]);
    if (this.wordlength !== -1 && this.wordlength !== bits) {
      this.put(ss, es, this.outAnn, [2, [`Received ${bits}-bit word, expected ${this.wordlength}-bit word`]]);
    }
    this.wordlength = bits;

    if (left) {
      this.pendingLeft = { value, bits, ss };
    } else if (this.pendingLeft) {
      this.writeWavPair(this.pendingLeft, value, bits, ss, es);
      this.pendingLeft = null;
    }
  }

  *decode(): LogicGenerator {
    while (true) {
      const pins = yield this.wait({ sck: 'r' });
      const ws = Number(pins[1]);
      this.data = this.data * 2 + Number(pins[2]);
      this.bitcount++;
      if (this.oldws === null) this.oldws = ws;
      if (ws === this.oldws) continue;

      if (this.blockStart !== null) {
        yield this.wait({ sck: 'f' });
        this.putWord(this.oldws === 0, this.blockStart, this.samplenum);
      } else {
        yield this.wait({ sck: 'f' });
      }

      this.data = 0;
      this.bitcount = 0;
      this.blockStart = this.samplenum;
      this.oldws = ws;
    }
  }
}

export default I2sDecoder;
