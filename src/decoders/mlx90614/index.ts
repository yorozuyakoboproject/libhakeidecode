import { descriptor } from './descriptor.js';
import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';

export type Mlx90614Options = Record<string, OptionValue>;

type State = 'ignore-start-repeat' | 'ignore-address-write' | 'get-temperature';

export class Mlx90614Decoder extends Decoder<Mlx90614Options> {
  static descriptor = descriptor;
  private outAnn = -1;
  private state: State = 'ignore-start-repeat';
  private data: number[] = [];
  private temperatureStart = 0n;
  private temperatureEnd = 0n;

  override reset(): void {
    this.state = 'ignore-start-repeat';
    this.data = [];
    this.temperatureStart = 0n;
    this.temperatureEnd = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || typeof data[0] !== 'string') return;
    if (this.state === 'ignore-start-repeat') {
      if (data[0] === 'START' && data[1] === true) this.state = 'ignore-address-write';
      return;
    }
    if (this.state === 'ignore-address-write') {
      if (data[0] === 'ADDRESS' && data[1] === 'write') this.state = 'get-temperature';
      return;
    }
    if (data[0] !== 'DATA' || data[1] !== 'write' || typeof data[2] !== 'number') return;
    if (this.data.length === 0) {
      this.data.push(data[2]);
      this.temperatureStart = ss;
    } else if (this.data.length === 1) {
      this.data.push(data[2]);
      this.temperatureEnd = es;
    } else {
      const kelvin = (this.data[0]! | (this.data[1]! << 8)) * 0.02;
      this.put(this.temperatureStart, this.temperatureEnd, this.outAnn, [
        0,
        [`Temperature: ${(kelvin - 273.15).toFixed(2)} °C`],
      ]);
      this.put(this.temperatureStart, this.temperatureEnd, this.outAnn, [1, [`Temperature: ${kelvin.toFixed(2)} K`]]);
      this.state = 'ignore-start-repeat';
      this.data = [];
    }
  }
}

export default Mlx90614Decoder;
