import { componentFailure } from '../components.js';
import {
  createEdgeWindow,
  createEdgesWindow,
  createPackedWindow,
  createValuesWindow,
} from '../libhakeidecode/signal.js';
import { compareSamples } from '../libhakei/sample-index.js';
import { decoderWorkerDefinition } from '../decoders/workers.js';
import { ensureWorkerDecoder } from '../kernel/worker-plugins.js';
import { DecodeGraphRuntime } from '../decoders/graph-runtime.js';
import { createDecodeRuntime } from './decode-runtime.js';
import type { DecodeRuntime, DecodeRuntimeResult } from './decode-runtime.js';
import { resultMemory } from '../decoders/definition.js';
import { DecodeResultStore } from './decode-result-store.js';
import { SharedCaptureError, SharedChunkReader } from './shared-chunks.js';
import type {
  Annotation,
  DecodeChunkRequest,
  DecodeEdgeChunkRequest,
  DecodeFinishRequest,
  DecodeGapRequest,
  DecodeGraphStartRequest,
  DecodePackedReaderStartRequest,
  DecodeQueryAnnotationsRequest,
  DecodeReadCsvRequest,
  DecodeReadFramesRequest,
  DecodeSharedStartRequest,
  DecodeStartRequest,
  DecodeStreamRequest,
  DecodeWorkerReaderStartRequest,
  DecoderId,
  WorkerDecodeMessage,
} from './protocol.js';
import type { DecodeReadResponse } from './worker-store.js';
import { yieldWorkerTask } from './worker-task.js';

type Scope = {
  onmessage: ((event: MessageEvent<DecodeStreamRequest>) => void) | null;
  postMessage: (message: WorkerDecodeMessage, transfer?: Transferable[]) => void;
};
const scope = globalThis as unknown as Scope;

interface Session {
  decoder: DecoderId;
  sampleRate: number;
  length: bigint;
  rolling: boolean;
  retainedStart: bigint;
  processed: bigint;
  decodedSamples: bigint;
  started: number;
  channels: string[];
  gaps: DecodeStartRequest['gaps'];
  runtime: DecodeRuntime;
  results: DecodeResultStore;
  graph: DecodeGraphRuntime | null;
  instances: Map<string, { decoder: DecoderId; results: DecodeResultStore }> | null;
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
  workerPending: Map<
    number,
    { resolve(response: Extract<DecodeReadResponse, { type: 'decode-read-result' }>): void; reject(error: Error): void }
  >;
  finishRequested: boolean;
  finalLength: bigint;
  stages: {
    sharedUnpackMs: number;
    decoderPushMs: number;
    runtimeBatchMs: number;
    outputPostMs: number;
    cooperativeYieldMs: number;
    cooperativeYieldCount: number;
  };
}

let session: Session | null = null;
let queue = Promise.resolve();
scope.onmessage = (event) => {
  if (event.data.type === 'decode-query-annotations') {
    try {
      queryAnnotations(event.data);
    } catch (error) {
      scope.postMessage({ type: 'error', ...componentFailure(error) });
    }
    return;
  }
  if (event.data.type === 'decode-read-frames') {
    try {
      readFrames(event.data);
    } catch (error) {
      scope.postMessage({ type: 'error', ...componentFailure(error) });
    }
    return;
  }
  if (event.data.type === 'decode-read-csv') {
    try {
      readCsv(event.data);
    } catch (error) {
      scope.postMessage({ type: 'error', ...componentFailure(error) });
    }
    return;
  }
  if (event.data.type === 'decode-read-binary') {
    try {
      readBinary(event.data);
    } catch (error) {
      scope.postMessage({ type: 'error', ...componentFailure(error) });
    }
    return;
  }
  queue = queue
    .then(() => handle(event.data))
    .catch((error) => {
      session = null;
      scope.postMessage({ type: 'error', ...componentFailure(error) });
    });
};

function progress(s: Session): number {
  return s.length ? Math.min(1, Number((s.processed * 1000n) / s.length) / 1000) : 1;
}
function post(s: Session, message: WorkerDecodeMessage, transfer?: Transferable[]): void {
  const started = performance.now();
  scope.postMessage(message, transfer);
  s.stages.outputPostMs += performance.now() - started;
}
function maybePostProgress(s: Session): void {
  const now = performance.now();
  if (now - s.lastProgressPost < 100 && (s.rolling || s.processed < s.length)) return;
  s.lastProgressPost = now;
  let memory = resultMemory();
  let frames = s.runtime.frameCount;
  let annotations = s.runtime.annotationCount;
  let instances: Record<string, { frames: number; annotations: number; resultBytes: number }> | undefined;
  if (s.graph && s.instances) {
    instances = {};
    let annotationBytes = 0,
      frameBytes = 0,
      binaryBytes = 0;
    frames = 0;
    annotations = 0;
    for (const item of s.graph.stats()) {
      const instance = s.instances.get(item.id);
      if (!instance) continue;
      const used = instance.results.memory(s.completed ? { ...item.memory, binaryBytes: 0 } : item.memory);
      instances[item.id] = {
        frames: item.frames,
        annotations: item.annotations,
        resultBytes: used.totalBytes,
      };
      frames += item.frames;
      annotations += item.annotations;
      annotationBytes += used.annotationsBytes;
      frameBytes += used.framesBytes;
      binaryBytes += used.binaryBytes;
    }
    memory = resultMemory(annotationBytes, frameBytes, binaryBytes);
  } else {
    const runtime = s.runtime.memory();
    memory = s.results.memory(s.completed ? { ...runtime, binaryBytes: 0 } : runtime);
  }
  post(s, {
    type: 'decode-progress',
    progress: progress(s),
    frames,
    annotations,
    samples: s.decodedSamples,
    memory,
    ...(instances ? { instances } : {}),
    ...(s.rolling ? { processedSample: s.processed, availableEnd: s.length, availableStart: s.retainedStart } : {}),
  });
}
function start(request: DecodeStartRequest): void {
  if (!Number.isSafeInteger(request.sampleRate) || request.sampleRate < 1 || request.length < 0n)
    throw new Error('Invalid decode stream configuration');
  const compareFrames = decoderWorkerDefinition(request.decoder).compareFrames;
  const s = {
    decoder: request.decoder,
    sampleRate: request.sampleRate,
    length: request.length,
    rolling: request.rolling ?? false,
    retainedStart: request.startSample ?? 0n,
    processed: request.startSample ?? 0n,
    decodedSamples: 0n,
    started: performance.now(),
    channels: request.channels,
    gaps: request.gaps,
    runtime: null as unknown as DecodeRuntime,
    results: new DecodeResultStore(compareFrames ?? ((a, b) => compareSamples(a.ss, b.ss))),
    graph: null,
    instances: null,
    completed: false,
    lastProgressPost: 0,
    sharedTask: null,
    sharedReader: null,
    packedPort: null,
    packedChannels: null,
    packedChannelCount: 0,
    packedNextId: 0,
    packedPending: new Map(),
    workerPort: null,
    workerChannels: null,
    workerNextId: 0,
    workerPending: new Map(),
    finishRequested: false,
    finalLength: request.length,
    stages: {
      sharedUnpackMs: 0,
      decoderPushMs: 0,
      runtimeBatchMs: 0,
      outputPostMs: 0,
      cooperativeYieldMs: 0,
      cooperativeYieldCount: 0,
    },
  } as Session;
  session = s;
  s.runtime = createDecodeRuntime(request, {
    postBatch: (batch) => {
      s.results.append(batch);
      return Promise.resolve();
    },
    postPaged: () => {},
    retain: (start) => s.results.discardBefore(start),
  });
  if (s.rolling && !s.runtime.retain) throw new Error('Decoder does not support a rolling result window');
}
function startGraph(request: DecodeGraphStartRequest): void {
  if (
    !Number.isSafeInteger(request.sampleRate) ||
    request.sampleRate < 1 ||
    request.length < 0n ||
    !request.nodes.length
  )
    throw new Error('Invalid protocol graph configuration');
  const instances = new Map<string, { decoder: DecoderId; results: DecodeResultStore }>();
  for (const node of request.nodes) {
    if (instances.has(node.id)) throw new Error('Duplicate protocol instance: ' + node.id);
    const compareFrames = decoderWorkerDefinition(node.decoder).compareFrames;
    instances.set(node.id, {
      decoder: node.decoder,
      results: new DecodeResultStore(compareFrames ?? ((left, right) => compareSamples(left.ss, right.ss))),
    });
  }
  let graph!: DecodeGraphRuntime;
  const s = {
    decoder: request.nodes[0]!.decoder,
    sampleRate: request.sampleRate,
    length: request.length,
    rolling: request.rolling ?? false,
    retainedStart: request.startSample ?? 0n,
    processed: request.startSample ?? 0n,
    decodedSamples: 0n,
    started: performance.now(),
    channels: request.channels,
    gaps: request.gaps,
    runtime: null as unknown as DecodeRuntime,
    results: new DecodeResultStore((left, right) => compareSamples(left.ss, right.ss)),
    graph: null,
    instances,
    completed: false,
    lastProgressPost: 0,
    sharedTask: null,
    sharedReader: null,
    packedPort: null,
    packedChannels: null,
    packedChannelCount: 0,
    packedNextId: 0,
    packedPending: new Map(),
    workerPort: null,
    workerChannels: null,
    workerNextId: 0,
    workerPending: new Map(),
    finishRequested: false,
    finalLength: request.length,
    stages: {
      sharedUnpackMs: 0,
      decoderPushMs: 0,
      runtimeBatchMs: 0,
      outputPostMs: 0,
      cooperativeYieldMs: 0,
      cooperativeYieldCount: 0,
    },
  } as Session;
  graph = new DecodeGraphRuntime(request.nodes, {
    sampleRate: request.sampleRate,
    paged: request.paged ?? 'auto',
    host: {
      async postBatch(instanceId, batch) {
        const instance = instances.get(instanceId);
        if (!instance) throw new Error('Protocol graph emitted an unknown instance: ' + instanceId);
        instance.results.append(batch);
      },
      postPaged() {},
      retain(instanceId, startSample) {
        const instance = instances.get(instanceId);
        if (!instance) throw new Error('Protocol graph retained an unknown instance: ' + instanceId);
        return instance.results.discardBefore(startSample);
      },
    },
  });
  s.graph = graph;
  s.runtime = {
    get frameCount() {
      return graph.frameCount;
    },
    get annotationCount() {
      return graph.annotationCount;
    },
    memory: () => graph.memory(),
    push: (window, value) => graph.push(window, value),
    flush: (value) => graph.flush(value),
    reset: () => graph.reset(),
    retain: (startSample) => graph.retain(startSample),
    finish: async () => {
      const outputs = await graph.finish(1);
      return {
        binaries: Object.assign({}, ...outputs.map((output) => output.result.binaries)),
        values: {},
        frames: outputs.reduce((sum, output) => sum + output.result.frames, 0),
        annotations: outputs.reduce((sum, output) => sum + output.result.annotations, 0),
        truncated: outputs.some((output) => output.result.truncated),
        binaryTruncated: outputs.some((output) => output.result.binaryTruncated),
      };
    },
  };
  session = s;
}
function queryAnnotations(request: DecodeQueryAnnotationsRequest): void {
  const s = session;
  let annotations: Annotation[] = [];
  if (s) {
    const instance = resolveInstance(s, request.instanceId);
    annotations =
      instance && s.graph
        ? (s.graph.queryAnnotations(instance.id, request.start, request.end, request.maxResults) ??
          instance.results.annotations.query(request.start, request.end, request.maxResults))
        : (s.runtime.queryAnnotations?.(request.start, request.end, request.maxResults) ??
          s.results.annotations.query(request.start, request.end, request.maxResults));
  }
  scope.postMessage({ type: 'decode-query-annotations-result', requestId: request.requestId, annotations });
}
function readFrames(request: DecodeReadFramesRequest): void {
  const s = session;
  const frames = s ? readFrameRange(s, request.offset, request.count, request.instanceId) : [];
  scope.postMessage({ type: 'decode-read-frames-result', requestId: request.requestId, frames });
}
function resolveInstance(
  s: Session,
  instanceId: string | undefined,
): { id: string; decoder: DecoderId; results: DecodeResultStore } | null {
  if (!s.instances) return null;
  const id = instanceId ?? (s.instances.size === 1 ? s.instances.keys().next().value : undefined);
  if (!id) throw new Error('Protocol instance is required');
  const instance = s.instances.get(id);
  if (!instance) throw new Error('Unknown protocol instance: ' + id);
  return { id, ...instance };
}
function readFrameRange(s: Session, offset: number, count: number, instanceId?: string) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 0)
    throw new RangeError('Invalid frame range');
  const instance = resolveInstance(s, instanceId);
  if (instance && s.graph) {
    const total = Math.max(instance.results.length, s.graph.frameCountFor(instance.id));
    const clampedOffset = Math.min(offset, total);
    const clampedCount = Math.min(count, total - clampedOffset);
    return (
      s.graph.readFrames(instance.id, clampedOffset, clampedCount) ??
      instance.results.readFrames(clampedOffset, clampedCount)
    );
  }
  const total = Math.max(s.results.length, s.runtime.frameCount);
  const clampedOffset = Math.min(offset, total);
  const clampedCount = Math.min(count, total - clampedOffset);
  return s.runtime.readFrames?.(clampedOffset, clampedCount) ?? s.results.readFrames(clampedOffset, clampedCount);
}
function readCsv(request: DecodeReadCsvRequest): void {
  const s = session;
  if (!s) {
    scope.postMessage({ type: 'decode-read-csv-result', requestId: request.requestId, csv: '' });
    return;
  }
  const instance = resolveInstance(s, request.instanceId);
  const definition = decoderWorkerDefinition(instance?.decoder ?? s.decoder);
  const frames = readFrameRange(s, request.offset, request.count, instance?.id);
  const origin = request.sampleOffset ?? 0n;
  const rows = frames.map((frame) =>
    definition.csvRow(
      { ...frame, ss: frame.ss - origin, es: frame.es - origin },
      request.sampleRate,
      request.triggerSample,
    ),
  );
  const csv = (request.includeHeader ? definition.csvHeader + '\r\n' : '') + rows.join('\r\n');
  scope.postMessage({ type: 'decode-read-csv-result', requestId: request.requestId, csv });
}
function readBinary(request: Extract<DecodeStreamRequest, { type: 'decode-read-binary' }>): void {
  const instance = session && resolveInstance(session, request.instanceId);
  scope.postMessage({
    type: 'decode-read-binary-result',
    requestId: request.requestId,
    blob: instance ? instance.results.readBinary(request.key) : (session?.results.readBinary(request.key) ?? null),
  });
}
function startShared(s: Session, request: DecodeSharedStartRequest): void {
  if (request.channelCount < 1 || request.channelCount > 32 || ![1, 2, 3, 4].includes(request.bytesPerSample))
    throw new Error('Shared packed capture supports 1..32 logic channels');
  if (s.sharedTask) throw new Error('Shared decode source is already connected');
  const reader = new SharedChunkReader(request.port, request.bytesPerSample);
  s.sharedReader = reader;
  s.sharedTask = consumeShared(s, reader, request.channels, request.bytesPerSample);
}
function startPackedReader(s: Session, request: DecodePackedReaderStartRequest): void {
  if (!Number.isInteger(request.channelCount) || request.channelCount < 1 || request.channelCount > 32)
    throw new Error('Packed capture supports 1..32 logic channels');
  if (s.sharedTask) throw new Error('Decode source is already connected');
  for (const [key, channel] of Object.entries(request.channels)) {
    if (!s.channels.includes(key) || !Number.isInteger(channel) || channel < 0 || channel >= request.channelCount)
      throw new Error('Invalid packed decode channel');
  }
  s.packedPort = request.port;
  s.packedChannels = request.channels;
  s.packedChannelCount = request.channelCount;
  request.port.addEventListener(
    'message',
    ({
      data,
    }: MessageEvent<{ type: 'read-result' | 'read-error'; id: number; data?: Uint8Array; message?: string }>) => {
      const pending = s.packedPending.get(data.id);
      if (!pending) return;
      s.packedPending.delete(data.id);
      if (data.type === 'read-error') pending.reject(new Error(data.message ?? 'Packed sample read failed'));
      else if (data.data instanceof Uint8Array) pending.resolve(data.data);
      else pending.reject(new Error('Packed sample reader returned invalid data'));
    },
  );
  request.port.start();
  s.sharedTask = consumePacked(s);
  void s.sharedTask.catch((error) => {
    for (const pending of s.packedPending.values())
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    s.packedPending.clear();
    s.packedPort?.close();
    s.packedPort = null;
    session = null;
    scope.postMessage({ type: 'error', ...componentFailure(error) });
  });
}
function requestPackedRange(s: Session, startSample: bigint, endSample: bigint): Promise<Uint8Array> {
  const port = s.packedPort;
  if (!port) return Promise.reject(new Error('Packed sample reader is unavailable'));
  const id = s.packedNextId++;
  return new Promise((resolve, reject) => {
    s.packedPending.set(id, { resolve, reject });
    port.postMessage({ type: 'read', id, startSample, endSample, channels: s.packedChannelCount });
  });
}
async function pushPacked(
  s: Session,
  startSample: bigint,
  data: Uint8Array,
  selected: Record<string, number>,
  sampleBytes: number,
): Promise<void> {
  const started = performance.now();
  const samples = data.length / sampleBytes,
    end = startSample + BigInt(samples);
  await s.runtime.push(
    createPackedWindow(startSample, s.sampleRate, data, selected, sampleBytes),
    Number((end * 1000n) / (s.length || 1n)) / 1000,
  );
  await s.runtime.flush(progress(s));
  s.stages.decoderPushMs += performance.now() - started;
  s.decodedSamples += BigInt(samples);
  s.processed = end;
}
async function consumePacked(s: Session): Promise<void> {
  const selected = s.packedChannels!;
  const sampleBytes = Math.ceil(s.packedChannelCount / 8);
  for (let start = 0n; start < s.length;) {
    const end = start + 1_048_576n < s.length ? start + 1_048_576n : s.length;
    const packed = await requestPackedRange(s, start, end);
    await pushPacked(s, start, packed, selected, sampleBytes);
    maybePostProgress(s);
    start = end;
  }
}

function startWorkerReader(s: Session, request: DecodeWorkerReaderStartRequest): void {
  if (s.sharedTask) throw new Error('Decode source is already connected');
  for (const [key, channel] of Object.entries(request.channels)) {
    if (!s.channels.includes(key) || !Number.isInteger(channel) || channel < 0)
      throw new Error('Invalid Worker decode channel');
  }
  s.workerPort = request.port;
  s.workerChannels = request.channels;
  request.port.addEventListener('message', ({ data }: MessageEvent<DecodeReadResponse>) => {
    const pending = s.workerPending.get(data.id);
    if (!pending) return;
    s.workerPending.delete(data.id);
    if (data.type === 'decode-read-error') pending.reject(new Error(data.message));
    else pending.resolve(data);
  });
  request.port.start();
  s.sharedTask = consumeWorkerReader(s, request.edgeInput, request.edgeLimit);
  void s.sharedTask.catch((error) => {
    for (const pending of s.workerPending.values())
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    s.workerPending.clear();
    s.workerPort?.close();
    s.workerPort = null;
    session = null;
    scope.postMessage({ type: 'error', ...componentFailure(error) });
  });
}
function requestWorkerRead(
  s: Session,
  startSample: bigint,
  endSample: bigint,
  edgeInput: string | undefined,
  edgeLimit: number,
): Promise<Extract<DecodeReadResponse, { type: 'decode-read-result' }>> {
  const port = s.workerPort;
  if (!port) return Promise.reject(new Error('Worker sample reader is unavailable'));
  const id = s.workerNextId++;
  return new Promise((resolve, reject) => {
    s.workerPending.set(id, { resolve, reject });
    port.postMessage({
      type: 'decode-read',
      id,
      startSample,
      endSample,
      channels: s.workerChannels!,
      ...(edgeInput === undefined ? {} : { edgeInput }),
      edgeLimit,
    });
  });
}
async function consumeWorkerReader(s: Session, edgeInput: string | undefined, edgeLimit: number): Promise<void> {
  let cursor = s.processed;
  while (true) {
    const limit = s.finishRequested ? s.finalLength : s.length;
    if (cursor >= limit && (!s.rolling || s.finishRequested)) {
      if (s.finishRequested) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      continue;
    }
    const end =
      s.rolling && !s.finishRequested ? cursor + 1_048_576n : cursor + 1_048_576n < limit ? cursor + 1_048_576n : limit;
    const response = await requestWorkerRead(s, cursor, end, edgeInput, edgeLimit);
    if (s.rolling) {
      if (response.availableEnd !== undefined) s.length = response.availableEnd;
      s.retainedStart = response.availableStart ?? 0n;
      s.runtime.retain?.(s.retainedStart);
    }
    if (response.kind === 'wait') {
      if (s.finishRequested && response.availableEnd <= cursor) break;
      maybePostProgress(s);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      continue;
    }
    if (s.rolling && s.decodedSamples === 0n) s.processed = response.startSample;
    if (response.kind === 'edges') {
      if (response.startSample !== s.processed || response.endSample > s.length)
        throw new Error('Decode stream is not contiguous');
      const started = performance.now(),
        value = Number((response.endSample * 1000n) / (s.length || 1n)) / 1000;
      await s.runtime.push(
        createEdgesWindow(response.startSample, response.endSample, response.sampleRate, response.channels),
        value,
      );
      await s.runtime.flush(value);
      s.stages.decoderPushMs += performance.now() - started;
      s.decodedSamples += response.endSample - response.startSample;
      s.processed = response.endSample;
    } else if (response.kind === 'channels') {
      await pushChunk(s, {
        type: 'decode-chunk',
        startSample: response.startSample,
        sampleRate: response.sampleRate,
        channels: response.channels,
      });
    } else {
      await pushEdgeChunk(
        s,
        {
          type: 'decode-edge-chunk',
          startSample: response.startSample,
          endSample: response.endSample,
          parts: response.parts,
        },
        edgeInput,
      );
    }
    cursor = response.endSample;
    if (s.rolling) s.runtime.retain?.(s.retainedStart);
    maybePostProgress(s);
  }
}
async function consumeShared(
  s: Session,
  reader: SharedChunkReader,
  selected: Record<string, number>,
  sampleBytes: number,
): Promise<void> {
  try {
    const picked: Record<string, number> = {};
    for (const channel of s.channels) {
      const bit = selected[channel];
      if (!Number.isInteger(bit) || bit! < 0 || bit! >= sampleBytes * 8)
        throw new Error('Invalid shared decode channel');
      picked[channel] = bit!;
    }
    let lastYield = performance.now();
    while (true) {
      const part = await reader.next(1_048_576);
      if (!part) break;
      await pushPacked(s, part.startSample, part.data, picked, sampleBytes);
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
function gapParts(
  s: Session,
  request: DecodeChunkRequest,
): Array<{ start: bigint; end: bigint; offset: number; reset: boolean }> {
  const start = request.startSample,
    end = start + BigInt(request.channels[s.channels[0]!]?.length ?? 0),
    parts: Array<{ start: bigint; end: bigint; offset: number; reset: boolean }> = [];
  let cursor = start,
    reset = false;
  for (const gap of s.gaps) {
    if (gap.endSample <= cursor || gap.startSample >= end) continue;
    const gapStart = gap.startSample > cursor ? gap.startSample : cursor;
    if (cursor < gapStart) {
      parts.push({ start: cursor, end: gapStart, offset: Number(cursor - start), reset });
      reset = false;
    }
    reset = true;
    cursor = gap.endSample > cursor ? gap.endSample : cursor;
  }
  if (cursor < end) parts.push({ start: cursor, end, offset: Number(cursor - start), reset });
  return parts;
}
function resetAtGap(s: Session): void {
  s.runtime.reset();
}
async function pushChunk(s: Session, request: DecodeChunkRequest): Promise<void> {
  if (request.sampleRate !== s.sampleRate || request.startSample !== s.processed)
    throw new Error('Decode stream is not contiguous');
  const first = s.channels[0],
    count = first ? (request.channels[first]?.length ?? -1) : -1;
  if (count < 0 || s.channels.some((channel) => request.channels[channel]?.length !== count))
    throw new Error('Decode chunk channel layout changed');
  const parts = gapParts(s, request),
    outputWindow = 65_536n,
    yieldWindow = 1_048_576n;
  let yieldSamples = 0n;
  for (const part of parts) {
    if (part.reset) resetAtGap(s);
    for (let cursor = part.start; cursor < part.end;) {
      const end = cursor + outputWindow < part.end ? cursor + outputWindow : part.end;
      const span = end - cursor;
      const offset = part.offset + Number(cursor - part.start),
        channels: Record<string, Uint8Array> = {};
      for (const channel of s.channels)
        channels[channel] = request.channels[channel]!.subarray(offset, offset + Number(end - cursor));
      const decodeStarted = performance.now();
      const value = Number((end * 1000n) / (s.length || 1n)) / 1000;
      await s.runtime.push(createValuesWindow(cursor, s.sampleRate, channels), value);
      await s.runtime.flush(value);
      s.stages.decoderPushMs += performance.now() - decodeStarted;
      s.decodedSamples += span;
      s.processed = end;
      cursor = end;
      yieldSamples += span;
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
  s.processed = request.startSample + BigInt(count);
  maybePostProgress(s);
}
function pushGap(s: Session, request: DecodeGapRequest): void {
  if (request.startSample !== s.processed || request.endSample < request.startSample || request.endSample > s.length)
    throw new Error('Decode gap is not contiguous');
  resetAtGap(s);
  s.processed = request.endSample;
}
async function pushEdgeChunk(s: Session, request: DecodeEdgeChunkRequest, edgeInput = 'data'): Promise<void> {
  if (request.startSample !== s.processed || request.endSample < request.startSample || request.endSample > s.length)
    throw new Error('Decode edge stream is not contiguous');
  let cursor = request.startSample;
  if (!request.parts.length && request.endSample > cursor) resetAtGap(s);
  for (const part of request.parts) {
    if (part.startSample < cursor || part.endSample < part.startSample || part.endSample > request.endSample)
      throw new Error('Invalid edge chunk part');
    if (part.startSample > cursor) resetAtGap(s);
    const value = Number((part.endSample * 1000n) / (s.length || 1n)) / 1000;
    const started = performance.now();
    await s.runtime.push(
      createEdgeWindow(part.startSample, part.endSample, s.sampleRate, part.initial, part.edges, edgeInput),
      value,
    );
    await s.runtime.flush(value);
    s.stages.decoderPushMs += performance.now() - started;
    s.decodedSamples += part.endSample - part.startSample;
    cursor = part.endSample;
  }
  if (cursor < request.endSample) resetAtGap(s);
  s.processed = request.endSample;
  maybePostProgress(s);
}
async function finish(s: Session, request: DecodeFinishRequest): Promise<void> {
  s.finishRequested = true;
  s.finalLength = s.rolling
    ? (request.length ?? s.length)
    : request.length !== undefined && request.length < s.length
      ? request.length
      : s.length;
  if (s.rolling && s.finalLength > s.length) s.length = s.finalLength;
  if (s.sharedTask) await s.sharedTask;
  const output: DecodeRuntimeResult = await s.runtime.finish(1);
  s.results.finish(output.binaries);
  const stages = { ...s.stages };
  s.completed = true;
  s.lastProgressPost = -Infinity;
  maybePostProgress(s);
  const { binaries, ...details } = output;
  const binarySizes = Object.fromEntries(Object.entries(binaries).map(([key, data]) => [key, data.byteLength]));
  const previews = Object.fromEntries(Object.entries(binaries).map(([key, data]) => [key, data.slice(0, 100)]));
  post(s, {
    type: 'done',
    decoder: s.decoder,
    stats: {
      elapsedMs: performance.now() - s.started,
      samples: s.decodedSamples,
      frames: output.frames,
      annotations: output.annotations,
      truncated: output.truncated,
      binaryTruncated: output.binaryTruncated,
      memory: s.results.memory(s.runtime.memory()),
      stages,
      ...(s.rolling ? { processedSample: s.processed, availableEnd: s.length, availableStart: s.retainedStart } : {}),
    },
    result: { ...details, binarySizes, previews },
  });
}
async function finishGraph(s: Session, request: DecodeFinishRequest): Promise<void> {
  const graph = s.graph;
  const stores = s.instances;
  if (!graph || !stores) throw new Error('Protocol graph is unavailable');
  s.finishRequested = true;
  s.finalLength = s.rolling
    ? (request.length ?? s.length)
    : request.length !== undefined && request.length < s.length
      ? request.length
      : s.length;
  if (s.rolling && s.finalLength > s.length) s.length = s.finalLength;
  if (s.sharedTask) await s.sharedTask;
  const outputs = await graph.finish(1);
  const runtimeStats = new Map(graph.stats().map((item) => [item.id, item.memory]));
  const results = outputs.map((output) => {
    const instance = stores.get(output.id);
    if (!instance) throw new Error('Protocol graph results are missing an instance: ' + output.id);
    instance.results.finish(output.result.binaries);
    const { binaries, ...details } = output.result;
    return {
      id: output.id,
      decoder: output.decoder,
      stats: {
        elapsedMs: performance.now() - s.started,
        samples: s.decodedSamples,
        frames: details.frames,
        annotations: details.annotations,
        truncated: details.truncated,
        binaryTruncated: details.binaryTruncated,
        memory: instance.results.memory({
          ...(runtimeStats.get(output.id) ?? resultMemory()),
          binaryBytes: 0,
        }),
        stages: { ...s.stages },
        ...(s.rolling ? { processedSample: s.processed, availableEnd: s.length, availableStart: s.retainedStart } : {}),
      },
      result: {
        ...details,
        binarySizes: Object.fromEntries(Object.entries(binaries).map(([key, data]) => [key, data.byteLength])),
        previews: Object.fromEntries(Object.entries(binaries).map(([key, data]) => [key, data.slice(0, 100)])),
      },
    };
  });
  s.completed = true;
  s.lastProgressPost = -Infinity;
  maybePostProgress(s);
  post(s, { type: 'graph-done', results });
}
async function handle(request: DecodeStreamRequest): Promise<void> {
  if (request.type === 'decode-start') {
    await ensureWorkerDecoder(request.decoder);
    start(request);
    return;
  }
  if (request.type === 'decode-graph-start') {
    await Promise.all(request.nodes.map((node) => ensureWorkerDecoder(node.decoder)));
    startGraph(request);
    return;
  }
  if (request.type === 'decode-query-annotations') {
    queryAnnotations(request);
    return;
  }
  if (request.type === 'decode-read-frames') {
    readFrames(request);
    return;
  }
  if (request.type === 'decode-read-csv') {
    readCsv(request);
    return;
  }
  if (request.type === 'decode-read-binary') {
    readBinary(request);
    return;
  }
  if (!session) throw new Error('Decode chunk received before decoder start');
  if (request.type === 'decode-shared-start') {
    startShared(session, request);
    return;
  }
  if (request.type === 'decode-packed-reader-start') {
    startPackedReader(session, request);
    return;
  }
  if (request.type === 'decode-worker-reader-start') {
    startWorkerReader(session, request);
    return;
  }
  if (request.type === 'decode-chunk') {
    await pushChunk(session, request);
    scope.postMessage({ type: 'decode-ack' });
    return;
  }
  if (request.type === 'decode-gap') {
    pushGap(session, request);
    return;
  }
  if (request.type === 'decode-edge-chunk') {
    await pushEdgeChunk(session, request);
    scope.postMessage({ type: 'decode-ack' });
    return;
  }
  if (request.type !== 'decode-finish') throw new Error('Unexpected decode request');
  if (session.graph) await finishGraph(session, request);
  else await finish(session, request);
}
