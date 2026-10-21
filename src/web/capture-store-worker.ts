import { serializeSR } from './sr.js';
import type { Capture } from './capture.js';
import { SharedCaptureError, SharedChunkReader, SHARED_SUMMARY_GROUP_SAMPLES } from './shared-chunks.js';

type Scope = {
  onmessage: ((event: MessageEvent<StorageRequest>) => void) | null;
  postMessage(message: StorageResponse, transfer?: Transferable[]): void;
};
const scope = globalThis as unknown as Scope;
const PAGE_GROUPS = 65_536;
const RECORD_BYTES = 4;

type StorageRequest =
  | { type: 'start'; port: MessagePort; channelCount: number; sampleRate: number; labels?: readonly string[] }
  | { type: 'query'; id: number; channel: number; startSample: bigint; endSample: bigint; bins: number }
  | { type: 'edges'; id: number; channel: number; startSample: bigint; endSample: bigint }
  | { type: 'pack'; id: number; startSample: bigint; endSample: bigint; channels: number }
  | { type: 'reader'; port: MessagePort }
  | { type: 'export-sr'; id: number; workspace?: import('./workspace.js').WorkspaceSettings; triggerSample: bigint; acquisition?: import('./capture.js').AcquisitionResult }
  | { type: 'cancel-export'; id: number }
  | { type: 'finish' };
type StorageMetrics = { readerWaitMs: number; summaryMs: number; processCalls: number; queryMs: number; queryCalls: number; edgeMs: number; edgeCalls: number; packMs: number; packCalls: number; samples: bigint; groups: number };
type StorageResponse =
  | { type: 'progress'; length: bigint; groups: number; summaryBytes: number }
  | { type: 'query-result'; id: number; channel: number; startSample: bigint; endSample: bigint; bins: number; low: Uint8Array; high: Uint8Array; edge: Uint8Array; packed: Uint8Array }
  | { type: 'edges-result'; id: number; channel: number; startSample: bigint; endSample: bigint; edges: bigint[] }
  | { type: 'pack-result'; id: number; data: Uint8Array }
  | { type: 'export-sr-result'; id: number; blob: Blob }
  | { type: 'done'; state: 'complete' | 'stopped' | 'error'; length: bigint; error?: string; summaryBytes: number; metrics: StorageMetrics }
  | { type: 'error'; id?: number; message: string };

type SummaryPage = { buffer: SharedArrayBuffer; view: Uint8Array };
type StorageSession = {
  reader: SharedChunkReader;
  channelCount: number;
  sampleRate: number;
  labels: string[];
  length: bigint;
  completeGroups: number;
  groupCount: number;
  ones: number;
  zeros: number;
  first: number;
  last: number;
  pages: Map<number, SummaryPage>;
  summaryBytes: number;
  lastProgressAt: number;
  reportedLength: bigint;
  consumeDone: Promise<void>;
  state: 'open' | 'complete' | 'stopped' | 'error';
  error?: string;
  readerWaitMs: number;
  summaryMs: number;
  processCalls: number;
  queryMs: number;
  queryCalls: number;
  edgeMs: number;
  edgeCalls: number;
  packMs: number;
  packCalls: number;
};
let session: StorageSession | null = null;
let finishing: Promise<void> | null = null;
const exportControllers = new Map<number, AbortController>();

function maskFor(channel: number): number { return 1 << channel; }
function pageFor(s: StorageSession, group: number): Uint8Array {
  const pageIndex = Math.floor(group / PAGE_GROUPS), existing = s.pages.get(pageIndex);
  if (existing) return existing.view;
  const buffer = new SharedArrayBuffer(PAGE_GROUPS * RECORD_BYTES), view = new Uint8Array(buffer);
  s.pages.set(pageIndex, { buffer, view }); s.summaryBytes += buffer.byteLength;
  return view;
}
function foldedBytes(value: number): number { return (value | value >>> 8 | value >>> 16 | value >>> 24) & 0xff; }
function writeRecord(s: StorageSession, group: number): void {
  const page = pageFor(s, group), offset = (group % PAGE_GROUPS) * RECORD_BYTES;
  page[offset] = foldedBytes(s.ones); page[offset + 1] = foldedBytes(s.zeros);
  page[offset + 2] = s.first & 0xff; page[offset + 3] = s.last & 0xff;
}
function groupCount(s: StorageSession): number { return s.groupCount ? s.completeGroups + 1 : s.completeGroups; }
function report(s: StorageSession, force = false): void {
  const now = performance.now();
  if (force || s.length > 0n && s.reportedLength === 0n || now - s.lastProgressAt >= 100) {
    s.lastProgressAt = now; s.reportedLength = s.length;
    scope.postMessage({ type: 'progress', length: s.length, groups: groupCount(s), summaryBytes: s.summaryBytes });
  }
}
function processPart(s: StorageSession, data: Uint8Array): void {
  const packed = data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2) : null;
  for (let offset = 0; offset < data.length;) {
    const count = Math.min(data.length - offset, SHARED_SUMMARY_GROUP_SAMPLES - s.groupCount);
    if (!s.groupCount) { s.first = data[offset]!; s.ones = 0; s.zeros = 0; }
    const end = offset + count;
    while (offset < end && ((offset & 3) !== 0 || (s.groupCount & 3) !== 0)) {
      const value = data[offset++]!;
      s.ones |= value; s.zeros |= (~value) & 0xff; s.last = value; s.groupCount++;
    }
    const words = packed ? (end - offset) >> 2 : 0;
    if (words) {
      let index = offset >> 2;
      const wordEnd = index + words;
      for (; index < wordEnd; index++) { const value = packed![index]!; s.ones |= value; s.zeros |= ~value; }
      const bytes = words * 4; offset += bytes; s.groupCount += bytes; s.last = data[offset - 1]!;
    }
    while (offset < end) {
      const value = data[offset++]!;
      s.ones |= value; s.zeros |= (~value) & 0xff; s.last = value; s.groupCount++;
    }
    if (s.groupCount === SHARED_SUMMARY_GROUP_SAMPLES) {
      writeRecord(s, s.completeGroups++); s.groupCount = 0;
    }
  }
  s.length += BigInt(data.length);
  if (s.groupCount) writeRecord(s, s.completeGroups);
  report(s);
}
function recordAt(s: StorageSession, group: number): [number, number, number, number] | null {
  const page = s.pages.get(Math.floor(group / PAGE_GROUPS));
  if (!page) return null;
  const offset = (group % PAGE_GROUPS) * RECORD_BYTES;
  return [page.view[offset]!, page.view[offset + 1]!, page.view[offset + 2]!, page.view[offset + 3]!];
}
function sampleAt(s: StorageSession, position: bigint): number {
  const value = s.reader.readByte(position);
  if (value === null) throw new Error(`Shared sample ${position} is not committed`);
  return value;
}
function rangeState(s: StorageSession, channel: number, start: bigint, end: bigint): { low: number; high: number; edge: number } {
  const bit = maskFor(channel); let low = 1, high = 0, edge = 0;
  let position = start, previous = start > 0n ? (sampleAt(s, start - 1n) & bit ? 1 : 0) : 0;
  const add = (value: number): void => {
    const level = value & bit ? 1 : 0;
    if (level) high = 1; else low = 0;
    if (level !== previous) edge = 1;
    previous = level;
  };
  while (position < end && position % BigInt(SHARED_SUMMARY_GROUP_SAMPLES) !== 0n) add(sampleAt(s, position++));
  while (position + BigInt(SHARED_SUMMARY_GROUP_SAMPLES) <= end) {
    const group = Number(position / BigInt(SHARED_SUMMARY_GROUP_SAMPLES)), record = recordAt(s, group);
    if (!record || BigInt(group + 1) * BigInt(SHARED_SUMMARY_GROUP_SAMPLES) > s.length) {
      add(sampleAt(s, position++)); continue;
    }
    const ones = (record[0] & bit) !== 0, zeros = (record[1] & bit) !== 0, first = (record[2] & bit) !== 0 ? 1 : 0;
    if (first !== previous) edge = 1;
    if (ones) high = 1; if (zeros) low = 0; if (ones && zeros) edge = 1;
    previous = (record[3] & bit) !== 0 ? 1 : 0; position += BigInt(SHARED_SUMMARY_GROUP_SAMPLES);
  }
  while (position < end) add(sampleAt(s, position++));
  return { low, high, edge };
}
function answerQuery(s: StorageSession, request: Extract<StorageRequest, { type: 'query' }>): void {
  const started = performance.now(); s.queryCalls++;
  if (!Number.isInteger(request.channel) || request.channel < 0 || request.channel >= s.channelCount) throw new RangeError('channel out of range');
  if (!Number.isSafeInteger(request.bins) || request.bins < 1) throw new RangeError('bins must be positive');
  const start = request.startSample < 0n ? 0n : request.startSample;
  const end = request.endSample > s.length ? s.length : request.endSample;
  const low = new Uint8Array(request.bins), high = new Uint8Array(request.bins), edge = new Uint8Array(request.bins), packed = new Uint8Array(request.bins);
  if (start < end) {
    const width = end - start, divisor = BigInt(request.bins);
    for (let index = 0; index < request.bins; index++) {
      const a = start + width * BigInt(index) / divisor;
      const b = index + 1 === request.bins ? end : start + width * BigInt(index + 1) / divisor;
      const queryEnd = b > a ? b : a < end ? a + 1n : end;
      if (a >= queryEnd) continue;
      const state = rangeState(s, request.channel, a, queryEnd);
      low[index] = state.low; high[index] = state.high; edge[index] = state.edge;
      packed[index] = state.high | (state.low << 1) | (state.edge << 2);
    }
  }
  scope.postMessage({ type: 'query-result', id: request.id, channel: request.channel, startSample: start, endSample: end, bins: request.bins, low, high, edge, packed }, [low.buffer, high.buffer, edge.buffer, packed.buffer]);
  s.queryMs += performance.now() - started;
}
function answerPack(s: StorageSession, request: Extract<StorageRequest, { type: 'pack' }>): void {
  const started = performance.now(); s.packCalls++;
  if (!Number.isInteger(request.channels) || request.channels < 1 || request.channels > s.channelCount) throw new RangeError('channel count out of range');
  const raw = s.reader.readRange(request.startSample, request.endSample);
  if (!raw) throw new Error('Requested capture range is not committed');
  const mask = (1 << request.channels) - 1;
  if (mask !== 0xff) for (let index = 0; index < raw.length; index++) raw[index] &= mask;
  scope.postMessage({ type: 'pack-result', id: request.id, data: raw }, [raw.buffer]);
  s.packMs += performance.now() - started;
}
function answerEdges(s: StorageSession, request: Extract<StorageRequest, { type: 'edges' }>): void {
  const started = performance.now(); s.edgeCalls++;
  const start = request.startSample < 1n ? 1n : request.startSample, end = request.endSample > s.length ? s.length : request.endSample;
  const bit = maskFor(request.channel), output: bigint[] = [];
  if (start < end) {
    let previous = sampleAt(s, start - 1n) & bit;
    const CHUNK = 262_144n;
    for (let position = start; position < end;) {
      const chunkEnd = position + CHUNK > end ? end : position + CHUNK;
      const chunk = s.reader.readRange(position, chunkEnd);
      if (!chunk || chunk.length !== Number(chunkEnd - position)) throw new Error('Requested capture range is not committed');
      for (let index = 0; index < chunk.length; index++) {
        const value = chunk[index]! & bit;
        if (value !== previous) output.push(position + BigInt(index));
        previous = value;
      }
      position = chunkEnd;
    }
  }
  scope.postMessage({ type: 'edges-result', id: request.id, channel: request.channel, startSample: start, endSample: end, edges: output });
  s.edgeMs += performance.now() - started;
}
async function consume(s: StorageSession): Promise<void> {
  try {
    while (true) {
      const waitStarted = performance.now();
      const part = await s.reader.next(1_048_576);
      s.readerWaitMs += performance.now() - waitStarted;
      if (!part) { s.state = 'complete'; break; }
      const processStarted = performance.now();
      processPart(s, part.data);
      s.summaryMs += performance.now() - processStarted; s.processCalls++;
    }
  } catch (error) {
    if (error instanceof SharedCaptureError) { s.state = error.captureState; s.error = error.message; }
    else { s.state = 'error'; s.error = error instanceof Error ? error.message : String(error); }
  } finally {
    report(s, true);
    scope.postMessage({ type: 'done', state: s.state === 'open' ? 'error' : s.state, length: s.length, ...(s.error ? { error: s.error } : {}), summaryBytes: s.summaryBytes, metrics: { readerWaitMs: s.readerWaitMs, summaryMs: s.summaryMs, processCalls: s.processCalls, queryMs: s.queryMs, queryCalls: s.queryCalls, edgeMs: s.edgeMs, edgeCalls: s.edgeCalls, packMs: s.packMs, packCalls: s.packCalls, samples: s.length, groups: groupCount(s) } });
  }
}

function connectPackedReader(s: StorageSession, port: MessagePort): void {
  port.addEventListener('message', ({ data }: MessageEvent<{ type: 'read'; id: number; startSample: bigint; endSample: bigint; channels: number }>) => {
    try {
      if (data?.type !== 'read' || !Number.isSafeInteger(data.id)) return;
      if (!Number.isInteger(data.channels) || data.channels < 1 || data.channels > s.channelCount) throw new RangeError('channel count out of range');
      const raw = s.reader.readRange(data.startSample, data.endSample);
      if (!raw) throw new Error('Requested capture range is not committed');
      const mask = (1 << data.channels) - 1;
      if (mask !== 0xff) for (let index = 0; index < raw.length; index++) raw[index] &= mask;
      port.postMessage({ type: 'read-result', id: data.id, data: raw }, [raw.buffer]);
    } catch (error) {
      port.postMessage({ type: 'read-error', id: data?.id, message: error instanceof Error ? error.message : String(error) });
    }
  });
  port.start();
}

async function handle(request: StorageRequest): Promise<void> {
  if (request.type === 'start') {
    if (session) throw new Error('Storage Worker already started');
    if (!Number.isInteger(request.channelCount) || request.channelCount < 1 || request.channelCount > 8 || !Number.isSafeInteger(request.sampleRate) || request.sampleRate < 1) throw new Error('Invalid shared storage configuration');
    const labels = request.labels ? [...request.labels] : Array.from({ length: request.channelCount }, (_, index) => 'D' + index);
    if (labels.length !== request.channelCount || labels.some(label => typeof label !== 'string')) throw new Error('Invalid shared channel labels');
    const reader = new SharedChunkReader(request.port);
    const created: StorageSession = { reader, channelCount: request.channelCount, sampleRate: request.sampleRate, labels, length: 0n, completeGroups: 0, groupCount: 0, ones: 0, zeros: 0, first: 0, last: 0, pages: new Map(), summaryBytes: 0, lastProgressAt: -Infinity, consumeDone: Promise.resolve(), state: 'open', reportedLength: 0n, readerWaitMs: 0, summaryMs: 0, processCalls: 0, queryMs: 0, queryCalls: 0, edgeMs: 0, edgeCalls: 0, packMs: 0, packCalls: 0 };
    session = created;
    created.consumeDone = consume(created); return;
  }
  if (request.type === 'cancel-export') { exportControllers.get(request.id)?.abort(); return; }
  if (!session) throw new Error('Storage Worker is not started');
  if (request.type === 'reader') { connectPackedReader(session, request.port); return; }
  if (request.type === 'query') { answerQuery(session, request); return; }
  if (request.type === 'edges') { answerEdges(session, request); return; }
  if (request.type === 'pack') { answerPack(session, request); return; }
  if (request.type === 'export-sr') { await exportSR(session, request); return; }
  if (!finishing) finishing = session.consumeDone;
  await finishing;
}
async function exportSR(s: StorageSession, request: Extract<StorageRequest, { type: 'export-sr' }>): Promise<void> {
  const controller = new AbortController();
  exportControllers.set(request.id, controller);
  const length = s.length;
  const store = {
    channelCount: s.channelCount,
    samplerate: s.sampleRate,
    length,
    gaps: () => [],
    readPackedRange: async (startSample: bigint, endSample: bigint, channels = s.channelCount): Promise<Uint8Array> => {
      const raw = s.reader.readRange(startSample, endSample);
      if (!raw) throw new Error('Requested capture range is not committed');
      const mask = (1 << channels) - 1;
      if (mask !== 0xff) for (let index = 0; index < raw.length; index++) raw[index] &= mask;
      return raw;
    },
  };
  const capture = {
    name: 'capture.sr', store: store as unknown as Capture['store'], labels: [...s.labels], triggerSample: request.triggerSample,
    loadedMs: 0, logicChannelCount: s.channelCount, analogChannels: [],
    ...(request.acquisition ? { acquisition: request.acquisition } : {}),
  } as Capture;
  try {
    const blob = await serializeSR(capture, request.workspace, undefined, controller.signal);
    if (!controller.signal.aborted) scope.postMessage({ type: 'export-sr-result', id: request.id, blob });
  } finally {
    exportControllers.delete(request.id);
  }
}
scope.onmessage = event => { void handle(event.data).catch(error => scope.postMessage({ type: 'error', ...(typeof (event.data as { id?: number }).id === 'number' ? { id: (event.data as { id: number }).id } : {}), message: error instanceof Error ? error.message : String(error) })); };
