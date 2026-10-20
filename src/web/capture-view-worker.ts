import { SharedCaptureError, SharedChunkReader, SHARED_SUMMARY_GROUP_SAMPLES } from './shared-chunks.js';

type Scope = {
  onmessage: ((event: MessageEvent<ViewRequest>) => void) | null;
  postMessage(message: ViewResponse, transfer?: Transferable[]): void;
};
const scope = globalThis as unknown as Scope;
const PAGE_GROUPS = 65_536;
const RECORD_BYTES = 4;

type ViewRequest =
  | { type: 'start'; port: MessagePort; channelCount: number }
  | { type: 'query'; id: number; channel: number; startSample: bigint; endSample: bigint; bins: number }
  | { type: 'edges'; id: number; channel: number; startSample: bigint; endSample: bigint }
  | { type: 'finish' };
type ViewResponse =
  | { type: 'progress'; length: bigint; summaryBytes: number }
  | { type: 'query-result'; id: number; channel: number; startSample: bigint; endSample: bigint; bins: number; low: Uint8Array; high: Uint8Array; edge: Uint8Array; packed: Uint8Array }
  | { type: 'edges-result'; id: number; channel: number; startSample: bigint; endSample: bigint; edges: bigint[] }
  | { type: 'done'; state: 'complete' | 'stopped' | 'error'; length: bigint; error?: string; summaryBytes: number }
  | { type: 'error'; message: string };

type SummaryPage = { buffer: ArrayBuffer; view: Uint8Array };
type ViewSession = {
  reader: SharedChunkReader;
  channelCount: number;
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
};
let session: ViewSession | null = null;
let finishing: Promise<void> | null = null;
const taskYieldChannel = new MessageChannel();
let taskYieldResolve: (() => void) | null = null;
taskYieldChannel.port1.onmessage = () => { const resolve = taskYieldResolve; taskYieldResolve = null; resolve?.(); };
function yieldWorkerTask(): Promise<void> { return new Promise(resolve => { taskYieldResolve = resolve; taskYieldChannel.port2.postMessage(0); }); }

function maskFor(channel: number): number { return 1 << channel; }
function pageFor(s: ViewSession, group: number): Uint8Array {
  const pageIndex = Math.floor(group / PAGE_GROUPS), existing = s.pages.get(pageIndex);
  if (existing) return existing.view;
  const buffer = new ArrayBuffer(PAGE_GROUPS * RECORD_BYTES), view = new Uint8Array(buffer);
  s.pages.set(pageIndex, { buffer, view }); s.summaryBytes += buffer.byteLength;
  return view;
}
function foldedBytes(value: number): number { return (value | value >>> 8 | value >>> 16 | value >>> 24) & 0xff; }
function writeRecord(s: ViewSession, group: number): void {
  const page = pageFor(s, group), offset = (group % PAGE_GROUPS) * RECORD_BYTES;
  page[offset] = foldedBytes(s.ones); page[offset + 1] = foldedBytes(s.zeros);
  page[offset + 2] = s.first & 0xff; page[offset + 3] = s.last & 0xff;
}
function report(s: ViewSession, force = false): void {
  const now = performance.now();
  if (force || s.length > 0n && s.reportedLength === 0n || now - s.lastProgressAt >= 100) {
    s.lastProgressAt = now; s.reportedLength = s.length;
    scope.postMessage({ type: 'progress', length: s.length, summaryBytes: s.summaryBytes });
  }
}
function processPart(s: ViewSession, data: Uint8Array): void {
  const packed = data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2) : null;
  for (let offset = 0; offset < data.length;) {
    const count = Math.min(data.length - offset, SHARED_SUMMARY_GROUP_SAMPLES - s.groupCount);
    if (!s.groupCount) { s.first = data[offset]!; s.ones = 0; s.zeros = 0; }
    const end = offset + count;
    while (offset < end && packed && (offset & 3) !== 0) {
      const value = data[offset++]!;
      s.ones |= value; s.zeros |= (~value) & 0xff; s.last = value; s.groupCount++;
    }
    const words = packed ? Math.floor((end - offset) / 4) : 0;
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
function recordAt(s: ViewSession, group: number): [number, number, number, number] | null {
  const page = s.pages.get(Math.floor(group / PAGE_GROUPS));
  if (!page) return null;
  const offset = (group % PAGE_GROUPS) * RECORD_BYTES;
  return [page.view[offset]!, page.view[offset + 1]!, page.view[offset + 2]!, page.view[offset + 3]!];
}
function sampleAt(s: ViewSession, position: bigint): number {
  const value = s.reader.readByte(position);
  if (value === null) throw new Error(`Shared sample ${position} is not committed`);
  return value;
}
function rangeState(s: ViewSession, channel: number, start: bigint, end: bigint): { low: number; high: number; edge: number } {
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
function answerQuery(s: ViewSession, request: Extract<ViewRequest, { type: 'query' }>): void {
  if (!Number.isInteger(request.channel) || request.channel < 0 || request.channel >= s.channelCount) throw new RangeError('channel out of range');
  if (!Number.isSafeInteger(request.bins) || request.bins < 1) throw new RangeError('bins must be positive');
  const start = request.startSample < 0n ? 0n : request.startSample;
  const end = request.endSample > start ? request.endSample : start;
  const availableEnd = end > s.length ? s.length : end;
  const low = new Uint8Array(request.bins).fill(1), high = new Uint8Array(request.bins), edge = new Uint8Array(request.bins), packed = new Uint8Array(request.bins).fill(2);
  if (start < availableEnd) {
    const width = end - start, divisor = BigInt(request.bins);
    for (let index = 0; index < request.bins; index++) {
      const a = start + width * BigInt(index) / divisor;
      const b = index + 1 === request.bins ? end : start + width * BigInt(index + 1) / divisor;
      if (a >= availableEnd) continue;
      const boundedB = b > availableEnd ? availableEnd : b;
      const queryEnd = boundedB > a ? boundedB : a + 1n;
      const state = rangeState(s, request.channel, a, queryEnd);
      low[index] = state.low; high[index] = state.high; edge[index] = state.edge;
      packed[index] = state.high | (state.low << 1) | (state.edge << 2);
    }
  }
  const resultEnd = availableEnd > start ? availableEnd : start;
  scope.postMessage({ type: 'query-result', id: request.id, channel: request.channel, startSample: start, endSample: resultEnd, bins: request.bins, low, high, edge, packed }, [low.buffer, high.buffer, edge.buffer, packed.buffer]);
}
function answerEdges(s: ViewSession, request: Extract<ViewRequest, { type: 'edges' }>): void {
  const start = request.startSample < 1n ? 1n : request.startSample, end = request.endSample > s.length ? s.length : request.endSample;
  if (!Number.isInteger(request.channel) || request.channel < 0 || request.channel >= s.channelCount) throw new RangeError('channel out of range');
  const bit = maskFor(request.channel), output: bigint[] = [];
  if (start < end) {
    let previous = sampleAt(s, start - 1n) & bit;
    for (let position = start; position < end; position++) {
      const value = sampleAt(s, position) & bit;
      if (value !== previous) output.push(position);
      previous = value;
    }
  }
  scope.postMessage({ type: 'edges-result', id: request.id, channel: request.channel, startSample: start, endSample: end, edges: output });
}
async function consume(s: ViewSession): Promise<void> {
  try {
    while (true) {
      const part = await s.reader.next(1_048_576);
      if (!part) { s.state = 'complete'; break; }
      processPart(s, part.data);
      await yieldWorkerTask();
    }
  } catch (error) {
    if (error instanceof SharedCaptureError) { s.state = error.captureState; s.error = error.message; }
    else { s.state = 'error'; s.error = error instanceof Error ? error.message : String(error); }
  } finally {
    report(s, true);
    scope.postMessage({ type: 'done', state: s.state === 'open' ? 'error' : s.state, length: s.length, ...(s.error ? { error: s.error } : {}), summaryBytes: s.summaryBytes });
  }
}
async function handle(request: ViewRequest): Promise<void> {
  if (request.type === 'start') {
    if (session) throw new Error('Viewport Worker already started');
    if (!Number.isInteger(request.channelCount) || request.channelCount < 1 || request.channelCount > 8) throw new Error('Invalid viewport configuration');
    const reader = new SharedChunkReader(request.port);
    const created: ViewSession = { reader, channelCount: request.channelCount, length: 0n, completeGroups: 0, groupCount: 0, ones: 0, zeros: 0, first: 0, last: 0, pages: new Map(), summaryBytes: 0, lastProgressAt: -Infinity, reportedLength: 0n, consumeDone: Promise.resolve(), state: 'open' };
    session = created; created.consumeDone = consume(created); return;
  }
  if (!session) throw new Error('Viewport Worker is not started');
  if (request.type === 'query') { answerQuery(session, request); return; }
  if (request.type === 'edges') { answerEdges(session, request); return; }
  if (!finishing) finishing = session.consumeDone;
  await finishing;
}
scope.onmessage = event => { void handle(event.data).catch(error => scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })); };
