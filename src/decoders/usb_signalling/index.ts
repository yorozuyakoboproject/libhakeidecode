import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pins } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export type UsbSignallingOption = 'automatic' | 'full-speed' | 'low-speed';
export type UsbSpeed = Exclude<UsbSignallingOption, 'automatic'>;
export type UsbSignallingSymbol = 'J' | 'K' | 'SE0' | 'SE1';
export type UsbSignallingPacket =
  | readonly ['SOP', null]
  | readonly ['SYM', UsbSignallingSymbol]
  | readonly ['BIT', '0' | '1']
  | readonly ['STUFF BIT', null]
  | readonly ['EOP', null]
  | readonly ['ERR', null]
  | readonly ['KEEP ALIVE', null]
  | readonly ['RESET', null];

type Signalling = UsbSpeed | 'automatic' | 'low-speed-rp';
type State = 'IDLE' | 'GET_BIT' | 'GET_EOP' | 'WAIT_IDLE';

const BITRATES: Record<Exclude<Signalling, 'automatic'>, number> = {
  'full-speed': 12_000_000,
  'low-speed': 1_500_000,
  'low-speed-rp': 1_500_000,
};

const SYMBOLS: Record<Exclude<Signalling, 'automatic'>, Readonly<Record<string, UsbSignallingSymbol>>> = {
  'low-speed': { '00': 'SE0', '10': 'K', '01': 'J', '11': 'SE1' },
  'full-speed': { '00': 'SE0', '10': 'J', '01': 'K', '11': 'SE1' },
  'low-speed-rp': { '00': 'SE0', '10': 'J', '01': 'K', '11': 'SE1' },
};

const AUTOMATIC_SYMBOLS: Readonly<Record<string, 'SE0' | 'FS_J' | 'LS_J' | 'SE1'>> = {
  '00': 'SE0',
  '10': 'FS_J',
  '01': 'LS_J',
  '11': 'SE1',
};

const SYMBOL_ANNOTATIONS: Record<UsbSignallingSymbol, readonly [number, readonly string[]]> = {
  J: [0, ['J']],
  K: [1, ['K']],
  SE0: [2, ['SE0', '0']],
  SE1: [3, ['SE1', '1']],
};

export interface UsbSignallingOptions {
  signalling: UsbSignallingOption;
}

export class UsbSignallingDecoder extends Decoder<UsbSignallingOptions> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private signalling: Signalling = 'automatic';
  private oldsym: UsbSignallingSymbol = 'J';
  private ssBlock: bigint | null = null;
  private bitwidth: number | null = null;
  private sampleBase = 0n;
  private samplepos = 0;
  private samplenumTarget: bigint | null = null;
  private samplenumEdge: bigint | null = null;
  private samplenumLastedge = 0n;
  private edgepins: Pins | null = null;
  private consecutiveOnes = 0;
  private bits = '';
  private state: State = 'IDLE';
  private outProtocol = -1;
  private outAnn = -1;

  constructor(options: Partial<UsbSignallingOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.signalling = 'automatic';
    this.oldsym = 'J';
    this.ssBlock = null;
    this.bitwidth = null;
    this.sampleBase = 0n;
    this.samplepos = 0;
    this.samplenumTarget = null;
    this.samplenumEdge = null;
    this.samplenumLastedge = 0n;
    this.edgepins = null;
    this.consecutiveOnes = 0;
    this.bits = '';
    this.state = 'IDLE';
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.signalling = this.options.signalling;
    if (this.signalling !== 'automatic') this.updateBitrate();
  }

  private updateBitrate(): void {
    if (this.signalling === 'automatic' || !this.samplerate) throw new Error('Cannot determine USB signalling rate.');
    this.bitwidth = this.samplerate / BITRATES[this.signalling];
  }

  private sampleAt(offset: number): bigint {
    return this.sampleBase + BigInt(Math.trunc(offset));
  }

  private putpx(data: UsbSignallingPacket): void {
    const sample = this.samplenumEdge ?? this.samplenum;
    this.put(sample, sample, this.outProtocol, data);
  }

  private putx(classIndex: number, texts: readonly string[]): void {
    const sample = this.samplenumEdge ?? this.samplenum;
    this.put(sample, sample, this.outAnn, [classIndex, texts]);
  }

  private putpb(data: UsbSignallingPacket): void {
    this.put(this.samplenumLastedge, this.samplenumEdge ?? this.samplenum, this.outProtocol, data);
  }

  private putb(classIndex: number, texts: readonly string[]): void {
    this.put(this.samplenumLastedge, this.samplenumEdge ?? this.samplenum, this.outAnn, [classIndex, texts]);
  }

  private putpm(data: UsbSignallingPacket): void {
    this.put(this.ssBlock ?? this.samplenum, this.samplenumEdge ?? this.samplenum, this.outProtocol, data);
  }

  private putm(classIndex: number, texts: readonly string[]): void {
    this.put(this.ssBlock ?? this.samplenum, this.samplenumEdge ?? this.samplenum, this.outAnn, [classIndex, texts]);
  }

  private setNewTarget(): void {
    this.samplepos += this.bitwidth!;
    this.samplenumTarget = this.sampleAt(this.samplepos);
    this.samplenumLastedge = this.samplenumEdge ?? this.samplenum;
    this.samplenumEdge = this.sampleAt(this.samplepos - this.bitwidth! / 2);
  }

  private symbol(pins: Pins): UsbSignallingSymbol | null {
    if (this.signalling === 'automatic') return null;
    return SYMBOLS[this.signalling]?.[`${pins[0]}${pins[1]}`] ?? null;
  }

  private automaticSymbol(pins: Pins): 'SE0' | 'FS_J' | 'LS_J' | 'SE1' | null {
    return AUTOMATIC_SYMBOLS[`${pins[0]}${pins[1]}`] ?? null;
  }

  private waitForSop(sym: UsbSignallingSymbol): void {
    if (sym !== 'K' || this.oldsym !== 'J') return;
    this.consecutiveOnes = 0;
    this.bits = '';
    this.updateBitrate();
    this.sampleBase = this.samplenum;
    this.samplepos = -(this.bitwidth! / 2) + 0.5;
    this.setNewTarget();
    this.putpx(['SOP', null]);
    this.putx(4, ['SOP', 'S']);
    this.state = 'GET_BIT';
  }

  private handleBit(bit: '0' | '1'): void {
    if (this.consecutiveOnes === 6) {
      if (bit === '0') {
        this.putpb(['STUFF BIT', null]);
        this.putb(7, ['Stuff bit: 0', 'SB: 0', '0']);
        this.consecutiveOnes = 0;
      } else {
        this.putpb(['ERR', null]);
        this.putb(8, ['Bit stuff error', 'BS ERR', 'B']);
        this.state = 'IDLE';
      }
      return;
    }
    this.putpb(['BIT', bit]);
    this.putb(6, [bit]);
    if (bit === '1') this.consecutiveOnes++;
    else this.consecutiveOnes = 0;
  }

  private getEop(sym: UsbSignallingSymbol): void {
    this.setNewTarget();
    this.putpb(['SYM', sym]);
    const annotation = SYMBOL_ANNOTATIONS[sym];
    this.putb(annotation[0], annotation[1]);
    this.oldsym = sym;
    if (sym === 'SE0') return;
    if (sym === 'J') {
      this.putpm(['EOP', null]);
      this.putm(5, ['EOP', 'E']);
      this.state = 'WAIT_IDLE';
      return;
    }
    this.putpm(['ERR', null]);
    this.putm(8, ['EOP Error', 'EErr', 'E']);
    this.state = 'IDLE';
  }

  private getBit(sym: UsbSignallingSymbol): void {
    this.setNewTarget();
    const bit: '0' | '1' = this.oldsym === sym ? '1' : '0';
    this.oldsym = sym;
    if (sym === 'SE0') {
      this.state = 'GET_EOP';
      this.ssBlock = this.samplenumLastedge;
    } else {
      this.handleBit(bit);
    }
    this.putpb(['SYM', sym]);
    const annotation = SYMBOL_ANNOTATIONS[sym];
    this.putb(annotation[0], annotation[1]);
    if (this.bits.length <= 16) this.bits += bit;
    if (this.bits.length === 16 && this.bits === '0000000100111100') {
      this.putpx(['EOP', null]);
      this.state = 'IDLE';
      this.signalling = 'low-speed-rp';
      this.updateBitrate();
      this.oldsym = 'J';
    }
    if (bit !== '0' || !this.edgepins) return;
    const edgeSymbol = this.symbol(this.edgepins);
    if (edgeSymbol === 'SE0' || edgeSymbol === 'SE1') return;
    if (edgeSymbol === sym) {
      this.bitwidth = this.bitwidth! - 0.001 * this.bitwidth!;
      this.samplepos -= 0.01 * this.bitwidth!;
    } else {
      this.bitwidth = this.bitwidth! + 0.001 * this.bitwidth!;
      this.samplepos += 0.01 * this.bitwidth!;
    }
  }

  private handleIdle(sym: 'SE0' | 'FS_J' | 'LS_J' | 'SE1' | UsbSignallingSymbol): void {
    this.samplenumEdge = this.samplenum;
    const se0Length = Number(this.samplenum - this.samplenumLastedge) / this.samplerate!;
    if (se0Length > 2.5e-6) {
      this.putpb(['RESET', null]);
      this.putb(10, ['Reset', 'Res', 'R']);
      this.signalling = this.options.signalling;
    } else if (se0Length > 1.2e-6 && this.signalling === 'low-speed') {
      this.putpb(['KEEP ALIVE', null]);
      this.putb(9, ['Keep-alive', 'KA', 'A']);
    }
    if (sym === 'FS_J') {
      this.signalling = 'full-speed';
      this.updateBitrate();
    } else if (sym === 'LS_J') {
      this.signalling = 'low-speed';
      this.updateBitrate();
    }
    this.oldsym = 'J';
    this.state = 'IDLE';
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');

    let pins = yield this.wait();
    if (this.options.signalling === 'automatic') {
      const detected = this.automaticSymbol(pins);
      if (detected) this.handleIdle(detected);
    } else {
      this.signalling = this.options.signalling;
      this.updateBitrate();
      const sym = this.symbol(pins);
      if (sym) this.handleIdle(sym);
    }

    for (;;) {
      if (this.state === 'IDLE') {
        pins = yield this.wait([{ 0: 'e' }, { 1: 'e' }]);
        const sym = this.symbol(pins);
        if (!sym) continue;
        if (sym === 'SE0') {
          this.samplenumLastedge = this.samplenum;
          this.state = 'WAIT_IDLE';
        } else {
          this.waitForSop(sym);
        }
        this.edgepins = [...pins];
        continue;
      }

      if (this.state === 'GET_BIT' || this.state === 'GET_EOP') {
        const edgeSkip = (this.samplenumEdge ?? this.samplenum) - this.samplenum;
        this.edgepins = [...(yield this.wait([{ skip: edgeSkip < 0n ? 0n : edgeSkip }]))];
        const targetSkip = (this.samplenumTarget ?? this.samplenum) - this.samplenum;
        pins = yield this.wait([{ skip: targetSkip < 0n ? 0n : targetSkip }]);
        const sym = this.symbol(pins);
        if (!sym) continue;
        if (this.state === 'GET_BIT') this.getBit(sym);
        else this.getEop(sym);
        continue;
      }

      pins = yield this.wait();
      while (!pins[0] && !pins[1]) pins = yield this.wait([{ 0: 'h' }, { 1: 'h' }]);
      if (this.samplenum - this.samplenumLastedge > 1n) {
        const detected = this.automaticSymbol(pins);
        if (detected) this.handleIdle(detected);
      } else {
        const sym = this.symbol(pins);
        if (sym) this.waitForSop(sym);
      }
      this.edgepins = [...pins];
    }
  }
}

export default UsbSignallingDecoder;
