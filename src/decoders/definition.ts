import type { DecoderDescriptor, OptionValue, SignalWindow } from '../libhakeidecode/types.js';
import type { ComponentMessages } from '../components.js';

export interface Annotation {
  ss: bigint;
  es: bigint;
  classIndex: number;
  texts: readonly string[];
  value?: number;
}
export interface DecodeFrame {
  readonly ss: bigint;
  readonly es: bigint;
}
export interface DecodeBatch<F extends DecodeFrame = DecodeFrame> {
  type: 'batch';
  progress: number;
  annotations: Annotation[];
  frames: F[];
}
export interface DecodeRuntimeResult {
  readonly binaries: Record<string, Uint8Array>;
  readonly values: Record<string, number | null>;
  readonly frames: number;
  readonly annotations: number;
  readonly truncated: boolean;
  readonly binaryTruncated: boolean;
}
export interface DecodeResultSummary extends Omit<DecodeRuntimeResult, 'binaries'> {
  readonly binarySizes: Readonly<Record<string, number>>;
  readonly previews: Readonly<Record<string, Uint8Array>>;
}
// Result buffers and value payloads, excluding JavaScript engine overhead.
export interface DecodeResultMemory {
  readonly annotationsBytes: number;
  readonly framesBytes: number;
  readonly binaryBytes: number;
  readonly totalBytes: number;
}
export function resultMemory(annotationsBytes = 0, framesBytes = 0, binaryBytes = 0): DecodeResultMemory {
  return { annotationsBytes, framesBytes, binaryBytes, totalBytes: annotationsBytes + framesBytes + binaryBytes };
}
export interface DecodeRuntimeHost {
  postBatch(batch: DecodeBatch): Promise<void>;
  postPaged(frames: number, annotations: number, resultBytes: number): void;
}
export interface DecodeRuntime {
  readonly frameCount: number;
  readonly annotationCount: number;
  // The host counts stored batches and finished binary outputs it owns.
  memory(): DecodeResultMemory;
  push(window: SignalWindow, progress: number): Promise<void>;
  flush(progress: number): Promise<void>;
  reset(): void;
  finish(progress: number): Promise<DecodeRuntimeResult>;
  queryAnnotations?(start: bigint, end: bigint, maxResults: number): Annotation[] | null;
  readFrames?(offset: number, count: number): DecodeFrame[] | null;
}
export interface DecodeRuntimeContext {
  readonly sampleRate: number;
  readonly channels: readonly string[];
  readonly options: Record<string, OptionValue>;
  readonly paged: 'always' | 'auto' | 'never';
  readonly host: DecodeRuntimeHost;
}
export interface DecoderInputDefinition {
  readonly key: string;
  readonly label: string;
  readonly labelKey?: string;
  readonly optional?: boolean;
}
export interface DecoderRowDefinition {
  readonly label: string;
  readonly labelKey?: string;
  readonly classes: readonly number[];
}
export interface DecoderBinaryDefinition {
  readonly key: string;
  readonly label: string;
  readonly labelKey?: string;
}
export interface AnnotationTextContext {
  readonly sampleRate: number;
  readonly decimals: number;
  text(key: string, fallback: string): string;
}
export interface DecoderUiDefinition {
  readonly description?: string;
  readonly descriptionKey?: string;
  readonly inputs: readonly DecoderInputDefinition[];
  readonly inputRequirement?: 'any' | 'all';
  readonly rows: readonly DecoderRowDefinition[];
  readonly primaryOptions?: readonly string[];
  readonly decimals?: boolean;
  readonly edgeInput?: string;
  readonly binaryOutputs?: readonly DecoderBinaryDefinition[];
  summary?(result: DecodeResultSummary, decimals: number, text: (key: string, fallback: string) => string): string;
  annotationTexts?(annotation: Annotation, context: AnnotationTextContext): readonly string[];
  isErrorClass?(classIndex: number): boolean;
}
export interface DecoderDefinition {
  readonly descriptor: DecoderDescriptor;
  readonly messages: ComponentMessages;
  readonly ui: DecoderUiDefinition;
}
export interface DecoderWorkerDefinition {
  readonly id: string;
  createRuntime(context: DecodeRuntimeContext): DecodeRuntime;
  readonly csvHeader: string;
  csvRow(frame: DecodeFrame, sampleRate: number, triggerSample: bigint): string;
  compareFrames?(left: DecodeFrame, right: DecodeFrame): number;
}
