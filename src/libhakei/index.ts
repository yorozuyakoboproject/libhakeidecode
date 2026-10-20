import { sampleIndex, type SampleInput } from './sample-index.js';
export * from './sample-index.js';

export type LogicSamples = Uint8Array | Uint8ClampedArray | Int8Array | Uint16Array | Int16Array |
  Uint32Array | Int32Array | Float32Array | Float64Array;
export type AnalogSamples = Float32Array | Float64Array;
export interface SampleChunkInput {
  readonly startSample?: SampleInput;
  readonly sampleRate: number;
  readonly channels: Readonly<Record<string, LogicSamples | readonly number[]>>;
  readonly analogChannels?: Readonly<Record<string, AnalogSamples | readonly number[]>>;
  readonly isFinal?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface SampleChunk extends SampleChunkInput {
  readonly startSample: bigint;
  readonly channels: Readonly<Record<string, LogicSamples>>;
  readonly analogChannels: Readonly<Record<string, AnalogSamples>>;
  readonly isFinal: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly length: number;

  readonly endSample: bigint;
}
export type SampleSource = AsyncIterable<SampleChunkInput>;
export class SampleFormatError extends Error {
  constructor(message: string) { super(message); this.name = 'SampleFormatError'; }
}
function asTypedArray(value: unknown, name: string): LogicSamples {
  if (!(ArrayBuffer.isView(value) && !(value instanceof DataView)) && !Array.isArray(value)) throw new SampleFormatError(`Channel ${name} must be a TypedArray or array.`);
  const values = value as ArrayLike<unknown>;
  for (let i = 0; i < values.length; i++) if (values[i] !== 0 && values[i] !== 1) throw new SampleFormatError(`Logic channel ${name} contains a value other than 0 or 1 at index ${i}.`);
  return Array.isArray(value) ? Uint8Array.from(value) : value as LogicSamples;
}
function asAnalogArray(value: unknown, name: string): AnalogSamples {
  if (!(ArrayBuffer.isView(value) && !(value instanceof DataView)) && !Array.isArray(value)) throw new SampleFormatError(`Analog channel ${name} must be a TypedArray or array.`);
  const values = value as ArrayLike<unknown>;
  for (let i = 0; i < values.length; i++) if (typeof values[i] !== 'number' || !Number.isFinite(values[i] as number)) {
    throw new SampleFormatError(`Analog channel ${name} contains a non-finite value at index ${i}.`);
  }
  if (Array.isArray(value) && value.some(sample => Math.abs(sample) > 3.4028234663852886e38)) throw new SampleFormatError(`Analog channel ${name} exceeds Float32 range.`);
  return Array.isArray(value) ? Float32Array.from(value as readonly number[]) : value as AnalogSamples;
}
export function createSampleChunk({ startSample: inputStart = 0n, sampleRate, channels, analogChannels = {}, isFinal = false, metadata = {} }: SampleChunkInput): SampleChunk {
  let startSample: bigint;
  try { startSample = sampleIndex(inputStart, 'startSample'); } catch (error) { throw new SampleFormatError((error as Error).message); }
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new SampleFormatError('sampleRate must be a positive safe integer in Hz.');
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) throw new SampleFormatError('channels must be an object keyed by channel id.');
  const normalized: Record<string, LogicSamples> = {};
  let length: number | null = null;
  for (const [name, value] of Object.entries(channels)) {
    const typed = asTypedArray(value, name);
    if (length === null) length = typed.length;
    if (typed.length !== length) throw new SampleFormatError('All channels in a chunk must have equal length.');
    Object.defineProperty(normalized, name, { value: typed, enumerable: true });
  }
  const normalizedAnalog: Record<string, AnalogSamples> = {};
  for (const [name, value] of Object.entries(analogChannels)) {
    if (Object.hasOwn(normalized, name)) throw new SampleFormatError(`Channel ${name} is present in both logic and analog channels.`);
    const typed = asAnalogArray(value, name);
    if (length === null) length = typed.length;
    if (typed.length !== length) throw new SampleFormatError('All channels in a chunk must have equal length.');
    Object.defineProperty(normalizedAnalog, name, { value: typed, enumerable: true });
  }
  if (length === null) throw new SampleFormatError('At least one channel is required.');
  return Object.freeze({ startSample, sampleRate, channels: Object.freeze(normalized), analogChannels: Object.freeze(normalizedAnalog), length, endSample: startSample + BigInt(length), isFinal: Boolean(isFinal), metadata: Object.freeze({ ...metadata }) });
}
export class ArraySampleSource<T extends SampleChunkInput = SampleChunkInput> implements AsyncIterable<T> {
  readonly chunks: T[];
  constructor(chunks: Iterable<T>) { this.chunks = Array.from(chunks); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> { yield* this.chunks; }
}
export async function* singleChunkSource<T extends SampleChunkInput>(chunk: T): AsyncGenerator<T> { yield chunk; }

export async function consumeSampleSource<T>(source: AsyncIterable<T> | Iterable<T>, onChunk: (chunk: T) => unknown, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
  signal?.throwIfAborted();
  for await (const chunk of source) { signal?.throwIfAborted(); await onChunk(chunk); signal?.throwIfAborted(); }
}

export * from './demo.js';

export * from './device.js';
