import { ProtocolStack } from '../libhakeidecode/stack.js';
import { UARTDecoder } from '../decoders/uart.js';
import { PWMStreamDecoder } from './pwm-edge-decoder.js';
import { createPWMBatchReader } from './pwm-batch.js';
import { PWMFrameStore } from './pwm-frame-store.js';
import { SharedChunkReader, SharedCaptureError } from './shared-chunks.js';
import type { Annotation, DecodeChunkRequest, DecodeEdgeChunkRequest, DecodeFinishRequest, DecodeGapRequest, DecodeMessage, DecodePackedReaderStartRequest, DecodeQueryAnnotationsRequest, DecodeReadFramesRequest, DecodeSharedStartRequest, DecodeStartRequest, DecodeStreamRequest, Frame, UARTFrame, WorkerDecodeMessage } from './protocol.js';

type Scope = {
  onmessage: ((event: MessageEvent<DecodeStreamRequest>) => void) | null;
  postMessage: (message: WorkerDecodeMessage, transfer?: Transferable[]) => void;
};
const scope = globalThis as unknown as Scope;

interface Session {
  decoder: 'uart' | 'pwm';
  sampleRate: number;
  length: bigint;
  processed: bigint;
  decodedSamples: bigint;
  started: number;
  channels: string[];
  gaps: DecodeStartRequest['gaps'];
  stack: ProtocolStack | null;
  pwm: PWMStreamDecoder | null;
  pwmFrames: PWMFrameStore | null;
  pagedOutput: boolean;
  pagedRequested: boolean;
  pagedAutomatic: boolean;
  completed: boolean;
  lastProgressPost: number;
  annotations: Annotation[];
  frames: Frame[];
  bytes: [number[], number[]];
  pending: Array<UARTFrame | null>;
  annotationsCount: number;
  framesCount: number;
  truncated: boolean;
  binaryTruncated: boolean;
  sharedTask: Promise<void> | null;
  sharedReader: SharedChunkReader | null;
  packedPort: MessagePort | null;
  packedChannels: Record<string, number> | null;
  packedChannelCount: number;
  packedNextId: number;
  packedPending: Map<number, { resolve(data: Uint8Array): void; reject(error: Error): void }>;
  outputAck: (() => void) | null;
  stages: { sharedUnpackMs: number; decoderPushMs: number; outputPostMs: number; pwmBatchMs: number; cooperativeYieldMs: number; cooperativeYieldCount: number };
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
  if (event.data.type === 'decode-output-ack') { const current = session, ack = current?.outputAck; if (current) current.outputAck = null; ack?.(); return; }
  if (event.data.type === 'decode-query-annotations') { try { queryAnnotations(event.data); } catch (error) { scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); } return; }
  if (event.data.type === 'decode-read-frames') { try { readFrames(event.data); } catch (error) { scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); } return; }
  queue = queue.then(() => handle(event.data)).catch(error => {
    session = null;
    scope.postMessage({ type: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  });
};

function progress(s: Session): number { return s.length ? Math.min(1, Number(s.processed * 1000n / s.length) / 1000) : 1; }
function appendBytes(s: Session, direction: number, values: unknown): void {
  if (direction < 0 || direction > 1 || !Array.isArray(values) && !(values instanceof Uint8Array)) return;
  const target = s.bytes[direction]!;
  const input = values as ArrayLike<number>;
  for (let index = 0; index < input.length; index++) target.push(Number(input[index]) & 0xff);
}
function addFrame(s: Session, frame: Frame): void {
  s.frames.push(frame); s.framesCount++;
}
function post(s: Session, message: WorkerDecodeMessage, transfer?: Transferable[]): void {
  const started = performance.now(); scope.postMessage(message, transfer); s.stages.outputPostMs += performance.now() - started;
}
function postBatch(s: Session, message: Extract<DecodeMessage, { type: 'batch' }>): Promise<void> {
  return new Promise(resolve => {
    const started = performance.now(); s.outputAck = resolve;
    scope.postMessage(message); s.stages.outputPostMs += performance.now() - started;
  });
}
function handleEvent(s: Session, event: { type: string; ss: bigint; es: bigint; data: unknown }): void {
  if (event.type === 'annotation') {
    const data = event.data as [number, readonly string[]];
    s.annotations.push({ ss: event.ss, es: event.es, classIndex: data[0], texts: data[1] }); s.annotationsCount++;
  } else if (event.type === 'protocol') {
    const packet = event.data as [string, 0 | 1, [number, unknown]];
    if (packet[0] === 'DATA') s.pending[packet[1]] = { protocol: 'uart', ss: event.ss, es: event.es, direction: packet[1], value: packet[2][0], valid: null };
    else if (packet[0] === 'FRAME') { addFrame(s, { protocol: 'uart', ss: event.ss, es: event.es, direction: packet[1], value: packet[2][0], valid: packet[2][1] as boolean | null }); s.pending[packet[1]] = null; }
  } else if (event.type === 'binary') {
    const data = event.data as [number, Uint8Array]; appendBytes(s, data[0], data[1]);
  }
}
function createUARTStack(s: Session, options: DecodeStartRequest['options']): ProtocolStack {
  const decoder = new UARTDecoder(options as ConstructorParameters<typeof UARTDecoder>[0]);
  return new ProtocolStack(decoder, {
    channels: Object.fromEntries(s.channels.map(channel => [channel, channel])),
    collectEvents: false,
    instanceId: 'uart-ui',
    onEvent: event => handleEvent(s, event),
  });
}
function flushPending(s: Session): void {
  for (let direction = 0; direction < s.pending.length; direction++) {
    const frame = s.pending[direction];
    if (frame) addFrame(s, frame);
    s.pending[direction] = null;
  }
}
function resetAtGap(s: Session): void {
  if (s.decoder === 'uart') { flushPending(s); s.stack?.reset(); }
  else s.pwm?.reset();
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

async function handle(request: DecodeStreamRequest): Promise<void> {
  if (request.type === 'decode-output-ack') return;
  if (request.type === 'decode-start') { start(request); return; }
  if (request.type === 'decode-query-annotations') { queryAnnotations(request); return; }
  if (request.type === 'decode-read-frames') { readFrames(request); return; }
  if (!session) throw new Error('Decode chunk received before decoder start');
  if (request.type === 'decode-shared-start') { startShared(session, request); return; }
  if (request.type === 'decode-packed-reader-start') { startPackedReader(session, request); return; }
  if (request.type === 'decode-chunk') { await pushChunk(session, request); scope.postMessage({ type: 'decode-ack' }); return; }
  if (request.type === 'decode-gap') { pushGap(session, request); return; }
  if (request.type === 'decode-edge-chunk') { await pushEdgeChunk(session, request); scope.postMessage({ type: 'decode-ack' }); return; }
  await finish(session, request);
}
function start(request: DecodeStartRequest): void {
  if (!Number.isSafeInteger(request.sampleRate) || request.sampleRate < 1 || request.length < 0n) throw new Error('Invalid decode stream configuration');
  const pwmFrames = request.decoder === 'pwm' ? new PWMFrameStore() : null;
  if (pwmFrames) pwmFrames.setRate(request.sampleRate);
  const s: Session = { decoder: request.decoder, sampleRate: request.sampleRate, length: request.length, processed: 0n, decodedSamples: 0n, started: performance.now(), channels: request.channels, gaps: request.gaps,
    stack: null, pwm: null, pwmFrames, pagedOutput: false, pagedRequested: request.paged === 'always', pagedAutomatic: request.paged === 'auto', completed: false, lastProgressPost: 0, annotations: [], frames: [], bytes: [[], []], pending: [null, null], annotationsCount: 0, framesCount: 0, truncated: false, binaryTruncated: false, sharedTask: null, sharedReader: null, packedPort: null, packedChannels: null, packedChannelCount: 0, packedNextId: 0, packedPending: new Map(), outputAck: null,
    stages: { sharedUnpackMs: 0, decoderPushMs: 0, outputPostMs: 0, pwmBatchMs: 0, cooperativeYieldMs: 0, cooperativeYieldCount: 0 } };
  session = s;
  if (request.decoder === 'uart') s.stack = createUARTStack(s, request.options);
  else {
    const restore = createPWMBatchReader(request.sampleRate);
    s.pwm = new PWMStreamDecoder(request.sampleRate, request.options as Partial<import('../decoders/pwm.js').PWMOptions>, message => {
      const started = performance.now();
      s.pwmFrames!.append(message.cycles, message.averages);
      s.framesCount = s.pwmFrames!.length; s.annotationsCount = s.framesCount * 3;
      if (!s.pagedRequested && !s.pagedOutput && (!s.pagedAutomatic || s.framesCount <= 16_384)) {
        const batch = restore(message); s.stages.pwmBatchMs += performance.now() - started;
        return postBatch(s, batch);
      }
      if (!s.pagedOutput) {
        s.pagedOutput = true; post(s, { type: 'decode-output-mode', mode: 'paged', frames: s.framesCount, annotations: s.annotationsCount, resultBytes: s.pwmFrames!.reservedBytes + s.pwm!.rawBytes });
      }
      s.stages.pwmBatchMs += performance.now() - started;
    });
  }
}
function queryAnnotations(request: DecodeQueryAnnotationsRequest): void {
  const s = session;
  if (!s?.pwmFrames || !s.pagedOutput) { scope.postMessage({ type: 'decode-query-annotations-result', requestId: request.requestId, annotations: [] }); return; }
  const annotations = s.pwmFrames.queryAnnotations(request.start, request.end, request.maxResults, s.sampleRate);
  scope.postMessage({ type: 'decode-query-annotations-result', requestId: request.requestId, annotations });
}
function readFrames(request: DecodeReadFramesRequest): void {
  const s = session;
  if (!s?.pwmFrames) { scope.postMessage({ type: 'decode-read-frames-result', requestId: request.requestId, frames: [] }); return; }
  const frames = s.pwmFrames.readFrames(request.offset, request.count, s.sampleRate);
  scope.postMessage({ type: 'decode-read-frames-result', requestId: request.requestId, frames });
}
function maybePostProgress(s: Session): void {
  const now = performance.now();
  if (now - s.lastProgressPost < 100 && s.processed < s.length) return;
  s.lastProgressPost = now;
  post(s, { type: 'decode-progress', progress: progress(s), frames: s.framesCount, annotations: s.annotationsCount, samples: s.decodedSamples,
    resultBytes: (s.pwmFrames?.reservedBytes ?? 0) + (s.pwm?.rawBytes ?? 0) });
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
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
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
async function consumePacked(s: Session): Promise<void> {
  const selected = s.packedChannels!;
  for (let start = 0n; start < s.length;) {
    const end = start + 1_048_576n < s.length ? start + 1_048_576n : s.length;
    const packed = await requestPackedRange(s, start, end), channels: Record<string, Uint8Array> = {};
    for (const key of s.channels) {
      const bit = selected[key]; if (bit === undefined) throw new Error(`Missing packed mapping for ${key}`);
      const values = new Uint8Array(packed.length);
      for (let index = 0; index < packed.length; index++) values[index] = (packed[index]! >>> bit) & 1;
      channels[key] = values;
    }
    await pushChunk(s, { type: 'decode-chunk', startSample: start, sampleRate: s.sampleRate, channels });
    start = end;
  }
}

async function consumeShared(s: Session, reader: SharedChunkReader, selected: Record<string, number>): Promise<void> {
  try {
    const directPacked = s.decoder === 'pwm' && s.channels.length === 1;
    const directKey = directPacked ? s.channels[0]! : '', directBit = directPacked ? selected[directKey] : undefined;
    if (directPacked && (!Number.isInteger(directBit) || directBit! < 0 || directBit! > 7)) throw new Error('Invalid shared PWM channel');
    let lastYield = performance.now();
    while (true) {
      const part = await reader.next(1_048_576);
      if (!part) break;
      if (directPacked) {
        const started = performance.now();
        const endSample = part.startSample + BigInt(part.sampleCount);
        await s.pwm!.pushPacked(part.startSample, part.data, directBit!, Number(endSample * 1000n / (s.length || 1n)) / 1000);
        s.stages.decoderPushMs += performance.now() - started;
        s.decodedSamples += BigInt(part.sampleCount); s.processed = endSample; maybePostProgress(s);
        if (performance.now() - lastYield >= 8) {
          const yieldStarted = performance.now();
          await yieldWorkerTask();
          s.stages.cooperativeYieldMs += performance.now() - yieldStarted;
          s.stages.cooperativeYieldCount++;
          lastYield = performance.now();
        }
        continue;
      }
      const unpackStarted = performance.now();
      const channels: Record<string, Uint8Array> = {};
      for (const [key, channel] of Object.entries(selected)) {
        if (!Number.isInteger(channel) || channel < 0 || channel > 7) throw new Error('Invalid shared decode channel');
        const values = new Uint8Array(part.sampleCount);
        for (let index = 0; index < part.sampleCount; index++) values[index] = (part.data[index]! >>> channel) & 1;
        channels[key] = values;
      }
      s.stages.sharedUnpackMs += performance.now() - unpackStarted;
      await pushChunk(s, { type: 'decode-chunk', startSample: part.startSample, sampleRate: s.sampleRate, channels });
    }
  } catch (error) {
    if (!(error instanceof SharedCaptureError)) throw error;
  } finally {
    reader.close();
  }
}

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
      if (s.decoder === 'uart') s.stack!.push({ startSample: cursor, sampleRate: s.sampleRate, channels });
      else await s.pwm!.push(cursor, channels[s.channels[0]!]!, Number(end * 1000n / (s.length || 1n)) / 1000);
      s.stages.decoderPushMs += performance.now() - decodeStarted;
      s.decodedSamples += span; s.processed = end; cursor = end; yieldSamples += span;
      maybePostProgress(s);
      if (s.decoder === 'uart') {
        if (s.annotations.length || s.frames.length) await postBatch(s, { type: 'batch', progress: progress(s), annotations: s.annotations, frames: s.frames });
        s.annotations = []; s.frames = [];
      } else await s.pwm!.flush(progress(s));
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
  if (s.decoder !== 'pwm') throw new Error('Edge chunks require PWM decoding');
  if (request.startSample !== s.processed || request.endSample < request.startSample || request.endSample > s.length) throw new Error('Decode edge stream is not contiguous');
  let cursor = request.startSample;
  if (!request.parts.length && request.endSample > cursor) resetAtGap(s);
  for (const part of request.parts) {
    if (part.startSample < cursor || part.endSample < part.startSample || part.endSample > request.endSample) throw new Error('Invalid edge chunk part');
    if (part.startSample > cursor) resetAtGap(s);
    await s.pwm!.pushEdges(part.startSample, part.initial, part.edges, Number(part.endSample * 1000n / (s.length || 1n)) / 1000);
    s.decodedSamples += part.endSample - part.startSample; cursor = part.endSample;
  }
  if (cursor < request.endSample) resetAtGap(s);
  s.processed = request.endSample; await s.pwm!.flush(progress(s)); maybePostProgress(s);
}
async function finish(s: Session, _request: DecodeFinishRequest): Promise<void> {
  if (s.sharedTask) await s.sharedTask;
  if (s.decoder === 'uart') { s.stack?.finish(); flushPending(s); }
  else await s.pwm!.flush(1);
  if (s.decoder === 'uart' && (s.annotations.length || s.frames.length)) { await postBatch(s, { type: 'batch', progress: 1, annotations: s.annotations, frames: s.frames }); s.annotations = []; s.frames = []; }
  const output = s.decoder === 'pwm' ? s.pwm!.result() : { rx: Uint8Array.from(s.bytes[0]), tx: Uint8Array.from(s.bytes[1]), pwm: new Uint8Array(), pwmAverage: null, frames: s.framesCount, annotations: s.annotationsCount, truncated: s.truncated, binaryTruncated: s.binaryTruncated };
  const stages = { ...s.stages };
  if (s.decoder === 'pwm' && !s.pagedOutput) s.pwmFrames?.clear();
  if (s.decoder === 'pwm') maybePostProgress(s);
  s.completed = true;
  post(s, { type: 'done', decoder: s.decoder, stats: { elapsedMs: performance.now() - s.started, samples: s.decodedSamples, frames: output.frames, annotations: output.annotations, truncated: output.truncated, binaryTruncated: output.binaryTruncated, stages }, rx: output.rx, tx: output.tx, pwm: output.pwm, pwmAverage: output.pwmAverage }, [output.rx.buffer, output.tx.buffer, output.pwm.buffer]);
}
