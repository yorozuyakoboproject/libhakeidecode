import type { PWMOptions } from '../decoders/pwm.js';
import type { UARTOptions } from '../decoders/uart.js';
import type { GapSpan } from './data/types.js';
export interface Annotation { ss: bigint; es: bigint; classIndex: number; texts: readonly string[]; value?: number }
export type DecoderId = 'uart' | 'pwm';
export interface UARTFrame { protocol?: 'uart'; ss: bigint; es: bigint; direction: 0 | 1; value: number; valid: boolean | null }
export interface PWMFrame { protocol: 'pwm'; ss: bigint; es: bigint; activeSamples: bigint; periodSamples: bigint; dutyCycle: number; periodSeconds: number; frequencyHz: number; averageDutyCycle: number }
export type Frame = UARTFrame | PWMFrame;
export interface DecodeStats { elapsedMs: number; samples: bigint; frames: number; annotations: number; truncated: boolean; binaryTruncated: boolean; stages?: { sharedUnpackMs: number; decoderPushMs: number; pwmBatchMs: number; outputPostMs: number; cooperativeYieldMs: number; cooperativeYieldCount: number } }
export type DecodeMessage =
  | { type: 'batch'; progress: number; annotations: Annotation[]; frames: Frame[] }
  | { type: 'done'; decoder: DecoderId; stats: DecodeStats; rx: Uint8Array; tx: Uint8Array; pwm: Uint8Array; pwmAverage: number | null }
  | { type: 'error'; message: string };
export interface DecodeProgressMessage { type: 'decode-progress'; progress: number; frames: number; annotations: number; samples: bigint; resultBytes: number }
export interface DecodePagedMessage { type: 'decode-output-mode'; mode: 'paged'; frames: number; annotations: number; resultBytes: number }
export interface DecodeQueryAnnotationsRequest { type: 'decode-query-annotations'; requestId: number; start: bigint; end: bigint; maxResults: number }
export interface DecodeQueryAnnotationsResult { type: 'decode-query-annotations-result'; requestId: number; annotations: Annotation[] }
export interface DecodeReadFramesRequest { type: 'decode-read-frames'; requestId: number; offset: number; count: number }
export interface DecodeReadFramesResult { type: 'decode-read-frames-result'; requestId: number; frames: Frame[] }

export interface PackedPWMBatch { type: 'pwm-batch'; progress: number; cycles: bigint[]; averages: Float64Array; annotations: number }
export type WorkerDecodeMessage = DecodeMessage | PackedPWMBatch | DecodeProgressMessage | DecodePagedMessage | DecodeQueryAnnotationsResult | DecodeReadFramesResult | { type: 'decode-ack' };
export interface DecodeStartRequest {
  type: 'decode-start'; decoder: DecoderId; sampleRate: number; length: bigint; channels: string[]; gaps: GapSpan[]; options: Partial<UARTOptions> | Partial<PWMOptions>; paged?: 'always' | 'auto' | 'never';
}
export interface DecodeSharedStartRequest {
  type: 'decode-shared-start'; port: MessagePort; channelCount: number; channels: Record<string, number>;
}
export interface DecodePackedReaderStartRequest {
  type: 'decode-packed-reader-start'; port: MessagePort; channelCount: number; channels: Record<string, number>;
}
export interface DecodeChunkRequest { type: 'decode-chunk'; startSample: bigint; sampleRate: number; channels: Record<string, Uint8Array> }
export interface DecodeGapRequest { type: 'decode-gap'; startSample: bigint; endSample: bigint }
export interface DecodeEdgePart { startSample: bigint; endSample: bigint; initial: 0 | 1; edges: bigint[] }
export interface DecodeEdgeChunkRequest { type: 'decode-edge-chunk'; startSample: bigint; endSample: bigint; parts: DecodeEdgePart[] }
export interface DecodeFinishRequest { type: 'decode-finish' }
export type DecodeStreamRequest = DecodeStartRequest | DecodeSharedStartRequest | DecodePackedReaderStartRequest | DecodeChunkRequest | DecodeGapRequest | DecodeEdgeChunkRequest | DecodeFinishRequest | DecodeQueryAnnotationsRequest | DecodeReadFramesRequest | { type: 'decode-output-ack' };
export function frameCSV(frames: Iterable<Frame>, sampleRate: number, triggerSample = 0n, decoder: DecoderId = 'uart'): string {
  const list = Array.from(frames);
  if (decoder === 'pwm') {
    const cycles = list.filter((f): f is PWMFrame => f.protocol === 'pwm');
    return 'start_sample,end_sample,time_s,active_samples,period_samples,duty_percent,period_s,frequency_hz,average_duty_percent\r\n' + cycles.map(f =>
      [f.ss, f.es, Number(f.ss - triggerSample) / sampleRate, f.activeSamples, f.periodSamples, f.dutyCycle, f.periodSeconds, f.frequencyHz, f.averageDutyCycle].join(',')).join('\r\n');
  }
  const uart = list.filter(f => f.protocol !== 'pwm') as UARTFrame[];
  return 'direction,start_sample,end_sample,time_s,value_hex,value_dec,valid\r\n' + uart.map(f =>
    [f.direction ? 'TX' : 'RX', f.ss, f.es, Number(f.ss - triggerSample) / sampleRate, f.value.toString(16).toUpperCase(), f.value, f.valid === null ? 'incomplete' : f.valid].join(',')).join('\r\n');
}
