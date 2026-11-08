import { minSample, maxSample } from '../libhakei/sample-index.js';
import { channelStoreRange } from './data/channel-range.js';
import type { SampleStore } from './data/types.js';
import type { PreparedChannelView, StoreRequest, StoreResponse } from './worker-store.js';
export type DigitalViewRequest = Extract<StoreRequest, { type: 'prepare-digital' }>;
export type DigitalViewResult = Extract<StoreResponse, { type: 'prepared-digital' }>;
function blankDigital(bins: number) {
  return {
    low: new Uint8Array(bins).fill(1),
    high: new Uint8Array(bins),
    edge: new Uint8Array(bins),
    packed: new Uint8Array(bins).fill(8),
  };
}
export function prepareDigitalView(store: SampleStore, request: DigitalViewRequest): DigitalViewResult {
  const bins = request.bins,
    start = maxSample(0n, request.startSample),
    requestedEnd = request.endSample > start ? request.endSample : start;
  const availableEnd = minSample(store.length, requestedEnd),
    span = requestedEnd - start,
    availableSpan = availableEnd > start ? availableEnd - start : 0n;
  const availableBins =
    availableSpan >= span || span === 0n
      ? bins
      : Math.max(1, Math.floor((Number(availableSpan) / Number(span)) * bins));
  const views: PreparedChannelView[] = [];
  for (const channel of request.channels) {
    if (!Number.isInteger(channel) || channel < 0 || channel >= store.channelCount)
      throw new RangeError('Digital channel out of range');
    let result = blankDigital(bins);
    if (availableSpan > 0n) {
      const view = store.query(channel, start, availableEnd, availableBins);
      result = {
        low: new Uint8Array(bins).fill(1),
        high: new Uint8Array(bins),
        edge: new Uint8Array(bins),
        packed: new Uint8Array(bins).fill(8),
      };
      const count = Math.min(availableBins, view.bins, bins);
      result.low.set(view.low.subarray(0, count));
      result.high.set(view.high.subarray(0, count));
      result.edge.set(view.edge.subarray(0, count));
      result.packed.set(view.packed.subarray(0, count));
    }
    const edges = request.includeEdges ? store.edges(channel, start, availableEnd) : undefined;
    const points =
      request.bins >= Number(availableSpan) ? channelStoreRange(store, channel, start, availableEnd) : undefined;
    views.push({ channel, ...result, ...(edges ? { edges } : {}), ...(points ? { points } : {}) });
  }
  return {
    type: 'prepared-digital',
    id: request.id,
    startSample: start,
    endSample: requestedEnd,
    availableEnd,
    bins,
    views,
  };
}
