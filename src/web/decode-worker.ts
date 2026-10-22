import { componentFailure } from '../components.js';
import { createEdgeWindow, createPackedWindow, createValuesWindow } from '../libhakeidecode/signal.js';
import { compareSamples } from '../libhakei/sample-index.js';
import { decoderWorkerDefinition } from '../decoders/workers.js';
import { createDecodeRuntime } from './decode-runtime.js';
import type { DecodeRuntime, DecodeRuntimeResult } from './decode-runtime.js';
import { AnnotationIndex } from './event-index.js';
import { SharedCaptureError, SharedChunkReader } from './shared-chunks.js';
import type { DecodeChunkRequest, DecodeEdgeChunkRequest, DecodeFinishRequest, DecodeFrame, DecodeGapRequest, DecodePackedReaderStartRequest, DecodeQueryAnnotationsRequest, DecodeReadCsvRequest, DecodeReadFramesRequest, DecodeSharedStartRequest, DecodeStartRequest, DecodeStreamRequest, DecodeWorkerReaderStartRequest, DecoderId, WorkerDecodeMessage } from './protocol.js';
import type { DecodeReadResponse } from './worker-store.js';

type Scope = {
  onmessage: ((event: MessageEvent<DecodeStreamRequest>) => void) | null;
  postMessage: (message: WorkerDecodeMessage, transfer?: Transferable[]) => void;
};
const scope = globalThis as unknown as Scope;

interface Session {
  decoder: DecoderId;
  sampleRate: number;
  length: bigint;
  processed: bigint;
  decodedSamples: bigint;
  started: number;
  channels: string[];
  gaps: DecodeStartRequest['gaps'];
  runtime: DecodeRuntime;
  output: DecodeRuntimeResult | null;
  annotations: AnnotationIndex;
  frames: DecodeFrame[];
  framesSorted: boolean;
  compareFrames: (a: DecodeFrame, b: DecodeFrame) => number;
  completed: boolean;
  lastProgressPost: number;
  sharedTask: Promise<void> | null;
  sharedReader: SharedChunkReader | null;
  packedPort: MessagePort | null;
  packedChannels: Record<string, number> | null;
  packedChannelCount: number;
  packedNextId: number;
  packedPending: Map<number, { resolve(data: Uint8Array): void; reject(error: Error): void }>;
  workerPort: MessagePort | null;
  workerChannels: Record<string, number> | null;
  workerNextId: number;
  workerPending: Map<number, { resolve(response: Extract<DecodeReadResponse, { type: 'decode-read-result' }>): void; reject(error: Error): void }>;
  finishRequested: boolean;
  finalLength: bigint;
  stages: { sharedUnpackMs: number; decoderPushMs: number; runtimeBatchMs: number; outputPostMs: number; cooperativeYieldMs: number; cooperativeYieldCount: number };
}

let session: Session | null = null;
let queue = Promise.resolve();
const taskYieldChannel = new MessageChannel();
let taskYieldResolve: (() => void) | null = null;
taskYieldChannel.port1.onmessage = () => {
  const resolve = taskYieldResolve;
  taskYieldResolve = null;
  resolve?.();
};
function yieldWorkerTask(): Promise<void> {
  return new Promise(resolve => {
    taskYieldResolve = resolve;
    taskYieldChannel.port2.postMessage(0);
  });
}
scope.onmessage = event => {
  if (event.data.type === 'decode-query-annotations') { try { queryAnnotations(event.data); } catch (error) { scope.postMessage({ type: 'error', ...componentFailure(error) }); } return; }
  if (event.data.type === 'decode-read-frames') { try { readFrames(event.data); } catch (error) { scope.postMessage({ type: 'error', ...componentFailure(error) }); } return; }
  if (event.data.type === 'decode-read-csv') { try { readCsv(event.data); } catch (error) { scope.postMessage({ type: 'error', ...componentFailure(error) }); } return; }
  if (event.data.type === 'decode-read-binary') { try { readBinary(event.data); } catch (error) { scope.postMessage({ type: 'error', ...componentFailure(error) }); } return; }
  queue = queue.then(() => handle(event.data)).catch(error => {
    session = null;
    scope.postMessage({ type: 'error', ...componentFailure(error) });
  });
};

function progress(s: Session): number { return s.length ? Math.min(1, Number(s.processed * 1000n / s.length) / 1000) : 1; }
function post(s: Session, message: WorkerDecodeMessage, transfer?: Transferable[]): void {
  const started = performance.now(); scope.postMessage(message, transfer); s.stages.outputPostMs += performance.now() - started;
}
function maybePostProgress(s: Session): void {
  const now = performance.now();
  if (now - s.lastProgressPost < 100 && s.processed < s.length) return;
  s.lastProgressPost = now;
  post(s, { type: 'decode-progress', progress: progress(s), frames: s.runtime.frameCount, annotations: s.runtime.annotationCount,
    samples: s.decodedSamples, resultBytes: s.runtime.resultBytes });
}
function start(request: DecodeStartRequest): void {
  if (!Number.isSafeInteger(request.sampleRate) || request.sampleRate < 1 || request.length < 0n) throw new Error('Invalid decode stream configuration');
  const compareFrames = decoderWorkerDefinition(request.decoder).compareFrames;
  const s = {
    decoder: request.decoder, sampleRate: request.sampleRate, length: request.length, processed: 0n, decodedSamples: 0n,
    started: performance.now(), channels: request.channels, gaps: request.gaps, runtime: null as unknown as DecodeRuntime,
    annotations: new AnnotationIndex(), frames: [], framesSorted: true, output: null,
    compareFrames: compareFrames ? (a, b) => compareFrames(a, b) : (a, b) => compareSamples(a.ss, b.ss),
    completed: false, lastProgressPost: 0, sharedTask: null, sharedReader: null,
    packedPort: null, packedChannels: null, packedChannelCount: 0, packedNextId: 0, packedPending: new Map(),
    workerPort: null, workerChannels: null, workerNextId: 0, workerPending: new Map(), finishRequested: false, finalLength: request.length,
    stages: { sharedUnpackMs: 0, decoderPushMs: 0, runtimeBatchMs: 0, outputPostMs: 0, cooperativeYieldMs: 0, cooperativeYieldCount: 0 },
  } as Session;
  session = s;
  s.runtime = createDecodeRuntime(request, {
    postBatch: batch => {
      s.annotations.append(batch.annotations);
      for (const frame of batch.frames) s.frames.push(frame);
      if (batch.frames.length) s.framesSorted = false;
      return Promise.resolve();
    },
    postPaged: () => {},
  });
}
function queryAnnotations(request: DecodeQueryAnnotationsRequest): void {
  const s = session;
  const annotations = s?.runtime.queryAnnotations?.(request.start, request.end, request.maxResults) ?? s?.annotations.query(request.start, request.end, request.maxResults) ?? [];
  scope.postMessage({ type: 'decode-query-annotations-result', requestId: request.requestId, annotations });
}
function readFrames(request: DecodeReadFramesRequest): void {
  const s = session;
  const frames = s?.runtime.readFrames?.(request.offset, request.count) ?? s?.frames.slice(request.offset, request.offset + request.count) ?? [];
  scope.postMessage({ type: 'decode-read-frames-result', requestId: request.requestId, frames });
}
function readCsv(request: DecodeReadCsvRequest): void {
  const s = session;
  if (!s) { scope.postMessage({ type: 'decode-read-csv-result', requestId: request.requestId, csv: '' }); return; }
  const definition = decoderWorkerDefinition(s.decoder);
  const frames = s.runtime.readFrames?.(request.offset, request.count) ?? s.frames.slice(request.offset, request.offset + request.count);
  const rows = frames.map(frame => definition.csvRow(frame, request.sampleRate, request.triggerSample));
  const csv = (request.includeHeader ? definition.csvHeader + '\r\n' : '') + rows.join('\r\n');
  scope.postMessage({ type: 'decode-read-csv-result', requestId: request.requestId, csv });
}
function readBinary(request: Extract<DecodeStreamRequest, { type: 'decode-read-binary' }>): void {
  const data = session?.output?.binaries[request.key];
  scope.postMessage({ type: 'decode-read-binary-result', requestId: request.requestId,
    blob: data ? new Blob([data.slice().buffer], { type: 'application/octet-stream' }) : null });
}
function startShared(s: Session, request: DecodeSharedStartRequest): void {
  if (request.channelCount < 1 || request.channelCount > 8) throw new Error('Shared packed capture supports 1..8 logic channels');
  if (s.sharedTask) throw new Error('Shared decode source is already connected');
  const reader = new SharedChunkReader(request.port);
  s.sharedReader = reader;
  s.sharedTask = consumeShared(s, reader, request.channels);
}
function startPackedReader(s: Session, request: DecodePackedReaderStartRequest): void {
  if (!Number.isInteger(request.channelCount) || request.channelCount < 1 || request.channelCount > 8) throw new Error('Packed capture supports 1..8 logic channels');
  if (s.sharedTask) throw new Error('Decode source is already connected');
  for (const [key, channel] of Object.entries(request.channels)) {
    if (!s.channels.includes(key) || !Number.isInteger(channel) || channel < 0 || channel >= request.channelCount) throw new Error('Invalid packed decode channel');
  }
  s.packedPort = request.port; s.packedChannels = request.channels; s.packedChannelCount = request.channelCount;
  request.port.addEventListener('message', ({ data }: MessageEvent<{ type: 'read-result' | 'read-error'; id: number; data?: Uint8Array; message?: string }>) => {
    const pending = s.packedPending.get(data.id); if (!pending) return;
    s.packedPending.delete(data.id);
    if (data.type === 'read-error') pending.reject(new Error(data.message ?? 'Packed sample read failed'));
    else if (data.data instanceof Uint8Array) pending.resolve(data.data);
    else pending.reject(new Error('Packed sample reader returned invalid data'));
  });
  request.port.start();
  s.sharedTask = consumePacked(s);
  void s.sharedTask.catch(error => {
    for (const pending of s.packedPending.values()) pending.reject(error instanceof Error ? error : new Error(String(error)));
    s.packedPending.clear(); s.packedPort?.close(); s.packedPort = null; session = null;
    scope.postMessage({ type: 'error', ...componentFailure(error) });
  });
}
function requestPackedRange(s: Session, startSample: bigint, endSample: bigint): Promise<Uint8Array> {
  const port = s.packedPort; if (!port) return Promise.reject(new Error('Packed sample reader is unavailable'));
  const id = s.packedNextId++;
  return new Promise((resolve, reject) => {
    s.packedPending.set(id, { resolve, reject });
    port.postMessage({ type: 'read', id, startSample, endSample, channels: s.packedChannelCount });
  });
}
async function pushPacked(s: Session, startSample: bigint, data: Uint8Array, selected: Record<string, number>): Promise<void> {
  const started = performance.now();
  const end = startSample + BigInt(data.length);
  await s.runtime.push(createPackedWindow(startSample, s.sampleRate, data, selected), Number(end * 1000n / (s.length || 1n)) / 1000);
  await s.runtime.flush(progress(s));
  s.stages.decoderPushMs += performance.now() - started;
  s.decodedSamples += BigInt(data.length); s.processed = end;
}
async function consumePacked(s: Session): Promise<void> {
  const selected = s.packedChannels!;
  for (let start = 0n; start < s.length;) {
    const end = start + 1_048_576n < s.length ? start + 1_048_576n : s.length;
    const packed = await requestPackedRange(s, start, end);
    await pushPacked(s, start, packed, selected);
    maybePostProgress(s);
    start = end;
  }
}

function startWorkerReader(s: Session, request: DecodeWorkerReaderStartRequest): void {
  if (s.sharedTask) throw new Error('Decode source is already connected');
  for (const [key, channel] of Object.entries(request.channels)) {
    if (!s.channels.includes(key) || !Number.isInteger(channel) || channel < 0) throw new Error('Invalid Worker decode channel');
  }
  s.workerPort = request.port; s.workerChannels = request.channels;
  request.port.addEventListener('message', ({ data }: MessageEvent<DecodeReadResponse>) => {
    const pending = s.workerPending.get(data.id); if (!pending) return;
    s.workerPending.delete(data.id);
    if (data.type === 'decode-read-error') pending.reject(new Error(data.message));
    else pending.resolve(data);
  });
  request.port.start();
  s.sharedTask = consumeWorkerReader(s, request.edgeInput, request.edgeLimit);
  void s.sharedTask.catch(error => {
    for (const pending of s.workerPending.values()) pending.reject(error instanceof Error ? error : new Error(String(error)));
    s.workerPending.clear(); s.workerPort?.close(); s.workerPort = null; session = null;
    scope.postMessage({ type: 'error', ...componentFailure(error) });
  });
}
function requestWorkerRead(s: Session, startSample: bigint, endSample: bigint, edgeInput: string | undefined, edgeLimit: number): Promise<Extract<DecodeReadResponse, { type: 'decode-read-result' }>> {
  const port = s.workerPort; if (!port) return Promise.reject(new Error('Worker sample reader is unavailable'));
  const id = s.workerNextId++;
  return new Promise((resolve, reject) => {
    s.workerPending.set(id, { resolve, reject });
    port.postMessage({ type: 'decode-read', id, startSample, endSample, channels: s.workerChannels!, ...(edgeInput === undefined ? {} : { edgeInput }), edgeLimit });
  });
}
async function consumeWorkerReader(s: Session, edgeInput: string | undefined, edgeLimit: number): Promise<void> {
  let cursor = 0n;
  while (true) {
    const limit = s.finishRequested && s.finalLength < s.length ? s.finalLength : s.length;
    if (cursor >= limit) {
      if (s.finishRequested) break;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      continue;
    }
    const end = cursor + 1_048_576n < limit ? cursor + 1_048_576n : limit;
    const response = await requestWorkerRead(s, cursor, end, edgeInput, edgeLimit);
    if (response.kind === 'wait') {
      if (s.finishRequested && response.availableEnd <= cursor) break;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      continue;
    }
    if (response.kind === 'channels') {
      await pushChunk(s, { type: 'decode-chunk', startSample: response.startSample, sampleRate: response.sampleRate, channels: response.channels });
    } else {
      await pushEdgeChunk(s, { type: 'decode-edge-chunk', startSample: response.startSample, endSample: response.endSample, parts: response.parts });
    }
    cursor = response.endSample;
    maybePostProgress(s);
  }
}
async function consumeShared(s: Session, reader: SharedChunkReader, selected: Record<string, number>): Promise<void> {
  try {
    const picked: Record<string, number> = {};
    for (const channel of s.channels) {
      const bit = selected[channel];
      if (!Number.isInteger(bit) || bit! < 0 || bit! > 7) throw new Error('Invalid shared decode channel');
      picked[channel] = bit!;
    }
    let lastYield = performance.now();
    while (true) {
      const part = await reader.next(1_048_576);
      if (!part) break;
      await pushPacked(s, part.startSample, part.data, picked);
      maybePostProgress(s);
      if (performance.now() - lastYield >= 8) {
        const yieldStarted = performance.now();
        await yieldWorkerTask();
        s.stages.cooperativeYieldMs += performance.now() - yieldStarted;
        s.stages.cooperativeYieldCount++;
        lastYield = performance.now();
      }
    }
  } catch (error) {
    if (!(error instanceof SharedCaptureError)) throw error;
  } finally {
    reader.close();
  }
}
function gapParts(s: Session, request: DecodeChunkRequest): Array<{ start: bigint; end: bigint; offset: number; reset: boolean }> {
  const start = request.startSample, end = start + BigInt(request.channels[s.channels[0]!]?.length ?? 0), parts: Array<{ start: bigint; end: bigint; offset: number; reset: boolean }> = [];
  let cursor = start, reset = false;
  for (const gap of s.gaps) {
    if (gap.endSample <= cursor || gap.startSample >= end) continue;
    const gapStart = gap.startSample > cursor ? gap.startSample : cursor;
    if (cursor < gapStart) { parts.push({ start: cursor, end: gapStart, offset: Number(cursor - start), reset }); reset = false; }
    reset = true; cursor = gap.endSample > cursor ? gap.endSample : cursor;
  }
  if (cursor < end) parts.push({ start: cursor, end, offset: Number(cursor - start), reset });
  return parts;
}
function resetAtGap(s: Session): void { s.runtime.reset(); }
async function pushChunk(s: Session, request: DecodeChunkRequest): Promise<void> {
  if (request.sampleRate !== s.sampleRate || request.startSample !== s.processed) throw new Error('Decode stream is not contiguous');
  const first = s.channels[0], count = first ? request.channels[first]?.length ?? -1 : -1;
  if (count < 0 || s.channels.some(channel => request.channels[channel]?.length !== count)) throw new Error('Decode chunk channel layout changed');
  const parts = gapParts(s, request), outputWindow = 65_536n, yieldWindow = 1_048_576n;
  let yieldSamples = 0n;
  for (const part of parts) {
    if (part.reset) resetAtGap(s);
    for (let cursor = part.start; cursor < part.end;) {
      const end = cursor + outputWindow < part.end ? cursor + outputWindow : part.end;
      const span = end - cursor;
      const offset = part.offset + Number(cursor - part.start), channels: Record<string, Uint8Array> = {};
      for (const channel of s.channels) channels[channel] = request.channels[channel]!.subarray(offset, offset + Number(end - cursor));
      const decodeStarted = performance.now();
      const value = Number(end * 1000n / (s.length || 1n)) / 1000;
      await s.runtime.push(createValuesWindow(cursor, s.sampleRate, channels), value);
      await s.runtime.flush(value);
      s.stages.decoderPushMs += performance.now() - decodeStarted;
      s.decodedSamples += span; s.processed = end; cursor = end; yieldSamples += span;
      maybePostProgress(s);
      if (yieldSamples >= yieldWindow) {
        const yieldStarted = performance.now();
        await yieldWorkerTask();
        s.stages.cooperativeYieldMs += performance.now() - yieldStarted;
        s.stages.cooperativeYieldCount++;
        yieldSamples = 0n;
      }
    }
  }
  s.processed = request.startSample + BigInt(count); maybePostProgress(s);
}
function pushGap(s: Session, request: DecodeGapRequest): void {
  if (request.startSample !== s.processed || request.endSample < request.startSample || request.endSample > s.length) throw new Error('Decode gap is not contiguous');
  resetAtGap(s); s.processed = request.endSample;
}
async function pushEdgeChunk(s: Session, request: DecodeEdgeChunkRequest): Promise<void> {
  if (request.startSample !== s.processed || request.endSample < request.startSample || request.endSample > s.length) throw new Error('Decode edge stream is not contiguous');
  let cursor = request.startSample;
  if (!request.parts.length && request.endSample > cursor) resetAtGap(s);
  for (const part of request.parts) {
    if (part.startSample < cursor || part.endSample < part.startSample || part.endSample > request.endSample) throw new Error('Invalid edge chunk part');
    if (part.startSample > cursor) resetAtGap(s);
    const value = Number(part.endSample * 1000n / (s.length || 1n)) / 1000;
    await s.runtime.push(createEdgeWindow(part.startSample, part.endSample, s.sampleRate, part.initial, part.edges), value);
    await s.runtime.flush(value);
    s.decodedSamples += part.endSample - part.startSample; cursor = part.endSample;
  }
  if (cursor < request.endSample) resetAtGap(s);
  s.processed = request.endSample; maybePostProgress(s);
}
async function finish(s: Session, request: DecodeFinishRequest): Promise<void> {
  s.finishRequested = true;
  s.finalLength = request.length !== undefined && request.length < s.length ? request.length : s.length;
  if (s.sharedTask) await s.sharedTask;
  const output: DecodeRuntimeResult = await s.runtime.finish(1);
  if (!s.framesSorted && s.frames.length) { s.frames.sort(s.compareFrames); s.framesSorted = true; }
  const stages = { ...s.stages };
  maybePostProgress(s);
  s.completed = true;
  s.output = output;
  const { binaries, ...details } = output;
  const binarySizes = Object.fromEntries(Object.entries(binaries).map(([key, data]) => [key, data.byteLength]));
  const previews = Object.fromEntries(Object.entries(binaries).map(([key, data]) => [key, data.slice(0, 100)]));
  post(s, { type: 'done', decoder: s.decoder,
    stats: { elapsedMs: performance.now() - s.started, samples: s.decodedSamples, frames: output.frames, annotations: output.annotations,
      truncated: output.truncated, binaryTruncated: output.binaryTruncated, stages },
    result: { ...details, binarySizes, previews } });
}
async function handle(request: DecodeStreamRequest): Promise<void> {
  if (request.type === 'decode-start') { start(request); return; }
  if (request.type === 'decode-query-annotations') { queryAnnotations(request); return; }
  if (request.type === 'decode-read-frames') { readFrames(request); return; }
  if (request.type === 'decode-read-csv') { readCsv(request); return; }
  if (request.type === 'decode-read-binary') { readBinary(request); return; }
  if (!session) throw new Error('Decode chunk received before decoder start');
  if (request.type === 'decode-shared-start') { startShared(session, request); return; }
  if (request.type === 'decode-packed-reader-start') { startPackedReader(session, request); return; }
  if (request.type === 'decode-worker-reader-start') { startWorkerReader(session, request); return; }
  if (request.type === 'decode-chunk') { await pushChunk(session, request); scope.postMessage({ type: 'decode-ack' }); return; }
  if (request.type === 'decode-gap') { pushGap(session, request); return; }
  if (request.type === 'decode-edge-chunk') { await pushEdgeChunk(session, request); scope.postMessage({ type: 'decode-ack' }); return; }
  await finish(session, request);
}
