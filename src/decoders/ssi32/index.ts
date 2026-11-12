import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface Ssi32Options {
  msgsize: number;
}

type SpiWord = readonly ['WORD', mosi: number | null, miso: number | null, cs: boolean | null, wordIndex: number];

const ANN = Object.freeze({
  CTRL_TX: 0,
  ACK_TX: 1,
  CTRL_RX: 2,
  ACK_RX: 3,
});

function hex(value: number): string {
  return value.toString(16).toLowerCase().padStart(2, '0');
}

export class Ssi32Decoder extends Decoder<Ssi32Options> {
  static descriptor = descriptor;

  private outAnn = -1;
  private ssCmd = 0n;
  private esCmd = 0n;
  private mosiBytes: number[] = [];
  private misoBytes: number[] = [];
  private esArray: bigint[] = [];
  private lastCs: boolean | null = null;

  constructor(options: Partial<Ssi32Options> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.ssCmd = 0n;
    this.esCmd = 0n;
    this.mosiBytes = [];
    this.misoBytes = [];
    this.esArray = [];
    this.lastCs = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    if (!Number.isInteger(this.options.msgsize) || this.options.msgsize < 4)
      throw new Error('SSI32 message size must be at least four bytes.');
  }

  private resetData(): void {
    this.mosiBytes = [];
    this.misoBytes = [];
    this.esArray = [];
  }

  private putx(data: readonly [number, readonly string[]]): void {
    this.put(this.ssCmd, this.esCmd, this.outAnn, data);
  }

  private handleAck(): void {
    this.esCmd = this.esArray[0]!;
    this.putx([ANN.ACK_TX, [`> ACK:0x${hex(this.mosiBytes[0]!)}`]]);
    this.putx([ANN.ACK_RX, [`< ACK:0x${hex(this.misoBytes[0]!)}`]]);
  }

  private handleCtrl(): void {
    const txSize = this.mosiBytes[2]!;
    const rxSize = this.misoBytes[2]!;
    if (txSize + 4 > this.mosiBytes.length || rxSize + 4 > this.misoBytes.length)
      throw new Error('SSI32 payload exceeds the configured message size.');

    const txData =
      txSize > 0
        ? ', DATA:0x' +
          this.mosiBytes
            .slice(4, txSize + 4)
            .map(hex)
            .join('')
        : '';
    const rxData =
      rxSize > 0
        ? ', DATA:0x' +
          this.misoBytes
            .slice(4, rxSize + 4)
            .map(hex)
            .join('')
        : '';

    this.esCmd = this.esArray[txSize + 3]!;
    this.putx([
      ANN.CTRL_TX,
      [
        `> CTRL:0x${hex(this.mosiBytes[0]!)}, LUN:0x${hex(this.mosiBytes[1]!)}, SIZE:0x${hex(this.mosiBytes[2]!)}, CRC:0x${hex(this.mosiBytes[3]!)}${txData}`,
      ],
    ]);

    this.esCmd = this.esArray[rxSize + 3]!;
    this.putx([
      ANN.CTRL_RX,
      [
        `< CTRL:0x${hex(this.misoBytes[0]!)}, LUN:0x${hex(this.misoBytes[1]!)}, SIZE:0x${hex(this.misoBytes[2]!)}, CRC:0x${hex(this.misoBytes[3]!)}${rxData}`,
      ],
    ]);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || data[0] !== 'WORD') return;
    const word = data as unknown as SpiWord;
    const cs = typeof word[3] === 'boolean' ? word[3] : null;
    if (cs !== null) {
      if (this.lastCs !== null && cs !== this.lastCs) this.resetData();
      this.lastCs = cs;
      if (!cs) {
        this.resetData();
        return;
      }
    }

    if (!this.mosiBytes.length) this.ssCmd = ss;
    this.mosiBytes.push(word[1] ?? 0);
    this.misoBytes.push(word[2] ?? 0);
    this.esArray.push(es);

    if (this.mosiBytes[0]! & 0x80) {
      if (this.mosiBytes.length < 4) return;
      this.handleAck();
      this.resetData();
      return;
    }

    if (this.mosiBytes.length < this.options.msgsize) return;
    this.handleCtrl();
    this.resetData();
  }
}

export default Ssi32Decoder;
