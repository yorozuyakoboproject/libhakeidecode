import { minSample } from '../libhakei/sample-index.js';
import { AnalogSampleStore, type AnalogStore } from './data/analogStore.js';
import { PlanarSampleStore } from './data/planarStore.js';
import { channelStoreRange } from './data/channel-range.js';
import type { GapSpan, ColumnView } from './data/types.js';
import type { AnalogSettings } from './analog-settings.js';

export class AnalogConversion {
  private key = '';
  private source: AnalogStore | null = null;
  private logic: PlanarSampleStore | null = null;
  private state = 0;
  prepare(
    source: AnalogStore,
    settings: AnalogSettings,
    gaps: readonly GapSpan[],
    start: bigint,
    end: bigint,
    bins: number,
  ): ColumnView & { edges?: bigint[] } {
    const average = source.mean ?? 0,
      hysteresis = ((source.range?.max ?? 0) - (source.range?.min ?? 0)) * 0.15;
    let low: number, high: number;
    if (settings.threshold === 'average') {
      low = average - (settings.conversion === 'schmitt' ? hysteresis : 0);
      high = average + (settings.conversion === 'schmitt' ? hysteresis : 0);
    } else {
      const values = settings.threshold.split('/').map(Number);
      low = values[0]!;
      high = values[1] ?? low;
    }
    const key = `${settings.conversion}:${low}:${high}`;
    if (this.key !== key || this.source !== source || !this.logic || this.logic.length > source.length) {
      this.dispose();
      this.key = key;
      this.source = source;
      this.logic = new PlanarSampleStore({ channelCount: 4, samplerate: source.samplerate });
      this.state = source.length && source.sampleAt(0n) >= (low + high) / 2 ? 1 : 0;
    }
    const logic = this.logic!;
    let gapIndex = 0;
    for (let position = logic.length; position < source.length;) {
      const next = minSample(source.length, position + 65536n),
        count = Number(next - position),
        values =
          source instanceof AnalogSampleStore
            ? source.copyRange(position, next)
            : Float32Array.from({ length: count }, (_, i) => source.sampleAt(position + BigInt(i))),
        packed = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const sample = position + BigInt(i);
        while (gapIndex < gaps.length && gaps[gapIndex]!.endSample <= sample) gapIndex++;
        const gap = gaps[gapIndex];
        if (!gap || sample < gap.startSample) {
          const value = values[i]!;
          if (settings.conversion === 'threshold') this.state = value >= high ? 1 : 0;
          else if (value >= high) this.state = 1;
          else if (value <= low) this.state = 0;
        }
        packed[i] = this.state;
      }
      logic.append(packed);
      position = next;
    }
    for (const gap of gaps) if (gap.endSample <= logic.length) logic.noteGap(gap.startSample, gap.endSample);
    const view = logic.query(0, start, end, bins),
      exact = end - start <= BigInt(bins);
    return {
      ...view,
      low: view.low.slice(),
      high: view.high.slice(),
      edge: view.edge.slice(),
      packed: view.packed.slice(),
      ...(exact ? { points: channelStoreRange(logic, 0, start, end), edges: logic.edges(0, start, end) } : {}),
    };
  }
  dispose(): void {
    this.logic?.dispose();
    this.logic = null;
    this.source = null;
  }
}
