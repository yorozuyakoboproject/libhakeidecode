import type { OptionValue } from '../libhakeidecode/index.js';
import type { Annotation, DecodeFrame, DecodeRuntimeResult } from '../decoders/definition.js';
import type { GapSpan } from './data/types.js';

export type DecoderId = string;
export type Frame = DecodeFrame;
export type { Annotation, DecodeFrame, DecodeRuntimeResult };
export interface DecodeStats {
  elapsedMs: number; samples: bigint; frames: number; annotations: number; truncated: boolean; binaryTruncated: boolean;
  stages?: { sharedUnpackMs: number; decoderPushMs: number; runtimeBatchMs: number; outputPostMs: number; cooperativeYieldMs: number; cooperativeYieldCount: number };
}
export type DecodeMessage =
  | { type: 'done'; decoder: DecoderId; stats: DecodeStats; result: DecodeRuntimeResult }
  | { type: 'error'; message: string };
export interface DecodeProgressMessage { type: 'decode-progress'; progress: number; frames: number; annotations: number; samples: bigint; resultBytes: number }
export interface DecodeQueryAnnotationsRequest { type: 'decode-query-annotations'; requestId: number; start: bigint; end: bigint; maxResults: number }
export interface DecodeQueryAnnotationsResult { type: 'decode-query-annotations-result'; requestId: number; annotations: Annotation[] }
export interface DecodeReadFramesRequest { type: 'decode-read-frames'; requestId: number; offset: number; count: number }
export interface DecodeReadFramesResult { type: 'decode-read-frames-result'; requestId: number; frames: Frame[] }
export interface DecodeReadCsvRequest { type: 'decode-read-csv'; requestId: number; offset: number; count: number; sampleRate: number; triggerSample: bigint; includeHeader: boolean }
export interface DecodeReadCsvResult { type: 'decode-read-csv-result'; requestId: number; csv: string }

export type PWMPosition = number | bigint;
export type WorkerDecodeMessage = DecodeMessage | DecodeProgressMessage | DecodeQueryAnnotationsResult | DecodeReadFramesResult | DecodeReadCsvResult | { type: 'decode-ack' };
export interface DecodeStartRequest {
  type: 'decode-start'; decoder: DecoderId; sampleRate: number; length: bigint; channels: string[]; gaps: GapSpan[];
  options: Record<string, OptionValue>; paged?: 'always' | 'auto' | 'never';
}
export interface DecodeSharedStartRequest { type: 'decode-shared-start'; port: MessagePort; channelCount: number; channels: Record<string, number> }
export interface DecodePackedReaderStartRequest { type: 'decode-packed-reader-start'; port: MessagePort; channelCount: number; channels: Record<string, number> }
export interface DecodeWorkerReaderStartRequest { type: 'decode-worker-reader-start'; port: MessagePort; channels: Record<string, number>; edgeInput?: string; edgeLimit: number }
export interface DecodeChunkRequest { type: 'decode-chunk'; startSample: bigint; sampleRate: number; channels: Record<string, Uint8Array> }
export interface DecodeGapRequest { type: 'decode-gap'; startSample: bigint; endSample: bigint }
export interface DecodeEdgePart { startSample: bigint; endSample: bigint; initial: 0 | 1; edges: bigint[] }
export interface DecodeEdgeChunkRequest { type: 'decode-edge-chunk'; startSample: bigint; endSample: bigint; parts: DecodeEdgePart[] }
export interface DecodeFinishRequest { type: 'decode-finish'; length?: bigint }
export type DecodeStreamRequest = DecodeStartRequest | DecodeSharedStartRequest | DecodePackedReaderStartRequest | DecodeWorkerReaderStartRequest | DecodeChunkRequest | DecodeGapRequest | DecodeEdgeChunkRequest | DecodeFinishRequest | DecodeQueryAnnotationsRequest | DecodeReadFramesRequest | DecodeReadCsvRequest;
