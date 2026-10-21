import type { SampleInput } from '../../libhakei/sample-index.js';

export interface ColumnView {
  readonly channel: number;
  readonly startSample: bigint;
  readonly endSample: bigint;
  readonly bins: number;
  readonly low: Uint8Array;
  readonly high: Uint8Array;
  readonly edge: Uint8Array;
  readonly packed: Uint8Array;
  readonly points?: Uint8Array;
}

export const GAP_BIT = 8;

export interface SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  readonly length: bigint;
  append(chunk: Uint8Array): void;
  query(channel: number, startSample: SampleInput, endSample: SampleInput, bins: number): ColumnView;
  edges(channel: number, startSample: SampleInput, endSample: SampleInput): bigint[];

  noteGap(startSample: SampleInput, endSample: SampleInput): void;

  gaps(): GapSpan[];
}

export type { ChannelCount } from './channel-count.js';

export interface GapSpan {
  readonly startSample: bigint;
  readonly endSample: bigint;
}

export interface MemoryReport {

  baseBytes: number;

  pyramidBytes: number;
  totalBytes: number;

  overhead: number;

  slackBytes: number;
}
