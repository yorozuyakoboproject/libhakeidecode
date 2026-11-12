import { Decoder, OUTPUT_ANN, OUTPUT_BINARY, OUTPUT_META, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, WaitPredicate } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface JitterOptions {
  clk_polarity: string;
  sig_polarity: string;
}

export type JitterEdge = (previous: number, current: number) => boolean;

export function edgeDetector(polarity: string): JitterEdge {
  if (polarity === 'rising') return (previous, current) => !previous && !!current;
  if (polarity === 'falling') return (previous, current) => !!previous && !current;
  return (previous, current) => previous !== current;
}

export function formatJitterDelta(delta: number): string {
  if (delta === 0 || delta >= 1) return `${delta.toFixed(1)}s`;
  if (delta <= 1e-12) return `${(delta * 1e15).toFixed(1)}fs`;
  if (delta <= 1e-9) return `${(delta * 1e12).toFixed(1)}ps`;
  if (delta <= 1e-6) return `${(delta * 1e9).toFixed(1)}ns`;
  if (delta <= 1e-3) return `${(delta * 1e6).toFixed(1)}μs`;
  return `${(delta * 1e3).toFixed(1)}ms`;
}

function formatPythonFloat(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const sign = value < 0 ? '-' : '';
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
  const exponent = Number(exponentText);
  const digits = mantissa!.replace('.', '');
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
    const whole = digits.padEnd(exponent + 1, '0');
    return `${sign}${whole.slice(0, exponent + 1)}.${whole.slice(exponent + 1) || '0'}`;
  }
  const normalized = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0];
  return `${sign}${normalized}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

export function jitterEdgePredicate(polarity: string): WaitPredicate {
  if (polarity === 'rising') return 'r';
  if (polarity === 'falling') return 'f';
  return 'e';
}

export class JitterDecoder extends Decoder<JitterOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private outBinary = -1;
  private outClkMissed = -1;
  private outSigMissed = -1;
  private samplerate = 0;
  private state: 'CLK' | 'SIG' = 'CLK';
  private oldclk = 0;
  private oldsig = 0;
  private clkStart: bigint | null = null;
  private sigStart: bigint | null = null;
  private clkMissed = 0;
  private sigMissed = 0;
  private clkEdge: JitterEdge = edgeDetector('rising');
  private sigEdge: JitterEdge = edgeDetector('rising');

  override reset(): void {
    this.samplerate = 0;
    this.state = 'CLK';
    this.oldclk = 0;
    this.oldsig = 0;
    this.clkStart = null;
    this.sigStart = null;
    this.clkMissed = 0;
    this.sigMissed = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.clkEdge = edgeDetector(this.options.clk_polarity);
    this.sigEdge = edgeDetector(this.options.sig_polarity);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
    this.outClkMissed = this.register(OUTPUT_META, undefined, ['int', 'Clock missed', 'Clock transition missed']);
    this.outSigMissed = this.register(OUTPUT_META, undefined, [
      'int',
      'Signal missed',
      'Resulting signal transition missed',
    ]);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private putJitter(delta: number): void {
    this.put(this.clkStart!, this.sigStart!, this.outAnn, [0, [formatJitterDelta(delta)]]);
    this.put(this.clkStart!, this.sigStart!, this.outBinary, [
      0,
      new TextEncoder().encode(`${formatPythonFloat(delta)}\n`),
    ]);
  }

  private putMiss(classIndex: 1 | 2): void {
    const sample = this.samplenum;
    const count = classIndex === 1 ? ++this.clkMissed : ++this.sigMissed;
    this.put(sample, sample, classIndex === 1 ? this.outClkMissed : this.outSigMissed, count);
    this.put(
      sample,
      sample,
      this.outAnn,
      classIndex === 1 ? [1, ['Missed clock', 'MC']] : [2, ['Missed signal', 'MS']],
    );
  }

  private handleClock(clk: number, sig: number): boolean {
    if (this.clkStart === this.samplenum) return true;
    if (this.clkEdge(this.oldclk, clk)) {
      this.clkStart = this.samplenum;
      this.state = 'SIG';
      return false;
    }
    if (this.sigStart !== null && this.sigStart !== this.samplenum && this.sigEdge(this.oldsig, sig)) this.putMiss(2);
    return true;
  }

  private handleSignal(clk: number, sig: number): boolean {
    if (this.sigStart === this.samplenum) return true;
    if (this.sigEdge(this.oldsig, sig)) {
      this.sigStart = this.samplenum;
      this.state = 'CLK';
      this.putJitter(Number(this.sigStart - this.clkStart!) / this.samplerate);
      return false;
    }
    if (this.clkStart !== this.samplenum && this.clkEdge(this.oldclk, clk)) this.putMiss(1);
    return true;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    while (true) {
      const pins = yield this.wait([{ clk: 'e' }, { sig: 'e' }]);
      const clk = pins[0]! & 1;
      const sig = pins[1]! & 1;
      while (true) {
        if (this.state === 'CLK' && this.handleClock(clk, sig)) break;
        if (this.state === 'SIG' && this.handleSignal(clk, sig)) break;
      }
      this.oldclk = clk;
      this.oldsig = sig;
    }
  }
}

export default JitterDecoder;
