export interface ColumnView {
  readonly channel: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly bins: number;
  readonly low: Uint8Array;
  readonly high: Uint8Array;
  readonly edge: Uint8Array;
  readonly packed: Uint8Array;
}

export const GAP_BIT = 8;

export interface SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  readonly length: number;
  append(chunk: Uint8Array): void;
  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView;
  edges(channel: number, startSample: number, endSample: number): Int32Array;

  noteGap(startSample: number, endSample: number): void;

  gaps(): GapSpan[];
}

export type { ChannelCount } from './channel-count.js';

export interface GapSpan {
  readonly startSample: number;
  readonly endSample: number;
}

export interface MemoryReport {

  baseBytes: number;

  pyramidBytes: number;
  totalBytes: number;

  overhead: number;

  slackBytes: number;
}
