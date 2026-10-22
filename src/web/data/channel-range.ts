import { maxSample, localNumber } from '../../libhakei/sample-index.js';
import { splitAroundGaps } from './gaps.js';
import type { SampleStore } from './types.js';

const PACK_RANGE_LIMIT = 2 ** 26;
type RangeStore = SampleStore & {
  sampleAt?: (channel: number, sample: bigint) => number;
  channelRange?: (channel: number, start: bigint, end: bigint) => Uint8Array;
  packRange?: (start: bigint, end: bigint, channels: number) => Uint8Array;
};

export function channelStoreRange(input: RangeStore, channel: number, start: bigint, end: bigint): Uint8Array {
  const store = input;
  if (!Number.isInteger(channel) || channel < 0 || channel >= store.channelCount)
    throw new RangeError('invalid channel');
  if (start < 0n || end < start || end > store.length) throw new RangeError('invalid channel range');
  if (end - start > BigInt(PACK_RANGE_LIMIT)) throw new RangeError('channel range is too large');
  if ('channelRange' in store && typeof store.channelRange === 'function')
    return store.channelRange(channel, start, end);
  if (typeof store.sampleAt !== 'function') throw new Error('Store cannot provide channel ranges');
  const output = new Uint8Array(localNumber(end - start));
  for (const [a, b] of splitAroundGaps(store.gaps(), start, end)) {
    let position = a,
      level = store.sampleAt(channel, maxSample(0n, a));
    for (const edge of store.edges(channel, a + 1n, b)) {
      const next = edge < b ? edge : b;
      if (level) output.fill(1, localNumber(position - start), localNumber(next - start));
      position = next;
      level ^= 1;
      if (position >= b) break;
    }
    if (position < b && level) output.fill(1, localNumber(position - start), localNumber(b - start));
  }
  return output;
}

export function packStoreRange(store: RangeStore, start: bigint, end: bigint, channels: number): Uint8Array {
  if (!Number.isInteger(channels) || channels < 0 || channels > store.channelCount)
    throw new RangeError('invalid channel count');
  if ('packRange' in store && typeof store.packRange === 'function') return store.packRange(start, end, channels);
  const unit = Math.ceil(channels / 8),
    output = new Uint8Array(localNumber(end - start, PACK_RANGE_LIMIT) * unit);
  for (let channel = 0; channel < channels; channel++) {
    const values = channelStoreRange(store, channel, start, end);
    if (!values.length) continue;
    const byte = channel >>> 3,
      mask = 1 << (channel & 7);
    for (let index = 0; index < values.length; index++) if (values[index]) output[index * unit + byte] |= mask;
  }
  return output;
}
