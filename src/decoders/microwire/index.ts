import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export type MicrowireBitInterval = readonly [ss: bigint, es: bigint, si: number, so: number];
export type MicrowireProtocolPacket = readonly MicrowireBitInterval[];

interface Change {
  readonly sample: bigint;
  readonly cs: number;
  readonly sk: number;
  readonly si: number;
  readonly so: number;
  readonly skEdge: boolean;
  readonly soEdge: boolean;
}

export class MicrowireDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;
  private outAnn = -1;
  private outProtocol = -1;

  override reset(): void {}

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'microwire');
  }

  private annotate(classIndex: number, texts: readonly string[], ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private outputStatus(packet: readonly Change[]): void {
    let start = packet[0]!.sample;
    let so = packet[0]!.so;
    for (const change of packet) {
      if (!change.soEdge) continue;
      if (so === 0 && change.so === 1) this.annotate(4, ['Busy', 'B'], start, change.sample);
      start = change.sample;
      so = change.so;
    }
    if (so === 0) this.annotate(4, ['Busy', 'B'], start, packet.at(-1)!.sample);
    else this.annotate(3, ['Ready', 'R'], start, packet.at(-1)!.sample);
  }

  private outputPackets(packet: readonly Change[]): void {
    let bitStart = 0n;
    let bitSi = 0;
    let bitSo = 0;
    let startBit = true;
    const data: MicrowireBitInterval[] = [];
    for (const change of packet) {
      if (change.skEdge) {
        if (change.sk === 1) {
          if (bitStart > 0n) {
            if (startBit) {
              if (bitSi === 0) this.annotate(5, ['Start bit not high', 'Start bit low'], bitStart, change.sample);
              else this.annotate(0, ['Start bit', 'S'], bitStart, change.sample);
              startBit = false;
            } else {
              this.annotate(1, [`SI bit: ${bitSi}`, `SI: ${bitSi}`, String(bitSi)], bitStart, change.sample);
              this.annotate(2, [`SO bit: ${bitSo}`, `SO: ${bitSo}`, String(bitSo)], bitStart, change.sample);
              data.push([bitStart, change.sample, bitSi, bitSo]);
            }
          }
          bitStart = change.sample;
          bitSi = change.si;
        } else {
          bitSo = change.so;
        }
      } else if (change.cs === 0 && change.sk === 0) {
        this.annotate(1, [`SI bit: ${bitSi}`, `SI: ${bitSi}`, String(bitSi)], bitStart, change.sample);
        this.annotate(2, [`SO bit: ${bitSo}`, `SO: ${bitSo}`, String(bitSo)], bitStart, change.sample);
        data.push([bitStart, change.sample, bitSi, bitSo]);
      }
    }
    this.put(packet[0]!.sample, packet.at(-1)!.sample, this.outProtocol, data);
  }

  *decode(): LogicGenerator {
    while (true) {
      let pins = yield this.wait({ cs: 'r' });
      let cs = Number(pins[0]) & 1;
      let sk = Number(pins[1]) & 1;
      let si = Number(pins[2]) & 1;
      let so = Number(pins[3]) & 1;
      if (sk) {
        this.annotate(
          5,
          ['Clock should be low on start', 'Clock high on start', 'Clock high', 'SK high'],
          this.samplenum,
          this.samplenum,
        );
        sk = 0;
      }
      const packet: Change[] = [];
      let skEdge = false;
      let soEdge = false;
      while (cs) {
        packet.push({
          sample: this.samplenum,
          cs,
          sk,
          si,
          so,
          skEdge,
          soEdge,
        });
        const edge = sk === 0 ? 'r' : 'f';
        pins = yield this.wait([{ cs: 'l' }, { sk: edge }, { so: 'e' }]);
        skEdge = Boolean(this.matched?.[1]);
        soEdge = Boolean(this.matched?.[2]);
        cs = Number(pins[0]) & 1;
        sk = Number(pins[1]) & 1;
        si = Number(pins[2]) & 1;
        so = Number(pins[3]) & 1;
      }
      packet.push({
        sample: this.samplenum,
        cs,
        sk,
        si,
        so,
        skEdge,
        soEdge,
      });

      let statusCheck = true;
      for (const change of packet) {
        if (change.skEdge && change.sk === 1) {
          if (change.si) statusCheck = false;
          break;
        }
      }
      if (statusCheck) this.outputStatus(packet);
      else this.outputPackets(packet);
    }
  }
}

export default MicrowireDecoder;
