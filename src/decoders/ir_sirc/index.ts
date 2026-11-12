import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE, WaitToken } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pins, WaitCondition } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';
import { sircRemoteText } from './tables.js';

export interface SircOptions {
  polarity: 'active-low' | 'active-high';
}

export interface SircFrame {
  readonly command: number;
  readonly address: number;
  readonly addressBits?: 5 | 8;
  readonly extended?: number | null;
}

class SircError extends Error {}
class SircErrorSilent extends SircError {}

interface Pulse {
  readonly ss: bigint;
  readonly es: bigint;
}

interface BitRecord {
  readonly bit: number;
  readonly ss: bigint;
  readonly es: bigint;
  readonly good: boolean;
}

interface Signal {
  readonly address: number;
  readonly command: number;
  readonly extended: number | null;
  readonly payloadSs: bigint;
  readonly payloadEs: bigint;
}

export const SIRC_AGC_US = 2400;
export const SIRC_ONE_US = 1200;
export const SIRC_ZERO_US = 600;
export const SIRC_PAUSE_US = 600;

export function sircFrameBits(frame: SircFrame): number[] {
  if (!Number.isInteger(frame.command) || frame.command < 0 || frame.command > 0x7f)
    throw new RangeError('SIRC command must be seven bits.');
  const extended = frame.extended ?? null;
  if (extended !== null && (!Number.isInteger(extended) || extended < 0 || extended > 0xff))
    throw new RangeError('SIRC extended command must be eight bits.');
  const addressBits = extended === null ? (frame.addressBits ?? 5) : 5;
  if (addressBits !== 5 && addressBits !== 8) throw new RangeError('SIRC address width must be five or eight bits.');
  const maximumAddress = 2 ** addressBits - 1;
  if (!Number.isInteger(frame.address) || frame.address < 0 || frame.address > maximumAddress)
    throw new RangeError('SIRC address is out of range.');
  return [
    ...leastBits(frame.command, 7),
    ...leastBits(frame.address, addressBits),
    ...(extended === null ? [] : leastBits(extended, 8)),
  ];
}

function leastBits(value: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => (value >> index) & 1);
}

function packLeastSignificant(bits: readonly BitRecord[]): number {
  let value = 0;
  for (let index = 0; index < bits.length; index++) value |= bits[index]!.bit << index;
  return value;
}

function formatHex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

export class IrSircDecoder extends Decoder<SircOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private snumPerUs = 0;
  private active = false;

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.active = this.options.polarity === 'active-high';
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.snumPerUs = value / 1e6;
  }

  override reset(): void {
    this.snumPerUs = 0;
    this.active = this.options.polarity === 'active-high';
  }

  *decode(): LogicGenerator {
    if (!this.snumPerUs) throw new Error('Cannot decode without samplerate.');

    while (true) {
      const frame = yield* this.waitWrap([{ ir: this.active ? 'h' : 'l' }], null);
      try {
        const signal = yield* this.readSignal();
        this.putg(frame.es, signal.payloadEs, 7, sircRemoteText(signal.address, signal.command, signal.extended));
      } catch (error) {
        if (error instanceof SircErrorSilent) continue;
        if (!(error instanceof SircError)) throw error;
        this.putg(frame.es, this.samplenum, 8, [`Error: ${error.message}`, 'Error', 'E']);
      }
    }
  }

  private *waitWrap(
    conditions: WaitCondition[],
    timeoutUs: number | null,
  ): Generator<WaitToken, { ss: bigint; es: bigint; matched: boolean[] }, Pins> {
    const waiting = [...conditions];
    if (timeoutUs !== null) waiting.push({ skip: Math.trunc(timeoutUs * this.snumPerUs) });
    const ss = this.samplenum;
    yield this.wait(waiting);
    return { ss, es: this.samplenum, matched: this.matched ?? [] };
  }

  private tolerance(ss: bigint, es: bigint, expectedUs: number): boolean {
    const microseconds = Number(es - ss) / this.snumPerUs;
    const tolerance = expectedUs * 0.3;
    return microseconds > expectedUs - tolerance && microseconds < expectedUs + tolerance;
  }

  private *readPulse(high: boolean, expectedUs: number): Generator<WaitToken, Pulse, Pins> {
    const result = yield* this.waitWrap([{ ir: high ? 'f' : 'r' }], Math.trunc(expectedUs * 1.3));
    if (result.matched[1] || !this.tolerance(result.ss, result.es, expectedUs)) {
      throw new SircError('Timeout');
    }
    return { ss: result.ss, es: result.es };
  }

  private *readBit(): Generator<WaitToken, BitRecord, Pins> {
    const high = yield* this.waitWrap([{ ir: this.active ? 'f' : 'r' }], 2000);
    if (high.matched[1]) throw new SircError('Bit High Timeout');
    let bit: number;
    if (this.tolerance(high.ss, high.es, SIRC_ONE_US)) bit = 1;
    else if (this.tolerance(high.ss, high.es, SIRC_ZERO_US)) bit = 0;
    else throw new SircError('Bit Low Timeout');

    let lowEs: bigint;
    let good: boolean;
    try {
      const low = yield* this.readPulse(!this.active, SIRC_PAUSE_US);
      lowEs = low.es;
      good = true;
    } catch (error) {
      if (!(error instanceof SircError)) throw error;
      lowEs = high.es + BigInt(Math.trunc(SIRC_PAUSE_US * this.snumPerUs));
      good = false;
    }
    this.putg(high.ss, lowEs, 0, [String(bit)]);
    return { bit, ss: high.ss, es: lowEs, good };
  }

  private *readSignal(): Generator<WaitToken, Signal, Pins> {
    let agc: Pulse;
    let pause: Pulse;
    try {
      agc = yield* this.readPulse(this.active, SIRC_AGC_US);
      pause = yield* this.readPulse(!this.active, SIRC_PAUSE_US);
    } catch (error) {
      if (error instanceof SircError) throw new SircErrorSilent('not an SIRC message');
      throw error;
    }
    this.putg(agc.ss, agc.es, 1, ['AGC', 'A']);
    this.putg(pause.ss, pause.es, 2, ['Pause', 'P']);
    this.putg(agc.ss, pause.es, 3, ['Start', 'S']);

    const bits: BitRecord[] = [];
    while (true) {
      const record = yield* this.readBit();
      bits.push(record);
      if (bits.length > 20) throw new SircError('too many bits');
      if (record.good) continue;
      if (bits.length !== 12 && bits.length !== 15 && bits.length !== 20) {
        throw new SircError(`incorrect bits count ${bits.length}`);
      }
      break;
    }

    const commandBits = bits.slice(0, 7);
    const addressBits = bits.length === 15 ? bits.slice(7, 15) : bits.slice(7, 12);
    const extendedBits = bits.length === 20 ? bits.slice(12, 20) : [];
    const command = packLeastSignificant(commandBits);
    const address = packLeastSignificant(addressBits);
    const extended = extendedBits.length ? packLeastSignificant(extendedBits) : null;
    this.putg(commandBits[0]!.ss, commandBits.at(-1)!.es, 4, [
      `Command: ${formatHex(command)}`,
      `C:${formatHex(command)}`,
    ]);
    this.putg(addressBits[0]!.ss, addressBits.at(-1)!.es, 5, [
      `Address: ${formatHex(address)}`,
      `A:${formatHex(address)}`,
    ]);
    if (extended !== null) {
      this.putg(extendedBits[0]!.ss, extendedBits.at(-1)!.es, 6, [
        `Extended: ${formatHex(extended)}`,
        `E:${formatHex(extended)}`,
      ]);
    }
    return {
      address,
      command,
      extended,
      payloadSs: bits[0]!.ss,
      payloadEs: bits.at(-1)!.es,
    };
  }

  private putg(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }
}

export default IrSircDecoder;
