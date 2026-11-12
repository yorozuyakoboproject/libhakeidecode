import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface SignatureOptions {
  start_edge: 'rising' | 'falling';
  stop_edge: 'rising' | 'falling';
  clk_edge: 'rising' | 'falling';
  annbits: 'yes' | 'no';
}

const SYMBOLS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'C', 'F', 'H', 'P', 'U'] as const;

export function signatureText(value: number): string {
  return (
    SYMBOLS[value & 0xf]! + SYMBOLS[(value >> 4) & 0xf]! + SYMBOLS[(value >> 8) & 0xf]! + SYMBOLS[(value >> 12) & 0xf]!
  );
}

export function updateSignature(register: number, data: number): number {
  let parity = 0;
  for (let value = register & 0x0291; value; value >>>= 1) parity ^= value & 1;
  return (((parity + (data & 1)) & 1) << 15) | (register >>> 1);
}

export class SignatureDecoder extends Decoder<SignatureOptions> {
  static descriptor = descriptor;

  private outAnn = -1;

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  *decode(): LogicGenerator {
    const startActive = this.options.start_edge === 'rising' ? 1 : 0;
    const stopActive = this.options.stop_edge === 'rising' ? 1 : 0;
    const clockEdge = this.options.clk_edge === 'rising' ? 'r' : 'f';
    const annbits = this.options.annbits === 'yes';
    let gateOpen = false;
    let sampleStart: bigint | null = null;
    let started = false;
    let lastSample = 0n;
    let previousStart = startActive ^ 1;
    let previousStop = stopActive ^ 1;
    let shiftRegister = 0;

    while (true) {
      const pins = yield this.wait({ clk: clockEdge });
      const start = Number(pins[0]);
      const stop = Number(pins[1]);
      const data = Number(pins[3]);

      if (start !== previousStart && !gateOpen) {
        gateOpen = start === startActive;
        if (gateOpen) {
          sampleStart = this.samplenum;
          started = true;
        }
      } else if (stop !== previousStop && gateOpen) {
        gateOpen = !(stop === stopActive);
        if (!gateOpen) {
          if (annbits) this.put(lastSample, this.samplenum, this.outAnn, [3, ['STOP', 'STP', 'P']]);
          this.put(sampleStart ?? this.samplenum, this.samplenum, this.outAnn, [4, [signatureText(shiftRegister)]]);
          shiftRegister = 0;
          sampleStart = null;
        }
      }

      if (gateOpen) {
        if (annbits) {
          if (started) {
            this.put(lastSample, this.samplenum, this.outAnn, [2, [`START<${data}>`, `STR<${data}>`, `S<${data}>`]]);
            started = false;
          } else {
            this.put(lastSample, this.samplenum, this.outAnn, [data, [`${data}`]]);
          }
        }
        shiftRegister = updateSignature(shiftRegister, data);
      }

      previousStart = start;
      previousStop = stop;
      lastSample = this.samplenum;
    }
  }
}

export default SignatureDecoder;
