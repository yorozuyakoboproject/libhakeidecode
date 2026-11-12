import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { bcd2int } from '../common.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

type Bit = [bigint, bigint, string];

const ANN = Object.freeze({
  BIT: 0,
  REF: 1,
  FIELD: 2,
  REF_FIELD: 3,
  LEVEL2: 4,
  REF_LEVEL2: 5,
});

export class OokVisDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private decoded: Bit[] = [];
  private ookstring = '';
  private ookcache: Bit[][] = [];
  private traceNum = 0;
  private ss = 0n;
  private es = 0n;
  private decodePos = 0;
  private outAnn = -1;
  private outProtocol = -1;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.decoded = [];
    this.ookstring = '';
    this.ookcache = [];
    this.traceNum = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'ook');
  }

  private putx(data: readonly [number, readonly string[]]): void {
    this.put(this.ss, this.es, this.outAnn, data);
  }

  private displayLevel2(bits: number, line: number): void {
    this.decodePos = 0;
    const ook = this.decoded;
    if (ook.length <= 1) return;
    let preambleEnd = ook.length + 1;
    const first = ook[0]![2];
    let last = ook[1]![2];
    const alternating = first !== last;
    for (let index = 0; index < ook.length; index++) {
      if (!alternating) {
        if (ook[index]![2] !== last) {
          preambleEnd = index;
          break;
        }
        last = ook[index]![2];
      } else if (ook[index]![2] !== last) {
        last = ook[index]![2];
      } else {
        preambleEnd = index;
        break;
      }
    }
    if (ook.length < preambleEnd) return;
    preambleEnd += Number.parseInt(String(this.options.syncoffset), 10) - 1;
    this.ss = ook[0]![0];
    this.es = ook[preambleEnd]![1];
    this.putx([line, ['Preamble', 'Pre', 'P']]);
    this.decodePos += preambleEnd;
    const syncLength = Number.parseInt(String(this.options.synclen), 10);
    if (ook.length > this.decodePos + syncLength) {
      this.ss = this.es;
      this.es = ook[this.decodePos + syncLength]![1];
      this.putx([line, ['Sync', 'Syn', 'S']]);
      this.decodePos += syncLength + 1;
    }
    this.ookstring = this.ookstring.slice(this.decodePos);
    const remaining = Math.trunc(this.ookstring.length / bits);
    for (let index = 0; index < remaining; index++) {
      this.ss = ook[this.decodePos]![0];
      this.es = ook[this.decodePos + bits - 1]![1];
      this.putField(bits, line);
    }
  }

  private putField(bits: number, line: number): void {
    let parameter = this.ookstring.slice(this.decodePos, this.decodePos + bits);
    if (String(this.options.displayas).includes('rev')) parameter = parameter.split('').reverse().join('');
    if (!parameter.includes('E')) {
      if (String(this.options.displayas).includes('Hex')) parameter = Number.parseInt(parameter, 2).toString(16);
      else if (String(this.options.displayas).includes('BCD'))
        parameter = String(bcd2int(Number.parseInt(parameter, 2)));
    }
    this.putx([line, [parameter]]);
    this.decodePos += bits;
  }

  private displayRef(trace: number, reference: number): void {
    const target = this.ookcache[trace]!;
    const referenceBits = this.ookcache[reference]!;
    const length = Math.min(target.length, referenceBits.length);
    for (let index = 0; index < length; index++) {
      this.ss = target[index]![0];
      this.es = target[index]![1];
      this.putx([ANN.REF, [referenceBits[index]![2]]]);
    }
  }

  private displayAll(): void {
    this.ookstring = this.decoded.map((bit) => bit[2]).join('');
    this.decodePos = 0;
    const bits = String(this.options.displayas).includes('Nibble') ? 4 : 8;
    const remaining = Math.trunc(this.ookstring.length / bits);
    for (let index = 0; index < remaining; index++) {
      this.ss = this.decoded[this.decodePos]![0];
      this.es = this.decoded[this.decodePos + bits - 1]![1];
      this.putField(bits, ANN.FIELD);
    }
    this.displayLevel2(bits, ANN.LEVEL2);

    const reference = String(this.options.refsample);
    if (reference !== 'off' && reference !== 'show numbers' && this.ookcache.length >= Number(reference)) {
      const index = Number(reference) - 1;
      this.displayRef(this.traceNum, index);
      if (this.ookcache.length === Number(reference))
        for (let trace = 0; trace < index; trace++) this.displayRef(trace, index);
    } else if (reference === 'show numbers') {
      this.ss = this.ookcache[this.traceNum]![0]![0];
      this.es = this.ookcache[this.traceNum]!.at(-1)![1];
      this.putx([ANN.REF, [String(this.traceNum + 1)]]);
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    this.decoded = data.map((item) => {
      const bit = item as readonly [bigint, bigint, string];
      return [bit[0], bit[1], String(bit[2])];
    });
    this.ookcache.push(this.decoded);
    this.displayAll();
    this.ookstring = '';
    this.traceNum++;
    this.ss = ss;
    this.es = es;
    this.put(ss, es, this.outProtocol, data);
  }
}

export default OokVisDecoder;
