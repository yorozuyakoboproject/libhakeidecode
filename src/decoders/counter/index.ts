import { descriptor } from './descriptor.js';
import { Decoder, generatorPlugin, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator, WaitPredicate } from '../../libhakeidecode/index.js';

export interface CounterOptions {
  data_edge: string;
  divider: number;
  reset_edge: string;
  edge_off: number;
  word_off: number;
  dead_cycles: number;
  start_with_reset: string;
}

export const COUNTER_ANN = Object.freeze({
  EDGE: 0,
  WORD: 1,
  RESET: 2,
});

function edgePredicate(value: string): WaitPredicate {
  if (value === 'rising') return 'r';
  if (value === 'falling') return 'f';
  return 'e';
}

export class CounterDecoder extends Decoder<CounterOptions> {
  static descriptor = descriptor;
  private outAnn = -1;

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putCount(classIndex: number, ss: bigint, text: string): void {
    this.put(ss, this.samplenum, this.outAnn, [classIndex, [text]]);
  }

  *decode(): LogicGenerator {
    const conditions: Record<string, WaitPredicate>[] = [{ data: edgePredicate(this.options.data_edge) }];
    const haveReset = this.hasChannel('reset');
    if (haveReset) conditions.push({ reset: edgePredicate(this.options.reset_edge) });

    let divider = Math.trunc(this.options.divider);
    if (divider < 0) divider = 0;
    const edgeOffset = Math.trunc(this.options.edge_off);
    const wordOffset = Math.trunc(this.options.word_off);
    const deadCycles = Math.max(0, Math.trunc(this.options.dead_cycles));
    let edgeCount = edgeOffset;
    let wordCount = wordOffset;
    let edgeStart: bigint | null = null;
    let wordStart: bigint | null = null;
    let deadCount = this.options.start_with_reset === 'yes' ? deadCycles : 0;

    while (true) {
      yield this.wait(conditions);
      const now = this.samplenum;
      const matched = this.matched ?? [];

      if (haveReset && matched[1]) {
        edgeCount = edgeOffset;
        edgeStart = now;
        wordCount = wordOffset;
        wordStart = now;
        this.put(now, now, this.outAnn, [COUNTER_ANN.RESET, ['Word reset', 'Reset', 'Rst', 'R']]);
        deadCount = deadCycles;
        continue;
      }

      if (deadCount) {
        deadCount--;
        edgeStart = now;
        wordStart = now;
        continue;
      }

      if (edgeStart === null) edgeStart = 0n;
      if (wordStart === null) wordStart = 0n;

      edgeCount++;
      this.putCount(COUNTER_ANN.EDGE, edgeStart, String(edgeCount));
      edgeStart = now;

      const wordEdgeCount = edgeCount - edgeOffset;
      if (divider && wordEdgeCount % divider === 0) {
        wordCount++;
        this.putCount(COUNTER_ANN.WORD, wordStart, String(wordCount));
        wordStart = now;
      }
    }
  }
}

export const counterPlugin: DecoderPlugin<any, any> = {
  decoder: CounterDecoder,
  descriptor,
  createEngine: (context) => generatorPlugin(CounterDecoder).createEngine(context),
};

export default CounterDecoder;
