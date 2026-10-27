import { sampleIndex } from '../libhakei/sample-index.js';
import type { ChannelCount } from './data/channel-count.js';
import type { AcquisitionResult } from './capture.js';
import { UIError } from './i18n.js';

export function validRate(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new UIError('error.rate');
  return n;
}
export function validWidth(n: number): ChannelCount {
  if (![4, 8, 16, 32].includes(n)) throw new UIError('error.width');
  return n as ChannelCount;
}
export function parseAcquisitionResult(value: unknown, length: bigint): AcquisitionResult | undefined {
  if (value === undefined) return undefined;
  const source = value as AcquisitionResult;
  const result = source && {
    ...source,
    targetSamples: sampleIndex(source.targetSamples),
    actualSamples: sampleIndex(source.actualSamples),
  };
  if (
    !result ||
    result.targetSamples < length ||
    result.actualSamples !== length ||
    !['complete', 'stopped', 'budget', 'allocation-failed', 'store-limit', 'error'].includes(result.stopReason) ||
    (result.stopReason === 'complete' && result.targetSamples !== length) ||
    !result.memory ||
    ![result.memory.limitBytes, result.memory.usedBytes, result.memory.peakBytes, result.memory.allocations].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    result.memory.usedBytes > result.memory.peakBytes ||
    result.memory.peakBytes > result.memory.limitBytes ||
    typeof result.worker !== 'boolean' ||
    !Number.isInteger(result.buffers) ||
    result.buffers < 1 ||
    result.buffers > 3 ||
    !Number.isInteger(result.maxQueued) ||
    result.maxQueued < 0 ||
    result.maxQueued > result.buffers ||
    (result.error !== undefined && typeof result.error !== 'string')
  )
    throw new Error('Invalid acquisition metadata');
  return {
    targetSamples: result.targetSamples,
    actualSamples: result.actualSamples,
    stopReason: result.stopReason,
    memory: { ...result.memory },
    worker: result.worker,
    buffers: result.buffers,
    maxQueued: result.maxQueued,
    ...(result.error ? { error: result.error.slice(0, 4096) } : {}),
  };
}
