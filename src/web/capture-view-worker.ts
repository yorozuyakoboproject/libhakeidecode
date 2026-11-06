import {
  SharedCaptureError,
  SharedChunkReader,
  SHARED_SUMMARY_GROUP_SAMPLES,
  type LogicSampleBytes,
} from './shared-chunks.js';

type Scope = {
  onmessage: ((event: MessageEvent<ViewRequest>) => void) | null;
  postMessage(message: ViewResponse, transfer?: Transferable[]): void;
};
const scope = globalThis as unknown as Scope;
const PAGE_GROUPS = 65_536;
const RECORD_BYTES = 16;
const SUMMARY_FOLD_FACTORS = [32, 16, 32] as const;
const MAX_SAFE_SAMPLE = BigInt(Number.MAX_SAFE_INTEGER);

type ViewRequest =
  | { type: 'start'; port: MessagePort; channelCount: number; bytesPerSample: LogicSampleBytes }
  | { type: 'query'; id: number; channel: number; startSample: bigint; endSample: bigint; bins: number }
  | {
      type: 'query-many';
      id: number;
      channels: readonly number[];
      startSample: bigint;
      endSample: bigint;
      bins: number;
    }
  | { type: 'edges'; id: number; channel: number; startSample: bigint; endSample: bigint }
  | { type: 'finish' };
type ViewChannelResult = {
  channel: number;
  low: Uint8Array;
  high: Uint8Array;
  edge: Uint8Array;
  packed: Uint8Array;
  points?: Uint8Array;
};
type ViewResponse =
  | { type: 'progress'; length: bigint; summaryBytes: number }
  | {
      type: 'query-result';
      id: number;
      channel: number;
      startSample: bigint;
      endSample: bigint;
      availableEnd: bigint;
      bins: number;
      low: Uint8Array;
      high: Uint8Array;
      edge: Uint8Array;
      packed: Uint8Array;
      points?: Uint8Array;
    }
  | {
      type: 'query-many-result';
      id: number;
      startSample: bigint;
      endSample: bigint;
      availableEnd: bigint;
      bins: number;
      results: readonly ViewChannelResult[];
    }
  | { type: 'edges-result'; id: number; channel: number; startSample: bigint; endSample: bigint; edges: bigint[] }
  | { type: 'done'; state: 'complete' | 'stopped' | 'error'; length: bigint; error?: string; summaryBytes: number }
  | { type: 'error'; message: string };

type SummaryPage = { buffer: ArrayBuffer; view: Uint32Array };
type SummaryLevel = { groupSamples: number; foldFactor: number; pages: Map<number, SummaryPage>; count: number };
type SummaryFold = { count: number; ones: number; zeros: number; first: number; last: number };
type RangeState = { low: number; high: number; edge: number; previous: number };
type ViewSession = {
  reader: SharedChunkReader;
  channelCount: number;
  bytesPerSample: LogicSampleBytes;
  length: bigint;
  groupCount: number;
  ones: number;
  zeros: number;
  first: number;
  last: number;
  levels: SummaryLevel[];
  folds: SummaryFold[];
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
taskYieldChannel.port1.onmessage = () => {
  const resolve = taskYieldResolve;
  taskYieldResolve = null;
  resolve?.();
};
function yieldWorkerTask(): Promise<void> {
  return new Promise((resolve) => {
    taskYieldResolve = resolve;
    taskYieldChannel.port2.postMessage(0);
  });
}

function maskFor(channel: number): number {
  return 1 << channel;
}
function pageFor(s: ViewSession, level: number, group: number): Uint32Array {
  const pages = s.levels[level]!.pages,
    pageIndex = Math.floor(group / PAGE_GROUPS),
    existing = pages.get(pageIndex);
  if (existing) return existing.view;
  const buffer = new ArrayBuffer(PAGE_GROUPS * RECORD_BYTES),
    view = new Uint32Array(buffer);
  pages.set(pageIndex, { buffer, view });
  s.summaryBytes += buffer.byteLength;
  return view;
}
function writeRecord(
  s: ViewSession,
  level: number,
  group: number,
  ones: number,
  zeros: number,
  first: number,
  last: number,
): void {
  const page = pageFor(s, level, group),
    offset = (group % PAGE_GROUPS) * 4;
  page[offset] = ones;
  page[offset + 1] = zeros;
  page[offset + 2] = first;
  page[offset + 3] = last;
}
function foldRecord(s: ViewSession, level: number, ones: number, zeros: number, first: number, last: number): void {
  if (level >= s.levels.length) return;
  const fold = s.folds[level]!;
  if (!fold.count) {
    fold.first = first;
    fold.ones = 0;
    fold.zeros = 0;
  }
  fold.ones |= ones;
  fold.zeros |= zeros;
  fold.last = last;
  fold.count++;
  if (fold.count !== s.levels[level]!.foldFactor) return;
  writeLevelRecord(s, level, fold.ones, fold.zeros, fold.first, fold.last);
  fold.count = 0;
}
function writeLevelRecord(
  s: ViewSession,
  level: number,
  ones: number,
  zeros: number,
  first: number,
  last: number,
): void {
  const target = s.levels[level]!;
  writeRecord(s, level, target.count, ones, zeros, first, last);
  target.count++;
  foldRecord(s, level + 1, ones, zeros, first, last);
}
function createLevels(): SummaryLevel[] {
  let groupSamples = SHARED_SUMMARY_GROUP_SAMPLES;
  const levels: SummaryLevel[] = [{ groupSamples, foldFactor: 0, pages: new Map(), count: 0 }];
  for (const foldFactor of SUMMARY_FOLD_FACTORS) {
    groupSamples *= foldFactor;
    levels.push({ groupSamples, foldFactor, pages: new Map(), count: 0 });
  }
  return levels;
}
function report(s: ViewSession, force = false): void {
  const now = performance.now();
  if (force || (s.length > 0n && s.reportedLength === 0n) || now - s.lastProgressAt >= 100) {
    s.lastProgressAt = now;
    s.reportedLength = s.length;
    scope.postMessage({ type: 'progress', length: s.length, summaryBytes: s.summaryBytes });
  }
}
function completeSummaryGroup(s: ViewSession): void {
  writeLevelRecord(s, 0, s.ones, s.zeros, s.first, s.last);
  s.groupCount = 0;
}
function processPart8(s: ViewSession, data: Uint8Array, count: number): void {
  const words =
    data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4)) : null;
  let index = 0;
  while (index < count) {
    const span = Math.min(count - index, SHARED_SUMMARY_GROUP_SAMPLES - s.groupCount),
      end = index + span;
    if (!s.groupCount) {
      s.first = data[index]!;
      s.ones = 0;
      s.zeros = 0;
    }
    let ones = s.ones,
      zeros = s.zeros,
      at = index;
    if (words) {
      while (at < end && (at & 3) !== 0) {
        const value = data[at++]!;
        ones |= value;
        zeros |= ~value;
      }
      const wordEnd = end >>> 2;
      for (let word = at >>> 2; word < wordEnd; word++) {
        const value = words[word]!;
        ones |= value;
        zeros |= ~value;
      }
      at = wordEnd << 2;
    }
    while (at < end) {
      const value = data[at++]!;
      ones |= value;
      zeros |= ~value;
    }
    s.ones = ones;
    s.zeros = zeros;
    s.last = data[end - 1]!;
    s.groupCount += span;
    index = end;
    if (s.groupCount === SHARED_SUMMARY_GROUP_SAMPLES) completeSummaryGroup(s);
  }
}
function processPart16(s: ViewSession, data: Uint8Array, count: number): void {
  const values = data.byteOffset % 2 === 0 ? new Uint16Array(data.buffer, data.byteOffset, count) : null;
  let index = 0;
  while (index < count) {
    const span = Math.min(count - index, SHARED_SUMMARY_GROUP_SAMPLES - s.groupCount),
      end = index + span;
    let ones = s.ones,
      zeros = s.zeros,
      first = s.first,
      last = s.last;
    if (!s.groupCount) {
      first = values ? values[index]! : data[index * 2]! | (data[index * 2 + 1]! << 8);
      ones = 0;
      zeros = 0;
    }
    if (values) {
      for (let at = index; at < end; at++) {
        const value = values[at]!;
        ones |= value;
        zeros |= ~value;
      }
      last = values[end - 1]!;
    } else {
      for (let at = index; at < end; at++) {
        const value = data[at * 2]! | (data[at * 2 + 1]! << 8);
        ones |= value;
        zeros |= ~value;
      }
      const offset = (end - 1) * 2;
      last = data[offset]! | (data[offset + 1]! << 8);
    }
    s.first = first;
    s.ones = ones;
    s.zeros = zeros;
    s.last = last;
    s.groupCount += span;
    index = end;
    if (s.groupCount === SHARED_SUMMARY_GROUP_SAMPLES) completeSummaryGroup(s);
  }
}
function processPart24(s: ViewSession, data: Uint8Array, count: number): void {
  let index = 0;
  while (index < count) {
    const span = Math.min(count - index, SHARED_SUMMARY_GROUP_SAMPLES - s.groupCount),
      end = index + span;
    let ones = s.ones,
      zeros = s.zeros,
      first = s.first,
      last = s.last;
    if (!s.groupCount) {
      const offset = index * 3;
      first = data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
      ones = 0;
      zeros = 0;
    }
    for (let at = index, offset = index * 3; at < end; at++, offset += 3) {
      const value = data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
      ones |= value;
      zeros |= ~value;
      last = value;
    }
    s.first = first;
    s.ones = ones;
    s.zeros = zeros;
    s.last = last;
    s.groupCount += span;
    index = end;
    if (s.groupCount === SHARED_SUMMARY_GROUP_SAMPLES) completeSummaryGroup(s);
  }
}
function processPart32(s: ViewSession, data: Uint8Array, count: number): void {
  const values = data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, count) : null;
  let index = 0;
  while (index < count) {
    const span = Math.min(count - index, SHARED_SUMMARY_GROUP_SAMPLES - s.groupCount),
      end = index + span;
    let ones = s.ones,
      zeros = s.zeros,
      first = s.first,
      last = s.last;
    if (!s.groupCount) {
      const offset = index * 4;
      first = values
        ? values[index]!
        : (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
      ones = 0;
      zeros = 0;
    }
    if (values) {
      for (let at = index; at < end; at++) {
        const value = values[at]!;
        ones |= value;
        zeros |= ~value;
      }
      last = values[end - 1]!;
    } else {
      for (let at = index; at < end; at++) {
        const offset = at * 4,
          value =
            (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
        ones |= value;
        zeros |= ~value;
      }
      const offset = (end - 1) * 4;
      last = (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
    }
    s.first = first;
    s.ones = ones;
    s.zeros = zeros;
    s.last = last;
    s.groupCount += span;
    index = end;
    if (s.groupCount === SHARED_SUMMARY_GROUP_SAMPLES) completeSummaryGroup(s);
  }
}
function processPart(s: ViewSession, data: Uint8Array): void {
  if (data.length % s.bytesPerSample) throw new Error('Shared block has a partial sample');
  const count = data.length / s.bytesPerSample;
  if (s.bytesPerSample === 1) processPart8(s, data, count);
  else if (s.bytesPerSample === 2) processPart16(s, data, count);
  else if (s.bytesPerSample === 3) processPart24(s, data, count);
  else processPart32(s, data, count);
  s.length += BigInt(count);
  if (s.groupCount) writeRecord(s, 0, s.levels[0]!.count, s.ones, s.zeros, s.first, s.last);
  report(s);
}
function recordAt(s: ViewSession, level: number, group: number): [number, number, number, number] | null {
  if (group < 0 || group >= s.levels[level]!.count) return null;
  const page = s.levels[level]!.pages.get(Math.floor(group / PAGE_GROUPS));
  if (!page) return null;
  const offset = (group % PAGE_GROUPS) * 4;
  return [page.view[offset]!, page.view[offset + 1]!, page.view[offset + 2]!, page.view[offset + 3]!];
}
function sampleAt(s: ViewSession, position: bigint): number {
  const value = s.reader.readSample(position);
  if (value === null) throw new Error(`Shared sample ${position} is not committed`);
  return value;
}
function exactPoints(data: Uint8Array, bit: number, bytesPerSample: LogicSampleBytes): Uint8Array {
  const samples = data.length / bytesPerSample,
    points = new Uint8Array(samples);
  if (bytesPerSample === 1) {
    for (let index = 0; index < samples; index++) points[index] = (data[index]! & bit) !== 0 ? 1 : 0;
  } else if (bytesPerSample === 2 && data.byteOffset % 2 === 0) {
    const values = new Uint16Array(data.buffer, data.byteOffset, samples);
    for (let index = 0; index < samples; index++) points[index] = (values[index]! & bit) !== 0 ? 1 : 0;
  } else if (bytesPerSample === 2) {
    for (let index = 0, offset = 0; index < samples; index++, offset += 2)
      points[index] = ((data[offset]! | (data[offset + 1]! << 8)) & bit) !== 0 ? 1 : 0;
  } else if (bytesPerSample === 3) {
    for (let index = 0, offset = 0; index < samples; index++, offset += 3)
      points[index] = ((data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) & bit) !== 0 ? 1 : 0;
  } else if (data.byteOffset % 4 === 0) {
    const values = new Uint32Array(data.buffer, data.byteOffset, samples);
    for (let index = 0; index < samples; index++) points[index] = (values[index]! & bit) !== 0 ? 1 : 0;
  } else {
    for (let index = 0, offset = 0; index < samples; index++, offset += 4)
      points[index] =
        ((data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) & bit) !== 0
          ? 1
          : 0;
  }
  return points;
}
function alignUp(position: bigint, step: bigint): bigint {
  const remainder = position % step;
  return remainder ? position + step - remainder : position;
}
function addSample(s: ViewSession, state: RangeState, bit: number, position: bigint): void {
  const level = sampleAt(s, position) & bit ? 1 : 0;
  if (level) state.high = 1;
  else state.low = 0;
  if (level !== state.previous) state.edge = 1;
  state.previous = level;
}
function addRecord(state: RangeState, record: [number, number, number, number], bit: number): void {
  const ones = (record[0] & bit) !== 0,
    zeros = (record[1] & bit) !== 0,
    first = (record[2] & bit) !== 0 ? 1 : 0;
  if (first !== state.previous) state.edge = 1;
  if (ones) state.high = 1;
  if (zeros) state.low = 0;
  if (ones && zeros) state.edge = 1;
  state.previous = (record[3] & bit) !== 0 ? 1 : 0;
}
function scanRange(s: ViewSession, state: RangeState, bit: number, start: bigint, end: bigint, level: number): void {
  if (start >= end) return;
  const stepSamples = s.levels[level]!.groupSamples,
    step = BigInt(stepSamples),
    aligned = alignUp(start, step);
  if (level > 0) {
    if (aligned > start) {
      const edgeEnd = aligned < end ? aligned : end;
      scanRange(s, state, bit, start, edgeEnd, level - 1);
      start = edgeEnd;
    }
    while (start + step <= end) {
      const record = recordAt(s, level, Number(start / step));
      if (!record) break;
      addRecord(state, record, bit);
      start += step;
    }
    if (start < end) scanRange(s, state, bit, start, end, level - 1);
    return;
  }
  if (aligned > start) {
    const edgeEnd = aligned < end ? aligned : end;
    while (start < edgeEnd) addSample(s, state, bit, start++);
  }
  while (start + step <= end) {
    const record = recordAt(s, 0, Number(start / step));
    if (!record) break;
    addRecord(state, record, bit);
    start += step;
  }
  while (start < end) addSample(s, state, bit, start++);
}
function rangeState(
  s: ViewSession,
  channel: number,
  start: bigint,
  end: bigint,
): { low: number; high: number; edge: number } {
  const bit = maskFor(channel),
    state: RangeState = {
      low: 1,
      high: 0,
      edge: 0,
      previous: start > 0n ? (sampleAt(s, start - 1n) & bit ? 1 : 0) : 0,
    };
  let level = s.levels.length - 1;
  while (level > 0 && !s.levels[level]!.count) level--;
  scanRange(s, state, bit, start, end, level);
  return { low: state.low, high: state.high, edge: state.edge };
}
function addRecordAt(s: ViewSession, state: RangeState, bit: number, level: number, group: number): boolean {
  const target = s.levels[level]!;
  if (group < 0 || group >= target.count) return false;
  const page = target.pages.get(Math.floor(group / PAGE_GROUPS));
  if (!page) return false;
  const offset = (group % PAGE_GROUPS) * 4,
    view = page.view;
  const ones = (view[offset]! & bit) !== 0,
    zeros = (view[offset + 1]! & bit) !== 0,
    first = (view[offset + 2]! & bit) !== 0 ? 1 : 0;
  if (first !== state.previous) state.edge = 1;
  if (ones) state.high = 1;
  if (zeros) state.low = 0;
  if (ones && zeros) state.edge = 1;
  state.previous = (view[offset + 3]! & bit) !== 0 ? 1 : 0;
  return true;
}
function addSamplesAt(s: ViewSession, state: RangeState, bit: number, start: number, end: number): void {
  if (start >= end) return;
  const data = s.reader.readRange(BigInt(start), BigInt(end));
  if (!data) throw new Error(`Shared samples ${start}..${end} are not committed`);
  const samples = data.length / s.bytesPerSample;
  let previous = state.previous;
  if (s.bytesPerSample === 1) {
    for (let index = 0; index < samples; index++) {
      const active = (data[index]! & bit) !== 0 ? 1 : 0;
      if (active) state.high = 1;
      else state.low = 0;
      if (active !== previous) state.edge = 1;
      previous = active;
    }
  } else if (s.bytesPerSample === 2 && data.byteOffset % 2 === 0) {
    const values = new Uint16Array(data.buffer, data.byteOffset, samples);
    for (let index = 0; index < samples; index++) {
      const active = (values[index]! & bit) !== 0 ? 1 : 0;
      if (active) state.high = 1;
      else state.low = 0;
      if (active !== previous) state.edge = 1;
      previous = active;
    }
  } else if (s.bytesPerSample === 2) {
    for (let index = 0, offset = 0; index < samples; index++, offset += 2) {
      const active = ((data[offset]! | (data[offset + 1]! << 8)) & bit) !== 0 ? 1 : 0;
      if (active) state.high = 1;
      else state.low = 0;
      if (active !== previous) state.edge = 1;
      previous = active;
    }
  } else if (s.bytesPerSample === 3) {
    for (let index = 0, offset = 0; index < samples; index++, offset += 3) {
      const active = ((data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) & bit) !== 0 ? 1 : 0;
      if (active) state.high = 1;
      else state.low = 0;
      if (active !== previous) state.edge = 1;
      previous = active;
    }
  } else if (data.byteOffset % 4 === 0) {
    const values = new Uint32Array(data.buffer, data.byteOffset, samples);
    for (let index = 0; index < samples; index++) {
      const active = (values[index]! & bit) !== 0 ? 1 : 0;
      if (active) state.high = 1;
      else state.low = 0;
      if (active !== previous) state.edge = 1;
      previous = active;
    }
  } else {
    for (let index = 0, offset = 0; index < samples; index++, offset += 4) {
      const active =
        ((data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) & bit) !== 0
          ? 1
          : 0;
      if (active) state.high = 1;
      else state.low = 0;
      if (active !== previous) state.edge = 1;
      previous = active;
    }
  }
  state.previous = previous;
}
function scanRangeNumber(
  s: ViewSession,
  state: RangeState,
  bit: number,
  start: number,
  end: number,
  level: number,
  approximate: boolean,
): void {
  if (start >= end) return;
  const step = s.levels[level]!.groupSamples,
    aligned = Math.ceil(start / step) * step;
  if (level > 0) {
    if (aligned > start) {
      const edgeEnd = aligned < end ? aligned : end;
      scanRangeNumber(s, state, bit, start, edgeEnd, level - 1, approximate);
      start = edgeEnd;
    }
    while (start + step <= end) {
      if (!addRecordAt(s, state, bit, level, Math.floor(start / step))) break;
      start += step;
    }
    if (start < end) scanRangeNumber(s, state, bit, start, end, level - 1, approximate);
    return;
  }
  if (aligned > start) {
    const edgeEnd = aligned < end ? aligned : end;
    if (!approximate || !addRecordAt(s, state, bit, 0, Math.floor(start / step)))
      addSamplesAt(s, state, bit, start, edgeEnd);
    start = edgeEnd;
  }
  while (start + step <= end) {
    if (!addRecordAt(s, state, bit, 0, Math.floor(start / step))) break;
    start += step;
  }
  if (!approximate || !addRecordAt(s, state, bit, 0, Math.floor(start / step))) addSamplesAt(s, state, bit, start, end);
}
function answerQueryNumbers(
  s: ViewSession,
  request: Extract<ViewRequest, { type: 'query' }>,
  begin: bigint,
  finish: bigint,
): void {
  const start = Number(begin),
    end = Number(finish),
    availableEnd = Math.min(end, Number(s.length));
  const low = new Uint8Array(request.bins).fill(1),
    high = new Uint8Array(request.bins),
    edge = new Uint8Array(request.bins),
    packed = new Uint8Array(request.bins).fill(8);
  let points: Uint8Array | undefined;
  if (start < availableEnd) {
    const width = end - start,
      bit = maskFor(request.channel),
      state: RangeState = { low: 1, high: 0, edge: 0, previous: 0 };
    const approximate = width / request.bins >= SHARED_SUMMARY_GROUP_SAMPLES;
    let level = s.levels.length - 1;
    while (level > 0 && (s.levels[level]!.groupSamples > width / request.bins || !s.levels[level]!.count)) level--;
    for (let index = 0; index < request.bins; index++) {
      const a = start + Math.floor(width * (index / request.bins));
      const b = index + 1 === request.bins ? end : start + Math.floor(width * ((index + 1) / request.bins));
      if (a >= availableEnd) break;
      const boundedB = b > availableEnd ? availableEnd : b,
        queryEnd = boundedB > a ? boundedB : a + 1;
      state.low = 1;
      state.high = 0;
      state.edge = 0;
      state.previous = a > 0 ? (sampleAt(s, BigInt(a - 1)) & bit ? 1 : 0) : 0;
      scanRangeNumber(s, state, bit, a, queryEnd, level, approximate);
      low[index] = state.low;
      high[index] = state.high;
      edge[index] = state.edge;
      packed[index] = state.high | (state.low << 1) | (state.edge << 2);
    }
    if (availableEnd - start <= request.bins) {
      const data = s.reader.readRange(begin, BigInt(availableEnd));
      if (data) points = exactPoints(data, bit, s.bytesPerSample);
    }
  }
  scope.postMessage(
    {
      type: 'query-result',
      id: request.id,
      channel: request.channel,
      startSample: begin,
      endSample: BigInt(end),
      availableEnd: BigInt(availableEnd),
      bins: request.bins,
      low,
      high,
      edge,
      packed,
      ...(points ? { points } : {}),
    },
    [low.buffer, high.buffer, edge.buffer, packed.buffer, ...(points ? [points.buffer] : [])],
  );
}
function addSamplesAtMany(
  s: ViewSession,
  states: RangeState[],
  bits: readonly number[],
  start: number,
  end: number,
): void {
  if (start >= end) return;
  const data = s.reader.readRange(BigInt(start), BigInt(end));
  if (!data) throw new Error(`Shared samples ${start}..${end} are not committed`);
  const samples = data.length / s.bytesPerSample;
  if (s.bytesPerSample === 1) {
    for (let index = 0; index < samples; index++) {
      const value = data[index]!;
      for (let channel = 0; channel < states.length; channel++) {
        const state = states[channel]!,
          active = (value & bits[channel]!) !== 0 ? 1 : 0;
        if (active) state.high = 1;
        else state.low = 0;
        if (active !== state.previous) state.edge = 1;
        state.previous = active;
      }
    }
  } else if (s.bytesPerSample === 2 && data.byteOffset % 2 === 0) {
    const values = new Uint16Array(data.buffer, data.byteOffset, samples);
    for (let index = 0; index < samples; index++) {
      const value = values[index]!;
      for (let channel = 0; channel < states.length; channel++) {
        const state = states[channel]!,
          active = (value & bits[channel]!) !== 0 ? 1 : 0;
        if (active) state.high = 1;
        else state.low = 0;
        if (active !== state.previous) state.edge = 1;
        state.previous = active;
      }
    }
  } else if (s.bytesPerSample === 2) {
    for (let index = 0, offset = 0; index < samples; index++, offset += 2) {
      const value = data[offset]! | (data[offset + 1]! << 8);
      for (let channel = 0; channel < states.length; channel++) {
        const state = states[channel]!,
          active = (value & bits[channel]!) !== 0 ? 1 : 0;
        if (active) state.high = 1;
        else state.low = 0;
        if (active !== state.previous) state.edge = 1;
        state.previous = active;
      }
    }
  } else if (s.bytesPerSample === 3) {
    for (let index = 0, offset = 0; index < samples; index++, offset += 3) {
      const value = data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
      for (let channel = 0; channel < states.length; channel++) {
        const state = states[channel]!,
          active = (value & bits[channel]!) !== 0 ? 1 : 0;
        if (active) state.high = 1;
        else state.low = 0;
        if (active !== state.previous) state.edge = 1;
        state.previous = active;
      }
    }
  } else if (data.byteOffset % 4 === 0) {
    const values = new Uint32Array(data.buffer, data.byteOffset, samples);
    for (let index = 0; index < samples; index++) {
      const value = values[index]!;
      for (let channel = 0; channel < states.length; channel++) {
        const state = states[channel]!,
          active = (value & bits[channel]!) !== 0 ? 1 : 0;
        if (active) state.high = 1;
        else state.low = 0;
        if (active !== state.previous) state.edge = 1;
        state.previous = active;
      }
    }
  } else {
    for (let index = 0, offset = 0; index < samples; index++, offset += 4) {
      const value =
        (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
      for (let channel = 0; channel < states.length; channel++) {
        const state = states[channel]!,
          active = (value & bits[channel]!) !== 0 ? 1 : 0;
        if (active) state.high = 1;
        else state.low = 0;
        if (active !== state.previous) state.edge = 1;
        state.previous = active;
      }
    }
  }
}
function addRecordAtMany(
  s: ViewSession,
  states: RangeState[],
  bits: readonly number[],
  level: number,
  group: number,
): boolean {
  const target = s.levels[level]!;
  if (group < 0 || group >= target.count) return false;
  const page = target.pages.get(Math.floor(group / PAGE_GROUPS));
  if (!page) return false;
  const offset = (group % PAGE_GROUPS) * 4,
    view = page.view;
  const ones = view[offset]!,
    zeros = view[offset + 1]!,
    first = view[offset + 2]!,
    last = view[offset + 3]!;
  for (let channel = 0; channel < states.length; channel++) {
    const state = states[channel]!,
      bit = bits[channel]!;
    if ((first & bit) !== 0 ? state.previous !== 1 : state.previous !== 0) state.edge = 1;
    if ((ones & bit) !== 0) state.high = 1;
    if ((zeros & bit) !== 0) state.low = 0;
    if ((ones & bit) !== 0 && (zeros & bit) !== 0) state.edge = 1;
    state.previous = (last & bit) !== 0 ? 1 : 0;
  }
  return true;
}
function scanRangeMany(
  s: ViewSession,
  states: RangeState[],
  bits: readonly number[],
  start: number,
  end: number,
  level: number,
  approximate: boolean,
): void {
  if (start >= end) return;
  const step = s.levels[level]!.groupSamples,
    aligned = Math.ceil(start / step) * step;
  if (level > 0) {
    if (aligned > start) {
      const edgeEnd = aligned < end ? aligned : end;
      scanRangeMany(s, states, bits, start, edgeEnd, level - 1, approximate);
      start = edgeEnd;
    }
    while (start + step <= end) {
      if (!addRecordAtMany(s, states, bits, level, Math.floor(start / step))) break;
      start += step;
    }
    if (start < end) scanRangeMany(s, states, bits, start, end, level - 1, approximate);
    return;
  }
  if (aligned > start) {
    const edgeEnd = aligned < end ? aligned : end;
    if (!approximate || !addRecordAtMany(s, states, bits, 0, Math.floor(start / step)))
      addSamplesAtMany(s, states, bits, start, edgeEnd);
    start = edgeEnd;
  }
  while (start + step <= end) {
    if (!addRecordAtMany(s, states, bits, 0, Math.floor(start / step))) break;
    start += step;
  }
  if (!approximate || !addRecordAtMany(s, states, bits, 0, Math.floor(start / step)))
    addSamplesAtMany(s, states, bits, start, end);
}
function answerQueryManyNumbers(
  s: ViewSession,
  request: Extract<ViewRequest, { type: 'query-many' }>,
  begin: bigint,
  finish: bigint,
): void {
  const start = Number(begin),
    end = Number(finish),
    availableEnd = Math.min(end, Number(s.length)),
    bits = request.channels.map(maskFor);
  const results: ViewChannelResult[] = request.channels.map((channel) => ({
    channel,
    low: new Uint8Array(request.bins).fill(1),
    high: new Uint8Array(request.bins),
    edge: new Uint8Array(request.bins),
    packed: new Uint8Array(request.bins).fill(8),
  }));
  if (start < availableEnd) {
    const width = end - start,
      states: RangeState[] = bits.map(() => ({ low: 1, high: 0, edge: 0, previous: 0 }));
    const approximate = width / request.bins >= SHARED_SUMMARY_GROUP_SAMPLES;
    let level = s.levels.length - 1;
    while (level > 0 && (s.levels[level]!.groupSamples > width / request.bins || !s.levels[level]!.count)) level--;
    for (let index = 0; index < request.bins; index++) {
      const a = start + Math.floor(width * (index / request.bins));
      const b = index + 1 === request.bins ? end : start + Math.floor(width * ((index + 1) / request.bins));
      if (a >= availableEnd) break;
      const boundedB = b > availableEnd ? availableEnd : b,
        queryEnd = boundedB > a ? boundedB : a + 1;
      const previousValue = a > 0 ? sampleAt(s, BigInt(a - 1)) : 0;
      for (let channel = 0; channel < states.length; channel++) {
        const state = states[channel]!;
        state.low = 1;
        state.high = 0;
        state.edge = 0;
        state.previous = (previousValue & bits[channel]!) !== 0 ? 1 : 0;
      }
      scanRangeMany(s, states, bits, a, queryEnd, level, approximate);
      for (let channel = 0; channel < states.length; channel++) {
        const state = states[channel]!,
          result = results[channel]!;
        result.low[index] = state.low;
        result.high[index] = state.high;
        result.edge[index] = state.edge;
        result.packed[index] = state.high | (state.low << 1) | (state.edge << 2);
      }
    }
    if (availableEnd - start <= request.bins) {
      const data = s.reader.readRange(begin, BigInt(availableEnd));
      if (data)
        for (let channel = 0; channel < results.length; channel++)
          results[channel]!.points = exactPoints(data, bits[channel]!, s.bytesPerSample);
    }
  }
  const transfer: Transferable[] = [];
  for (const result of results)
    transfer.push(
      result.low.buffer,
      result.high.buffer,
      result.edge.buffer,
      result.packed.buffer,
      ...(result.points ? [result.points.buffer] : []),
    );
  scope.postMessage(
    {
      type: 'query-many-result',
      id: request.id,
      startSample: begin,
      endSample: BigInt(end),
      availableEnd: BigInt(availableEnd),
      bins: request.bins,
      results,
    },
    transfer,
  );
}
function answerQuery(s: ViewSession, request: Extract<ViewRequest, { type: 'query' }>): void {
  if (!Number.isInteger(request.channel) || request.channel < 0 || request.channel >= s.channelCount)
    throw new RangeError('channel out of range');
  if (!Number.isSafeInteger(request.bins) || request.bins < 1) throw new RangeError('bins must be positive');
  const start = request.startSample < 0n ? 0n : request.startSample;
  const end = request.endSample > start ? request.endSample : start;
  if (end <= MAX_SAFE_SAMPLE && s.length <= MAX_SAFE_SAMPLE) {
    answerQueryNumbers(s, request, start, end);
    return;
  }
  const availableEnd = end > s.length ? s.length : end;
  const low = new Uint8Array(request.bins).fill(1),
    high = new Uint8Array(request.bins),
    edge = new Uint8Array(request.bins),
    packed = new Uint8Array(request.bins).fill(8);
  let points: Uint8Array | undefined;
  if (start < availableEnd) {
    const width = end - start,
      divisor = BigInt(request.bins);
    for (let index = 0; index < request.bins; index++) {
      const a = start + (width * BigInt(index)) / divisor;
      const b = index + 1 === request.bins ? end : start + (width * BigInt(index + 1)) / divisor;
      if (a >= availableEnd) continue;
      const boundedB = b > availableEnd ? availableEnd : b;
      const queryEnd = boundedB > a ? boundedB : a + 1n;
      const state = rangeState(s, request.channel, a, queryEnd);
      low[index] = state.low;
      high[index] = state.high;
      edge[index] = state.edge;
      packed[index] = state.high | (state.low << 1) | (state.edge << 2);
    }
    if (availableEnd - start <= BigInt(request.bins)) {
      const data = s.reader.readRange(start, availableEnd);
      if (data) points = exactPoints(data, maskFor(request.channel), s.bytesPerSample);
    }
  }
  scope.postMessage(
    {
      type: 'query-result',
      id: request.id,
      channel: request.channel,
      startSample: start,
      endSample: end,
      availableEnd,
      bins: request.bins,
      low,
      high,
      edge,
      packed,
      ...(points ? { points } : {}),
    },
    [low.buffer, high.buffer, edge.buffer, packed.buffer, ...(points ? [points.buffer] : [])],
  );
}
function answerQueryMany(s: ViewSession, request: Extract<ViewRequest, { type: 'query-many' }>): void {
  if (
    !request.channels.length ||
    request.channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel >= s.channelCount) ||
    new Set(request.channels).size !== request.channels.length
  )
    throw new RangeError('channels out of range');
  if (!Number.isSafeInteger(request.bins) || request.bins < 1) throw new RangeError('bins must be positive');
  const start = request.startSample < 0n ? 0n : request.startSample,
    end = request.endSample > start ? request.endSample : start;
  if (end > MAX_SAFE_SAMPLE || s.length > MAX_SAFE_SAMPLE)
    throw new RangeError('batch query requires safe sample positions');
  answerQueryManyNumbers(s, request, start, end);
}
function answerEdges(s: ViewSession, request: Extract<ViewRequest, { type: 'edges' }>): void {
  const start = request.startSample < 1n ? 1n : request.startSample,
    end = request.endSample > s.length ? s.length : request.endSample;
  if (!Number.isInteger(request.channel) || request.channel < 0 || request.channel >= s.channelCount)
    throw new RangeError('channel out of range');
  const bit = maskFor(request.channel),
    output: bigint[] = [];
  if (start < end) {
    let previous = sampleAt(s, start - 1n) & bit;
    for (let position = start; position < end; position++) {
      const value = sampleAt(s, position) & bit;
      if (value !== previous) output.push(position);
      previous = value;
    }
  }
  scope.postMessage({
    type: 'edges-result',
    id: request.id,
    channel: request.channel,
    startSample: start,
    endSample: end,
    edges: output,
  });
}
async function consume(s: ViewSession): Promise<void> {
  try {
    while (true) {
      const part = await s.reader.next(1_048_576);
      if (!part) {
        s.state = 'complete';
        break;
      }
      processPart(s, part.data);
      await yieldWorkerTask();
    }
  } catch (error) {
    if (error instanceof SharedCaptureError) {
      s.state = error.captureState;
      s.error = error.message;
    } else {
      s.state = 'error';
      s.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    report(s, true);
    scope.postMessage({
      type: 'done',
      state: s.state === 'open' ? 'error' : s.state,
      length: s.length,
      ...(s.error ? { error: s.error } : {}),
      summaryBytes: s.summaryBytes,
    });
  }
}
async function handle(request: ViewRequest): Promise<void> {
  if (request.type === 'start') {
    if (session) throw new Error('Viewport Worker already started');
    if (
      !Number.isInteger(request.channelCount) ||
      request.channelCount < 1 ||
      request.channelCount > 32 ||
      ![1, 2, 3, 4].includes(request.bytesPerSample)
    )
      throw new Error('Invalid viewport configuration');
    const reader = new SharedChunkReader(request.port, request.bytesPerSample);
    const levels = createLevels();
    const created: ViewSession = {
      reader,
      channelCount: request.channelCount,
      bytesPerSample: request.bytesPerSample,
      length: 0n,
      groupCount: 0,
      ones: 0,
      zeros: 0,
      first: 0,
      last: 0,
      levels,
      folds: levels.map(() => ({ count: 0, ones: 0, zeros: 0, first: 0, last: 0 })),
      summaryBytes: 0,
      lastProgressAt: -Infinity,
      reportedLength: 0n,
      consumeDone: Promise.resolve(),
      state: 'open',
    };
    session = created;
    created.consumeDone = consume(created);
    return;
  }
  if (!session) throw new Error('Viewport Worker is not started');
  if (request.type === 'query') {
    answerQuery(session, request);
    return;
  }
  if (request.type === 'query-many') {
    answerQueryMany(session, request);
    return;
  }
  if (request.type === 'edges') {
    answerEdges(session, request);
    return;
  }
  if (!finishing) finishing = session.consumeDone;
  await finishing;
}
scope.onmessage = (event) => {
  void handle(event.data).catch((error) =>
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
  );
};
