import { samplePosition, sampleFloor, sampleCeil, minSample, maxSample, absSample, compareSamples, scaleSamples, sampleRatio, type SampleInput } from '../libhakei/sample-index.js';
import type { Annotation, DecoderId } from './protocol.js';
import type { ProtocolSettings } from './workspace.js';
import { decoderDefinition, decoderDefinitions } from '../decoders/index.js';
import type { Capture } from './capture.js';
import type { AnalogColumnView, AnalogStore } from './data/analogStore.js';
import type { ColumnView } from './data/types.js';
import { AnnotationIndex } from './event-index.js';
import { readPalette } from './theme.js';
import { hasMessage, t } from './i18n.js';
import { rowKey, reconcileRowOrder, moveTimelineRow, type TimelineRow } from './timeline.js';
const timeUnits = [
  [1e-15, 'fs'], [1e-12, 'ps'], [1e-9, 'ns'], [1e-6, 'µs'], [1e-3, 'ms'],
  [1, 's'], [1e3, 'ks'], [1e6, 'Ms'], [1e9, 'Gs'], [1e12, 'Ts'], [1e15, 'Ps'], [1e18, 'Es'],
] as const;
const SAMPLE_POINT_GAP = 3, SAMPLE_POINT_RADIUS = 1.75, ANALOG_LINE_WIDTH = 1.5, ANALOG_LINE_MIN_PIXELS = .25, MIN_VIEW_SAMPLES = 2n;
export function timeLabel(seconds: number, resolutionSeconds?: number, digits = 3): string {
  const basis = Math.abs(resolutionSeconds ?? (seconds || 1e-9));
  let index = 0;
  while (index < timeUnits.length - 1 && basis >= timeUnits[index + 1][0]) index++;
  while (index < timeUnits.length - 1 && Number((Math.abs(seconds) / timeUnits[index][0]).toFixed(digits)) >= 1000) index++;
  const [scale, unit] = timeUnits[index], text = (seconds / scale).toFixed(digits);
  return (Number(text) === 0 ? (0).toFixed(digits) : text) + ' ' + unit;
}
export function frequencyLabel(hz: number, digits = 3): string {
  if (!Number.isFinite(hz)) return '∞ Hz';
  const units = ['Hz', 'kHz', 'MHz', 'GHz', 'THz', 'PHz', 'EHz']; let index = 0;
  while (index < units.length - 1 && Number((Math.abs(hz) / 1000 ** index).toFixed(digits)) >= 1000) index++;
  return (hz / 1000 ** index).toFixed(digits) + ' ' + units[index];
}
export interface TimelineLayoutRow { entry: TimelineRow; top: number; height: number }
export interface ProtocolTrace extends ProtocolSettings { annotations: AnnotationIndex }
export class WaveformRenderer {
  decoder: DecoderId = decoderDefinitions[0]!.decoder.descriptor.id;
  capture: Capture | null = null;
  protocols: ProtocolTrace[] = [];
  selectedProtocolId: string | null = null;
  private readonly fallbackAnnotations = new AnnotationIndex();
  get annotations(): AnnotationIndex { return this.protocols.find(p => p.id === this.selectedProtocolId)?.annotations ?? this.fallbackAnnotations; }
  channels: number[] = [];
  analogChannels: number[] = [];
  rowOrder: TimelineRow[] = [];
  start = 0n; end = 1n;
  cursorA: bigint | null = null;
  cursorB: bigint | null = null;
  get cursor(): bigint | null { return this.cursorA; }
  set cursor(value: bigint | null) { this.cursorA = value; }
  cursorMode = false;
  onAnnotationClick: (id: string, ss: bigint, es: bigint) => void = () => {};
  onChange: () => void = () => {};
  onProtocolOrderChange: () => void = () => {};
  private pending = false;
  private viewRefresh: Promise<void> | null = null;
  private viewRefreshDirty = false;
  private viewReady = true;
  private viewGeneration = 0;
  private renderingEnabled = true;
  private frameRequest = 0;
  private readonly observer: ResizeObserver;
  private draggingCursor = false;
  private pointerStart: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; start: bigint; end: bigint; scrollLeft: number; scrollTop: number } | null = null;
  private cursorDrag: 'a' | 'b' | null = null;
  private cursorRange: { startX: number; moved: boolean } | null = null;
  private rowDrag: { entry: TimelineRow; startY: number; clientY: number; y: number; offset: number; moved: boolean } | null = null;
  private rowSnapshot: { canvas: HTMLCanvasElement; rects: Map<string, TimelineLayoutRow>; dpr: number } | null = null;
  private rowMotions = new Map<string, { from: number; to: number; started: number }>();
  private readonly motionDuration = 200;
  private pointerId: number | null = null;
  private overviewDrag: { pointerId: number } | null = null;
  private timings: number[] = [];
  private queryTimings: number[] = [];
  private queryTotalMs = 0;
  private queryCalls = 0;
  private queryMaxMs = 0;
  private width = 1000;
  private palette = readPalette();
  private readonly frameCanvas = document.createElement('canvas');
  private readonly frameContext = this.frameCanvas.getContext('2d')!;
  private readonly themeChanged = (): void => { this.palette = readPalette(); this.schedule(); };
  readonly gutter = 114;
  constructor(readonly canvas: HTMLCanvasElement, readonly overview: HTMLCanvasElement, readonly axisCanvas?: HTMLCanvasElement) {
    window.addEventListener('hakei:themechange', this.themeChanged);
    const scroll = canvas.parentElement!;
    this.observer = new ResizeObserver(() => this.invalidateView()); this.observer.observe(scroll);
    scroll.addEventListener('wheel', event => {
      if (!this.capture) return;
      event.preventDefault();
      const rect = scroll.getBoundingClientRect();
      const x = event.clientX - rect.left + scroll.scrollLeft;
      const anchor = (x - this.gutter) / (this.width - this.gutter - 16);
      this.zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * .006), anchor);
    }, { passive: false });
    const target = canvas;
    target.addEventListener('pointerdown', event => {
      if (!this.capture || event.button !== 0 || this.pointerId !== null) return;
      this.pointerId = event.pointerId;
      this.pointerStart = { x: event.offsetX, y: event.offsetY };
      target.setPointerCapture(event.pointerId);
      const row = this.rowAt(event.offsetX, event.offsetY);
      if (row) {
        this.settleRows();
        this.rowDrag = { entry: row.entry, startY: event.clientY, clientY: event.clientY, y: event.offsetY, offset: event.offsetY - row.top, moved: false };
        this.schedule(); return;
      }
      if (event.offsetX < this.gutter) return;
      if (this.cursorMode) {
        const sample = minSample(this.capture.store.length - 1n, this.sampleAtX(event.offsetX));
        this.cursorA = sample; this.cursorB = null; this.cursorRange = { startX: event.clientX, moved: false };
        this.draggingCursor = true; this.onChange(); this.schedule();
      } else {
        this.cursorDrag = this.nearestCursor(event.offsetX, event.offsetY < this.axisHeight());
        if (this.cursorDrag) { this.draggingCursor = true; this.setCursor(event.offsetX, this.cursorDrag); }
        else {
          const scroll = this.canvas.parentElement!;
          this.drag = { x: event.clientX, y: event.clientY, start: this.start, end: this.end, scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop };
        }
      }
    });
    target.addEventListener('pointermove', event => {
      if (this.pointerId === null) {
        target.style.cursor = this.rowAt(event.offsetX, event.offsetY) ? 'grab' : this.cursorMode ? 'crosshair' : 'grab';
        return;
      }
      if (this.pointerId !== event.pointerId) return;
      if (this.rowDrag) {
        this.rowDrag.clientY = event.clientY; this.rowDrag.y = event.clientY - this.canvas.getBoundingClientRect().top;
        if (!this.rowDrag.moved && Math.abs(event.clientY - this.rowDrag.startY) >= 4) { this.snapshotRows(); this.rowDrag.moved = true; }
        if (this.rowDrag.moved) { target.style.cursor = 'grabbing'; this.reorderRow(this.rowDrag.y); this.schedule(); }
      } else if (this.cursorRange) {
        if (Math.abs(event.clientX - this.cursorRange.startX) >= 3) this.cursorRange.moved = true;
        if (this.cursorRange.moved) this.setCursor(event.offsetX, 'b');
      } else if (this.draggingCursor && this.cursorDrag) this.setCursor(event.offsetX, this.cursorDrag);
      else if (this.drag) {
        const amount = scaleSamples(this.drag.end - this.drag.start, (this.drag.x - event.clientX) / (this.width - this.gutter - 16));
        this.setViewport(this.drag.start + amount, this.drag.end + amount);
        const scroll = this.canvas.parentElement!;
        scroll.scrollLeft = Math.max(0, this.drag.scrollLeft + this.drag.x - event.clientX);
        scroll.scrollTop = Math.max(0, this.drag.scrollTop + this.drag.y - event.clientY);
      }
    });
    target.addEventListener('pointerup', event => {
      if (this.pointerId !== event.pointerId) return;
      const begin = this.pointerStart;
      if (this.cursorRange?.moved) this.setCursor(event.offsetX, 'b');
      if (begin && !this.draggingCursor && !this.rowDrag?.moved && Math.abs(event.offsetX - begin.x) < 4 && Math.abs(event.offsetY - begin.y) < 4) this.selectAnnotation(event.offsetX, event.offsetY);
      this.finishPointer(target);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    });
    target.addEventListener('pointercancel', () => this.finishPointer(target));
    target.addEventListener('lostpointercapture', () => { if (this.pointerId !== null) this.finishPointer(target); });
    overview.addEventListener('pointerdown', event => {
      if (!this.capture || event.button !== 0) return;
      overview.setPointerCapture(event.pointerId); this.overviewDrag = { pointerId: event.pointerId };
      this.moveOverview(event);
    });
    overview.addEventListener('pointermove', event => { if (this.overviewDrag?.pointerId === event.pointerId) this.moveOverview(event); });
    overview.addEventListener('pointerup', event => { if (this.overviewDrag?.pointerId === event.pointerId) this.overviewDrag = null; });
    overview.addEventListener('pointercancel', () => { this.overviewDrag = null; });
    overview.addEventListener('lostpointercapture', () => { this.overviewDrag = null; });
  }
  setCapture(capture: Capture, viewport?: readonly [SampleInput, SampleInput]): void {
    this.capture = capture; this.channels = Array.from({ length: (capture.logicChannelCount ?? capture.store.channelCount) }, (_, i) => i);
    this.analogChannels = Array.from({ length: capture.analogChannels?.length ?? 0 }, (_, i) => i);
    this.rowOrder = this.channels.map(id => ({ kind: 'channel', id })); this.settleRows();
    this.annotations.clear(); this.cursorA = null; this.cursorB = null; this.cursorMode = false;
    const limit = this.viewLength(capture); let start = 0n, end = limit;
    if (viewport) {
      try {
        const requestedStart = sampleFloor(viewport[0]), requestedEnd = sampleCeil(viewport[1]);
        if (requestedStart >= 0n && requestedEnd > requestedStart && requestedEnd <= limit) { start = requestedStart; end = requestedEnd; }
      } catch {}
    }
    this.applyViewport(start, end);
  }
  clearCapture(): void {
    this.capture = null; this.channels = []; this.analogChannels = []; this.rowOrder = [];
    this.start = 0n; this.end = 1n; this.cursorA = null; this.cursorB = null; this.cursorMode = false;
    this.viewGeneration++; this.viewReady = true;
    this.schedule(); this.onChange();
  }

  updateCapture(capture: Capture): void { this.capture = capture; this.schedule(); }
  setViewport(startInput: SampleInput, endInput: SampleInput): void { this.applyViewport(startInput, endInput); }
  private applyViewport(startInput: SampleInput, endInput: SampleInput): void {
    if (!this.capture) return;
    let start: bigint, end: bigint;
    try { start = sampleFloor(startInput); end = sampleCeil(endInput); } catch { return; }
    const length = this.viewLength(this.capture), span = maxSample(minSample(MIN_VIEW_SAMPLES, length), minSample(length, end - start));
    const nextStart = maxSample(0n, minSample(length - span, start)), nextEnd = nextStart + span, changed = nextStart !== this.start || nextEnd !== this.end;
    this.start = nextStart; this.end = nextEnd;
    this.onChange();
    if (changed) this.invalidateView(); else this.schedule();
  }
  private invalidateView(): void { this.viewGeneration++; this.viewReady = false; this.schedule(); }
  zoom(factor: number, anchor = .5): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const bounded = Math.max(0, Math.min(1, anchor)), span = this.end - this.start;
    const point = this.start + scaleSamples(span, bounded), scaled = scaleSamples(span, 1 / factor);
    const next = factor < 1 ? maxSample(span + 1n, scaled) : maxSample(1n, scaled);
    const start = point - scaleSamples(next, bounded); this.setViewport(start, start + next);
  }
  pan(samples: SampleInput): void { const delta = samplePosition(samples); this.setViewport(this.start + delta, this.end + delta); }
  fit(): void { if (this.capture) this.setViewport(0n, this.viewLength(this.capture)); }
  focus(ss: bigint, es: bigint): void { const pad = maxSample(32n, (es - ss) * 3n / 2n); this.setViewport(ss - pad, es + pad); }
  sampleAtX(x: number): bigint { return this.start + scaleSamples(this.end - this.start, Math.max(0, Math.min(1, (x - this.gutter) / (this.width - this.gutter - 16)))); }
  xAtSample(sample: SampleInput): number { return this.gutter + sampleRatio(samplePosition(sample) - this.start, this.end - this.start) * Math.max(1, this.width - this.gutter - 16); }
  timeResolution(): number {
    if (!this.capture) return 1;
    const plotWidth = Math.max(1, this.width - this.gutter - 16), ticks = Math.max(2, Math.min(8, Math.floor(plotWidth / 115)));
    return Number(this.end - this.start) / ticks / this.capture.store.samplerate;
  }
  private viewLength(capture: Capture | null = this.capture): bigint { return capture?.acquisition?.targetSamples ?? capture?.store.length ?? 0n; }
  private setCursor(x: number, which: 'a' | 'b' = 'a'): void {
    if (!this.capture) return;
    const sample = minSample(this.capture.store.length - 1n, this.sampleAtX(x));
    if (which === 'b') this.cursorB = sample; else this.cursorA = sample;
    this.onChange(); this.schedule();
  }
  private axisHeight(): number { return this.cursorA !== null && this.cursorB !== null ? 60 : 30; }
  private waveformTop(): number { return this.axisHeight() + 8; }
  private protocolRows(protocol: ProtocolTrace): number { return decoderDefinition(protocol.decoder).ui.rows.length; }
  private protocolHeight(protocol: ProtocolTrace): number { return this.protocolRows(protocol) * 32 + 8; }
  getRowOrder(): TimelineRow[] {
    const count = this.capture ? this.capture.logicChannelCount ?? this.capture.store.channelCount : 0;
    const channels = [...this.channels, ...Array.from({ length: count }, (_, id) => id).filter(id => !this.channels.includes(id))];
    this.rowOrder = reconcileRowOrder(this.rowOrder, channels, this.protocols.map(p => p.id));
    const visible = new Set(this.channels);
    this.channels = this.rowOrder.flatMap(row => row.kind === 'channel' && visible.has(row.id) ? [row.id] : []);
    return this.rowOrder.map(row => ({ ...row }));
  }
  rowLayout(): TimelineLayoutRow[] {
    const visible = new Set(this.channels), protocols = new Map(this.protocols.map(p => [p.id, p])); let top = this.waveformTop();
    const rows = this.getRowOrder().flatMap(entry => {
      if (entry.kind === 'channel' && !visible.has(entry.id)) return [];
      const height = entry.kind === 'channel' || entry.kind === 'analog' ? 54 : this.protocolHeight(protocols.get(entry.id)!);
      const row = { entry, top, height }; top += height; return [row];
    });
    for (const id of this.analogChannels) {
      const row = { entry: { kind: 'analog' as const, id }, top, height: 54 }; rows.push(row); top += row.height;
    }
    return rows;
  }
  private rowAt(x: number, y: number): TimelineLayoutRow | null {
    if (x < 0 || x >= this.gutter - 12) return null;
    return this.rowLayout().find(row => row.entry.kind !== 'analog' && y >= row.top && y < row.top + row.height) ?? null;
  }
  private settleRows(): void { this.rowSnapshot = null; this.rowMotions.clear(); }
  private snapshotRows(): void {
    this.settleRows(); this.drawNow();
    const image = document.createElement('canvas'); image.width = this.canvas.width; image.height = this.canvas.height;
    image.getContext('2d')!.drawImage(this.canvas, 0, 0);
    this.rowSnapshot = { canvas: image, rects: new Map(this.rowLayout().map(row => [rowKey(row.entry), row])), dpr: window.devicePixelRatio || 1 };
  }
  private motionTop(row: TimelineLayoutRow, now: number): number {
    const motion = this.rowMotions.get(rowKey(row.entry)); if (!motion) return row.top;
    const progress = Math.max(0, Math.min(1, (now - motion.started) / this.motionDuration));
    return motion.from + (motion.to - motion.from) * (1 - (1 - progress) ** 3);
  }
  private reducedMotion(): boolean { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  private floatingTop(): number {
    const drag = this.rowDrag!;
    return Math.max(this.waveformTop(), drag.y - drag.offset);
  }
  private reorderRow(y: number): void {
    const drag = this.rowDrag; if (!drag?.moved) return;
    const rows = this.rowLayout(), others = rows.filter(row => rowKey(row.entry) !== rowKey(drag.entry));
    const before = others.find(row => y < row.top + row.height / 2)?.entry;
    const next = moveTimelineRow(this.getRowOrder(), drag.entry, before);
    if (next.every((row, i) => rowKey(row) === rowKey(this.rowOrder[i]))) return;
    const now = performance.now(), previous = new Map(rows.map(row => [rowKey(row.entry), this.motionTop(row, now)]));
    this.rowOrder = next;
    const visible = new Set(this.channels); this.channels = next.flatMap(row => row.kind === 'channel' && visible.has(row.id) ? [row.id] : []);
    const protocols = new Map(this.protocols.map(p => [p.id, p]));
    this.protocols.splice(0, this.protocols.length, ...next.flatMap(row => row.kind === 'protocol' ? [protocols.get(row.id)!] : []));
    if (!this.reducedMotion()) for (const row of this.rowLayout()) {
      const key = rowKey(row.entry), from = previous.get(key)!;
      if (key === rowKey(drag.entry)) continue;
      if (Math.abs(from - row.top) > .1) this.rowMotions.set(key, { from, to: row.top, started: now });
      else this.rowMotions.delete(key);
    }
    this.onProtocolOrderChange(); this.schedule();
  }
  private scrollDraggedRow(): boolean {
    const drag = this.rowDrag; if (!drag?.moved) return false;
    const scroll = this.canvas.parentElement!, rect = scroll.getBoundingClientRect();
    const amount = drag.clientY < rect.top + this.axisHeight() + 20 ? -12 : drag.clientY > rect.bottom - 24 ? 12 : 0;
    if (!amount) return false;
    const previous = scroll.scrollTop; scroll.scrollTop += amount;
    if (scroll.scrollTop === previous) return false;
    drag.y = drag.clientY - this.canvas.getBoundingClientRect().top; this.reorderRow(drag.y); return true;
  }
  private finishPointer(target: HTMLCanvasElement): void {
    const measuring = this.draggingCursor;
    if (this.rowDrag?.moved && !this.reducedMotion()) {
      const row = this.rowLayout().find(row => rowKey(row.entry) === rowKey(this.rowDrag!.entry));
      if (row) this.rowMotions.set(rowKey(row.entry), { from: this.floatingTop(), to: row.top, started: performance.now() });
    }
    this.drag = null; this.cursorRange = null; this.draggingCursor = false; this.cursorDrag = null; this.pointerStart = null; this.rowDrag = null; this.pointerId = null;
    if (measuring) { this.cursorMode = false; this.onChange(); }
    target.style.cursor = this.cursorMode ? 'crosshair' : 'grab'; this.schedule();
  }
  private drawGrip(ctx: CanvasRenderingContext2D, top: number, height: number, active: boolean): void {
    ctx.fillStyle = this.palette['label'];
    for (const x of [4, 8]) for (const y of [-4, 0, 4]) ctx.fillRect(x, top + height / 2 + y, 1.5, 1.5);
    if (active) { ctx.strokeStyle = this.palette['label']; ctx.lineWidth = 1; ctx.strokeRect(1, top + 1, this.gutter - 14, height - 2); }
  }
  private nearestCursor(x: number, label: boolean): 'a' | 'b' | null {
    if (!this.capture) return null;
    const candidates = ([['a', this.cursorA], ['b', this.cursorB]] as const).filter(([, sample]) => sample !== null)
      .map(([key, sample]) => ({ key, distance: Math.abs(x - this.xAtSample(sample!)) }));
    const nearest = candidates.sort((a, b) => a.distance - b.distance)[0];
    if (nearest && (nearest.distance <= 9 || label && nearest.distance <= 80)) return nearest.key;
    return null;
  }
  private moveOverview(event: PointerEvent): void {
    if (!this.capture) return;
    const rect = this.overview.getBoundingClientRect(), x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const center = scaleSamples(this.viewLength(this.capture), x / Math.max(1, rect.width)), span = this.end - this.start, start = center - span / 2n;
    this.setViewport(start, start + span);
  }
  private selectAnnotation(x: number, y: number): void {
    const row = this.rowLayout().find(row => row.entry.kind === 'protocol' && y >= row.top && y < row.top + row.height);
    if (!row || row.entry.kind !== 'protocol') return;
    const protocol = this.protocols.find(p => p.id === row.entry.id)!; const top = row.top;
    if (x < this.gutter) { this.onAnnotationClick(protocol.id, this.start, this.end); return; }
    const index = Math.floor((y - top) / 32);
    if (index >= this.protocolRows(protocol)) return;
    const classes = decoderDefinition(protocol.decoder).ui.rows[index]?.classes ?? [];
    const sample = this.sampleAtX(x), annotation = protocol.annotations.query(sample, sample).find(a => classes.includes(a.classIndex));
    if (annotation) this.onAnnotationClick(protocol.id, annotation.ss, annotation.es);
  }
  setRenderingEnabled(enabled: boolean): void {
    this.renderingEnabled = enabled;
    if (!enabled) {
      if (this.pending) { cancelAnimationFrame(this.frameRequest); this.pending = false; }
    }
    else if (enabled) this.schedule();
  }
  resetMetrics(): void { this.timings = []; this.queryTimings = []; this.queryTotalMs = 0; this.queryCalls = 0; this.queryMaxMs = 0; }
  schedule(): void {
    if (!this.renderingEnabled) return;
    this.viewRefreshDirty = true;
    if (this.pending) return;
    this.pending = true;
    this.frameRequest = requestAnimationFrame(() => {
      this.pending = false;
      const capture = this.capture;
      if (!capture) { this.drawNow(); return; }
      this.refreshView();
    });
  }
  private refreshView(): void {
    const capture = this.capture;
    if (!this.renderingEnabled || !capture) return;
    if (this.viewRefresh) { this.viewRefreshDirty = true; return; }
    const store = capture.store as (Capture['store'] & { prepareView?: (channels: readonly number[], start: bigint, end: bigint, bins: number, includeEdges?: boolean) => Promise<void> }) | undefined;
    const width = Math.max(300, Math.floor(this.canvas.parentElement?.clientWidth || 1000));
    const bins = Math.max(1, width - this.gutter - 16), start = this.start, end = this.end, generation = this.viewGeneration;
    const tasks: Promise<void>[] = [];
    if (store?.prepareView && end > start) tasks.push(store.prepareView(this.channels, start, end, bins));
    for (const channel of this.analogChannels) {
      const analog = capture.analogChannels?.[channel]?.store as (AnalogStore & { prepareView?: (start: bigint, end: bigint, bins: number) => Promise<void> }) | undefined;
      if (!analog?.prepareView) continue;
      const samples = this.sampleRange(analog.length, bins, ANALOG_LINE_MIN_PIXELS);
      if (samples) tasks.push(analog.prepareView(samples.start, samples.end, samples.count));
      else {
        const availableEnd = minSample(analog.length, end);
        if (availableEnd > start) tasks.push(analog.prepareView(start, availableEnd, this.availableBins(availableEnd, bins)));
      }
    }
    for (const protocol of this.protocols) tasks.push(protocol.annotations.prepareView(start, end, Math.max(1, Math.floor(bins * this.protocolRows(protocol) * 3))));
    if (!tasks.length) { this.viewReady = true; this.drawNow(); return; }
    this.viewRefreshDirty = false;
    const task = Promise.all(tasks).then(() => true, () => false).then(ready => {
      if (this.viewRefresh === task) this.viewRefresh = null;
      if (!this.renderingEnabled || this.capture !== capture) return;
      if (!ready) return;
      const currentWidth = Math.max(300, Math.floor(this.canvas.parentElement?.clientWidth || 1000));
      if (Math.max(1, currentWidth - this.gutter - 16) !== bins) { this.schedule(); return; }
      const current = generation === this.viewGeneration && start === this.start && end === this.end;
      if (current) { this.viewReady = true; this.drawNow(); }
      if (!current || this.viewRefreshDirty) this.schedule();
    });
    this.viewRefresh = task;
  }
  drawNow(): number {
    if (!this.renderingEnabled) return 0;
    if (this.capture && !this.viewReady) return 0;
    if (this.pending) { cancelAnimationFrame(this.frameRequest); this.pending = false; }
    const started = performance.now(); const capture = this.capture;
    this.width = Math.max(300, Math.floor(this.canvas.parentElement?.clientWidth || 1000));
    const scrolling = this.scrollDraggedRow(), layout = this.rowLayout();
    const height = Math.max(270, this.waveformTop() + layout.reduce((sum, row) => sum + row.height, 0)), dpr = window.devicePixelRatio || 1;
    this.canvas.style.height = height + 'px';
    const pixelWidth = Math.round(this.width * dpr), pixelHeight = Math.round(height * dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) { this.canvas.width = pixelWidth; this.canvas.height = pixelHeight; }
    if (this.frameCanvas.width !== pixelWidth || this.frameCanvas.height !== pixelHeight) { this.frameCanvas.width = pixelWidth; this.frameCanvas.height = pixelHeight; }
    const ctx = this.frameContext;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.setLineDash([]); ctx.lineCap = 'butt'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.palette['bg']; ctx.fillRect(0, 0, this.width, height);
    if (!capture) { this.presentFrame(); return performance.now() - started; }
    const { store, triggerSample } = capture, plotWidth = Math.max(1, this.width - this.gutter - 16);
    const toX = (sample: bigint): number => this.gutter + sampleRatio(sample - this.start, this.end - this.start) * plotWidth;
    ctx.font = '11px ui-monospace, Consolas, monospace'; ctx.textBaseline = 'middle';
    const ticks = Math.max(2, Math.min(8, Math.floor(plotWidth / 115)));
    const tickResolution = Number(this.end - this.start) / ticks / store.samplerate;
    for (let i = 0; i <= ticks; i++) {
      const x = this.gutter + plotWidth * i / ticks, sample = this.start + (this.end - this.start) * BigInt(i) / BigInt(ticks);
      ctx.strokeStyle = this.palette['grid']; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + .5, this.axisHeight()); ctx.lineTo(x + .5, height); ctx.stroke();
      ctx.fillStyle = this.palette['axis']; ctx.textAlign = i === ticks ? 'right' : 'left'; ctx.fillText(timeLabel(Number(sample - triggerSample) / store.samplerate, tickResolution), x + (i === ticks ? -3 : 4), 16);
    }
    ctx.textAlign = 'left';
    const now = performance.now(), floating = this.rowDrag?.moved ? rowKey(this.rowDrag.entry) : null;
    for (const row of layout) if (rowKey(row.entry) !== floating) this.drawTimelineRow(ctx, row, this.motionTop(row, now), toX, plotWidth);
    if (floating) {
      const row = layout.find(row => rowKey(row.entry) === floating)!;
      ctx.fillStyle = this.palette['cursor']; ctx.globalAlpha = .1; ctx.fillRect(0, row.top, this.width - 16, row.height); ctx.globalAlpha = 1;
      ctx.strokeStyle = this.palette['cursor']; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(4, row.top); ctx.lineTo(this.width - 16, row.top); ctx.stroke();
      const top = this.floatingTop();
      ctx.save(); ctx.shadowColor = this.palette['cursor']; ctx.shadowBlur = 12; ctx.fillStyle = this.palette['bg']; ctx.fillRect(4, top, this.width - 20, row.height); ctx.shadowBlur = 0;
      ctx.globalAlpha = .94; ctx.translate(4, 0); this.drawTimelineRow(ctx, row, top, toX, plotWidth); ctx.globalAlpha = 1;
      ctx.strokeStyle = this.palette['cursor']; ctx.lineWidth = 1; ctx.strokeRect(.5, top + .5, this.width - 20, row.height - 1); ctx.restore();
    }
    this.drawCursor(ctx, height, !this.axisCanvas);
    this.drawAxis(capture, dpr);
    this.drawOverview(capture, dpr);
    this.presentFrame();
    const animating = [...this.rowMotions.values()].some(motion => now - motion.started < this.motionDuration);
    if (animating || scrolling) this.schedule();
    else if (!this.rowDrag?.moved && this.rowSnapshot) { this.settleRows(); this.schedule(); }
    const elapsed = performance.now() - started; this.timings.push(elapsed); if (this.timings.length > 240) this.timings.shift(); return elapsed;
  }
  private presentFrame(): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.frameCanvas, 0, 0); ctx.globalCompositeOperation = 'source-over';
  }
  private drawTimelineRow(ctx: CanvasRenderingContext2D, row: TimelineLayoutRow, top: number, toX: (sample: bigint) => number, plotWidth: number): void {
    const snapshot = this.rowSnapshot, cached = snapshot?.rects.get(rowKey(row.entry));
    if (snapshot && cached) {
      ctx.drawImage(snapshot.canvas, 0, cached.top * snapshot.dpr, snapshot.canvas.width, cached.height * snapshot.dpr, 0, top, this.width, row.height); return;
    }
    if (row.entry.kind === 'channel') this.drawChannel(ctx, row.entry.id, top, plotWidth);
    else if (row.entry.kind === 'analog') this.drawAnalog(ctx, row.entry.id, top, plotWidth);
    else this.drawProtocol(ctx, this.protocols.find(protocol => protocol.id === row.entry.id)!, top, toX, plotWidth);
  }
  private drawChannel(ctx: CanvasRenderingContext2D, channel: number, top: number, plotWidth: number): void {
    const capture = this.capture!, store = capture.store, y = top + 5, highY = y + 8, lowY = y + 30, color = this.palette.channels[channel % this.palette.channels.length];
    ctx.fillStyle = this.palette['label-bg']; ctx.fillRect(0, y - 5, this.gutter - 12, 46);
    this.drawGrip(ctx, y - 5, 46, this.rowDrag?.entry.kind === 'channel' && this.rowDrag.entry.id === channel);
    ctx.fillStyle = color; ctx.fillRect(14, y + 5, 3, 25);
    ctx.font = '600 12px system-ui, sans-serif'; ctx.fillText(`D${channel}`, 26, y + 12);
    ctx.fillStyle = this.palette['label']; ctx.font = '11px system-ui, sans-serif'; ctx.fillText(capture.labels[channel].slice(0, 12), 26, y + 28);
    const queryStarted = performance.now();
    const availableEnd = minSample(store.length, this.end);
    if (availableEnd <= this.start) {
      ctx.strokeStyle = this.palette['divider']; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y + 46); ctx.lineTo(this.width, y + 46); ctx.stroke();
      return;
    }
    const view = typeof (store as typeof store & { prepareView?: unknown }).prepareView === 'function'
      ? store.query(channel, this.start, this.end, plotWidth)
      : store.query(channel, this.start, availableEnd, this.availableBins(availableEnd, plotWidth));
    const exactEdges = this.end - this.start < plotWidth ? store.edges(channel, this.start, this.end) : undefined;
    const samples = this.sampleRange(store.length, plotWidth);
    this.recordQuery?.(performance.now() - queryStarted);
    this.drawDigital(ctx, view, highY, lowY, color, exactEdges);
    if (samples) this.drawDigitalPoints(ctx, view, highY, lowY, color);
    ctx.strokeStyle = this.palette['divider']; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y + 46); ctx.lineTo(this.width, y + 46); ctx.stroke();
  }
  private drawAnalog(ctx: CanvasRenderingContext2D, channel: number, top: number, plotWidth: number): void {
    const capture = this.capture!, item = capture.analogChannels![channel]!, y = top + 5;
    const color = this.palette.channels[(channel + (capture.logicChannelCount ?? 0)) % this.palette.channels.length];
    ctx.fillStyle = this.palette['label-bg']; ctx.fillRect(0, y - 5, this.gutter - 12, 46);
    ctx.fillStyle = color; ctx.fillRect(14, y + 5, 3, 25);
    ctx.font = '600 12px system-ui, sans-serif'; ctx.fillText(`A${channel}`, 26, y + 12);
    ctx.fillStyle = this.palette['label']; ctx.font = '11px system-ui, sans-serif'; ctx.fillText(item.name.slice(0, 12), 26, y + 28);
    const queryStarted = performance.now(), scale = 22, center = y + 20;
    const pointY = (value: number): number => center - Math.max(-1, Math.min(1, value)) * scale;
    ctx.fillStyle = color; ctx.strokeStyle = color;
    const samples = this.sampleRange(item.store.length, plotWidth, ANALOG_LINE_MIN_PIXELS);
    if (samples) {
      const points: AnalogColumnView = item.store.query(samples.start, samples.end, samples.count);
      this.recordQuery?.(performance.now() - queryStarted);
      ctx.lineWidth = ANALOG_LINE_WIDTH; ctx.beginPath();
      let lastY = 0;
      for (let i = 0; i < points.bins; i++) {
        const x = this.xAtSample(points.startSample + BigInt(i)), sampleY = pointY(points.low[i]!);
        if (i) ctx.lineTo(x, sampleY);
        else { ctx.moveTo(this.gutter, sampleY); ctx.lineTo(x, sampleY); }
        lastY = sampleY;
      }
      if (samples.end === this.end) ctx.lineTo(this.width - 16, lastY);
      ctx.stroke();
      if (plotWidth / Number(this.end - this.start) >= SAMPLE_POINT_GAP) {
        ctx.beginPath();
        for (let i = 0; i < points.bins; i++) {
          const x = this.xAtSample(points.startSample + BigInt(i)), sampleY = pointY(points.low[i]!);
          ctx.moveTo(x + SAMPLE_POINT_RADIUS, sampleY); ctx.arc(x, sampleY, SAMPLE_POINT_RADIUS, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    } else if (this.start < minSample(item.store.length, this.end)) {
      const availableEnd = minSample(item.store.length, this.end);
      const view: AnalogColumnView = item.store.query(this.start, availableEnd, this.availableBins(availableEnd, plotWidth));
      this.recordQuery?.(performance.now() - queryStarted);
      const viewSpan = view.endSample - view.startSample;
      const xAt = (index: number): number => this.xAtSample(view.startSample + viewSpan * BigInt(index) / BigInt(view.bins));
      let first = 0, previousLow = 0, previousHigh = 0;
      for (let i = 0; i <= view.bins; i++) {
        const low = i < view.bins ? pointY(view.low[i]!) : 0;
        const high = i < view.bins ? pointY(view.high[i]!) : 0;
        if (i === 0) { previousLow = low; previousHigh = high; }
        else if (i === view.bins || low !== previousLow || high !== previousHigh) {
          const rawHeight = previousLow - previousHigh, height = Math.max(ANALOG_LINE_WIDTH, rawHeight);
          ctx.fillRect(xAt(first), previousHigh - (height - rawHeight) / 2, xAt(i) - xAt(first), height);
          first = i; previousLow = low; previousHigh = high;
        }
      }
    }
    ctx.strokeStyle = this.palette['divider']; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y + 46); ctx.lineTo(this.width, y + 46); ctx.stroke();
  }
  private drawDigital(ctx: CanvasRenderingContext2D, view: ColumnView, highY: number, lowY: number, color: string, exactEdges?: bigint[]): void {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    const viewSpan = view.endSample - view.startSample;
    const xAt = (index: number): number => this.xAtSample(view.startSample + viewSpan * BigInt(index) / BigInt(view.bins));
    for (const high of [true, false]) {
      const y = high ? highY : lowY; let first = -1;
      for (let i = 0; i <= view.bins; i++) {
        const active = i < view.bins && !(view.packed[i] & 8) && (high ? view.high[i] === 1 : view.low[i] === 0);
        if (active && first < 0) first = i;
        if (!active && first >= 0) { ctx.moveTo(xAt(first), y); ctx.lineTo(xAt(i), y); first = -1; }
      }
    }
    if (exactEdges) {
      for (const sample of exactEdges) {
        const x = Math.round(this.xAtSample(sample)) + .5;
        if (x >= this.gutter && x <= this.width - 16) {
          ctx.moveTo(x, highY); ctx.lineTo(x, lowY);
        }
      }
    }
    ctx.stroke();
    if (!exactEdges) {
      let first = -1;
      for (let i = 0; i <= view.bins; i++) {
        const active = i < view.bins && !(view.packed[i] & 8) && view.edge[i] === 1;
        if (active && first < 0) first = i;
        if (!active && first >= 0) { ctx.fillRect(xAt(first), highY, xAt(i) - xAt(first), lowY - highY); first = -1; }
      }
    }
  }
  private drawDigitalPoints(ctx: CanvasRenderingContext2D, view: ColumnView, highY: number, lowY: number, color: string): void {
    if (!view.points?.length) return;
    ctx.fillStyle = color; ctx.beginPath();
    for (let i = 0; i < view.points.length; i++) {
      const sample = view.startSample + BigInt(i);
      if (sample < this.start || sample >= this.end) continue;
      const x = this.xAtSample(sample), y = view.points[i] ? highY : lowY;
      ctx.moveTo(x + SAMPLE_POINT_RADIUS, y); ctx.arc(x, y, SAMPLE_POINT_RADIUS, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  private sampleRange(length: bigint, plotWidth: number, gap = SAMPLE_POINT_GAP): { start: bigint; end: bigint; count: number } | null {
    const start = maxSample(0n, this.start), end = minSample(length, this.end), limit = BigInt(Math.floor(plotWidth / gap));
    if (end <= start || this.end - this.start > limit) return null;
    return { start, end, count: Number(end - start) };
  }
  private availableBins(availableEnd: bigint, plotWidth: number): number {
    const span = this.end - this.start;
    if (span <= 0n || availableEnd <= this.start) return 1;
    return Math.max(1, Number(BigInt(plotWidth) * (availableEnd - this.start) / span));
  }
  private drawCursor(ctx: CanvasRenderingContext2D, height: number, label: boolean): void {
    if (!this.capture) return;
    const rate = this.capture.store.samplerate, trigger = this.capture.triggerSample;
    const samples = [this.cursorA, this.cursorB].filter((sample): sample is bigint => sample !== null && sample >= this.start && sample < this.end).sort(compareSamples);
    ctx.save(); ctx.font = (samples.length > 1 ? '10px' : '11px') + ' ui-monospace, Consolas, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const labels = samples.map(sample => {
      const x = this.xAtSample(sample), text = timeLabel(Number(sample - trigger) / rate, this.timeResolution()), width = ctx.measureText(text).width + 14;
      return { x, text, width, left: Math.max(this.gutter, Math.min(this.width - 16 - width, x - width / 2)) };
    });
    if (labels.length === 2 && labels[0].left + labels[0].width + 6 > labels[1].left) {
      labels[0].left = Math.max(this.gutter, Math.min(labels[0].left, this.width - 22 - labels[1].width - labels[0].width));
      labels[1].left = Math.min(this.width - 16 - labels[1].width, Math.max(labels[1].left, labels[0].left + labels[0].width + 6));
    }
    for (const { x, text, width, left } of labels) {
      ctx.strokeStyle = this.palette['cursor']; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(x, label ? 28 : 0); ctx.lineTo(x, height); ctx.stroke(); ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = this.palette['cursor']; ctx.fillRect(left, 2, width, 22);
        ctx.beginPath(); ctx.moveTo(x - 4, 24); ctx.lineTo(x, 28); ctx.lineTo(x + 4, 24); ctx.fill();
        ctx.fillStyle = this.palette['bg']; ctx.fillText(text, left + 7, 13);
      }
    }
    if (label && this.cursorA !== null && this.cursorB !== null) {
      const delta = Number(absSample(this.cursorB - this.cursorA)) / rate;
      const text = t('wave.delta') + ': ' + timeLabel(delta) + ' · ' + t('wave.frequency') + ': ' + frequencyLabel(delta > 0 ? 1 / delta : Infinity);
      const left = Math.max(this.gutter, Math.min(this.width - 16, this.xAtSample(minSample(this.cursorA, this.cursorB))));
      const right = Math.max(this.gutter, Math.min(this.width - 16, this.xAtSample(maxSample(this.cursorA, this.cursorB))));
      ctx.strokeStyle = this.palette['cursor']; ctx.beginPath(); ctx.moveTo(left, 39); ctx.lineTo(left, 49); ctx.moveTo(left, 44); ctx.lineTo(right, 44); ctx.moveTo(right, 39); ctx.lineTo(right, 49); ctx.stroke();
      ctx.font = '10px ui-monospace, Consolas, monospace'; const width = Math.min(this.width - this.gutter - 16, ctx.measureText(text).width + 12);
      const center = Math.max(this.gutter + width / 2, Math.min(this.width - 16 - width / 2, (left + right) / 2));
      ctx.fillStyle = this.palette['bg']; ctx.fillRect(center - width / 2, 33, width, 22);
      ctx.fillStyle = this.palette['cursor']; ctx.textAlign = 'center'; ctx.fillText(text, center, 44, width - 8);
    }
    ctx.restore();
  }
  private drawProtocol(ctx: CanvasRenderingContext2D, protocol: ProtocolTrace, annY: number, toX: (sample: bigint) => number, plotWidth: number): void {
    ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const definition = decoderDefinition(protocol.decoder), rowDefinitions = definition.ui.rows;
    const rows = this.protocolRows(protocol), rowHeight = 32, height = this.protocolHeight(protocol);
    ctx.save(); ctx.textAlign = 'left';
    for (let row = 0; row < rows; row++) {
      const y = annY + row * rowHeight;
      ctx.fillStyle = this.palette['label-bg']; ctx.fillRect(0, y, this.gutter - 12, rowHeight - 2);
      this.drawGrip(ctx, y, rowHeight - 2, this.rowDrag?.entry.kind === 'protocol' && this.rowDrag.entry.id === protocol.id);
      ctx.fillStyle = protocol.color; ctx.fillRect(14, y + 2, 3, rowHeight - 4);
      ctx.save(); ctx.beginPath(); ctx.rect(23, y, this.gutter - 37, rowHeight - 2); ctx.clip();
      ctx.fillStyle = this.palette['label'];
      ctx.font = '600 10px system-ui, sans-serif'; ctx.fillText(protocol.name, 26, y + 10);
      ctx.font = '9px system-ui, sans-serif';
      const rowDefinition = rowDefinitions[row]!, rowLabel = rowDefinition.labelKey && hasMessage(rowDefinition.labelKey) ? t(rowDefinition.labelKey) : rowDefinition.label;
      ctx.fillText(rowLabel, 26, y + 23);
      ctx.restore();
      ctx.strokeStyle = this.palette['grid']; ctx.beginPath(); ctx.moveTo(this.gutter, y + rowHeight - 2); ctx.lineTo(this.width - 16, y + rowHeight - 2); ctx.stroke();
    }
    ctx.beginPath(); ctx.rect(this.gutter, annY, plotWidth, height - 4); ctx.clip();
    const queryStarted = performance.now();
    const visible = protocol.annotations.query(this.start, this.end, Math.max(1, Math.floor(plotWidth * rows * 3)));
    this.recordQuery?.(performance.now() - queryStarted);
    const rowOfClass = new Map<number, number>();
    rowDefinitions.forEach((row, index) => { for (const classIndex of row.classes) rowOfClass.set(classIndex, index); });
    const dense = visible.length > plotWidth * rows * 3;
    const occupied = Array.from({ length: rows }, () => new Set<number>());
    const merged = new Map<string, { annotation: typeof visible[number]; row: number; x: number; right: number; error: boolean }>();
    const blocks: Array<{ annotation: typeof visible[number]; row: number; x: number; right: number; merged: boolean }> = [];
    for (const annotation of visible) {
      const row = rowOfClass.get(annotation.classIndex);
      if (row === undefined) continue;
      const x = Math.max(this.gutter, toX(annotation.ss)), right = Math.min(this.width - 16, toX(annotation.es));
      const w = Math.max(2, right - x), cell = Math.floor(x);
      if (!dense && w < 8 && occupied[row].has(cell)) continue;
      if (!dense) occupied[row].add(cell);
      if (dense && w < 12) {
        const error = definition.ui.isErrorClass?.(annotation.classIndex) ?? false;
        const key = `${row}:${cell}:${error ? 1 : 0}`;
        const previous = merged.get(key);
        if (previous) { previous.x = Math.min(previous.x, x); previous.right = Math.max(previous.right, right); }
        else merged.set(key, { annotation, row, x, right, error });
      } else blocks.push({ annotation, row, x, right, merged: false });
    }
    const compact: Array<{ annotation: typeof visible[number]; row: number; x: number; right: number; error: boolean }> = [];
    for (const block of [...merged.values()].sort((a, b) => a.row - b.row || a.x - b.x)) {
      const previous = compact.at(-1);
      if (previous && previous.row === block.row && previous.error === block.error && block.x <= previous.right + 1.5) previous.right = Math.max(previous.right, block.right);
      else compact.push({ ...block });
    }
    for (const block of compact) blocks.push({ ...block, merged: true });
    for (const block of blocks) {
      const { annotation, row, x, right } = block;
      const blockHeight = Math.max(6, rowHeight - 4), w = Math.max(2, right - x), y = annY + row * rowHeight + 2;
      ctx.fillStyle = definition.ui.isErrorClass?.(annotation.classIndex) ? this.palette['annotation-error'] : protocol.color;
      ctx.globalAlpha = protocol.id === this.selectedProtocolId ? .9 : .7;
      const leftTab = Math.min(7, Math.max(2, w / 3)), rightTab = leftTab;
      const middle = y + blockHeight / 2; ctx.beginPath(); ctx.moveTo(x, middle); ctx.lineTo(x + leftTab, y); ctx.lineTo(Math.max(x + leftTab, x + w - rightTab), y); ctx.lineTo(x + w, middle); ctx.lineTo(Math.max(x + leftTab, x + w - rightTab), y + blockHeight); ctx.lineTo(x + leftTab, y + blockHeight); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      if (!block.merged && w > 8) {
        ctx.fillStyle = this.palette['annotation-text']; ctx.font = '11px system-ui, sans-serif';
        const texts = definition.ui.annotationTexts?.(annotation, {
          sampleRate: this.capture!.store.samplerate, decimals: protocol.decimalPlaces ?? 3,
          text: (key, fallback) => hasMessage(key) ? t(key) : fallback,
        }) ?? annotation.texts;
        const available = Math.max(8, w - 4), text = texts.find(value => ctx.measureText(value).width <= available); if (text) { ctx.textAlign = 'center'; ctx.fillText(text, x + w / 2, middle); ctx.textAlign = 'left'; }
      }
    }
    ctx.restore();
  }
  private drawAxis(capture: Capture, dpr: number): void {
    const target = this.axisCanvas; if (!target) return;
    const height = this.axisHeight();
    target.style.width = this.width + 'px'; target.style.height = height + 'px'; target.style.marginBottom = -height + 'px';
    if (target.width !== Math.round(this.width * dpr) || target.height !== Math.round(height * dpr)) { target.width = Math.round(this.width * dpr); target.height = Math.round(height * dpr); }
    const ctx = target.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = this.palette['bg']; ctx.fillRect(0, 0, this.width, height);
    const plotWidth = Math.max(1, this.width - this.gutter - 16), ticks = Math.max(2, Math.min(8, Math.floor(plotWidth / 115)));
    const tickResolution = Number(this.end - this.start) / ticks / capture.store.samplerate;
    ctx.font = '11px ui-monospace, Consolas, monospace'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= ticks; i++) {
      const x = this.gutter + plotWidth * i / ticks, sample = this.start + (this.end - this.start) * BigInt(i) / BigInt(ticks);
      ctx.strokeStyle = this.palette['grid']; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, height); ctx.stroke();
      ctx.fillStyle = this.palette['axis']; ctx.textAlign = i === ticks ? 'right' : 'left'; ctx.fillText(timeLabel(Number(sample - capture.triggerSample) / capture.store.samplerate, tickResolution), x + (i === ticks ? -3 : 4), 16);
    }
    this.drawCursor(ctx, height, true);
  }
  private drawOverview(capture: Capture, dpr: number): void {
    const width = Math.max(1, this.overview.clientWidth || this.width), height = 14;
    if (this.overview.width !== Math.round(width * dpr) || this.overview.height !== Math.round(height * dpr)) { this.overview.width = Math.round(width * dpr); this.overview.height = Math.round(height * dpr); }
    const ctx = this.overview.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = this.palette['overview-bg']; ctx.fillRect(0, 0, width, height);
    ctx.lineCap = 'round'; ctx.strokeStyle = this.palette['overview-line']; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(1, 7); ctx.lineTo(Math.max(1, width - 1), 7); ctx.stroke();
    const length = this.viewLength(capture), x = sampleRatio(this.start, length) * width, end = sampleRatio(this.end, length) * width;
    const selectionWidth = Math.min(width, Math.max(10, end - x));
    const left = Math.max(0, Math.min(width - selectionWidth, (x + end - selectionWidth) / 2));
    ctx.fillStyle = this.palette['overview-selection']; ctx.fillRect(left, 1, selectionWidth, height - 2);
    ctx.strokeStyle = this.palette['overview-border']; ctx.lineWidth = 2;
    ctx.strokeRect(left + 1, 2, selectionWidth - 2, height - 4);
    if (selectionWidth >= 28) {
      const center = left + selectionWidth / 2; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const offset of [-2, 2]) { ctx.moveTo(center + offset, 5); ctx.lineTo(center + offset, 9); }
      ctx.stroke();
    }
  }
  private recordQuery(elapsed: number): void {
    this.queryTimings.push(elapsed); if (this.queryTimings.length > 240) this.queryTimings.shift();
    this.queryCalls++; this.queryTotalMs += elapsed; this.queryMaxMs = Math.max(this.queryMaxMs, elapsed);
  }
  dispose(): void { window.removeEventListener('hakei:themechange', this.themeChanged); this.observer.disconnect(); this.settleRows(); cancelAnimationFrame(this.frameRequest); this.pending = false; }
  metrics(): { frames: number; p50Ms: number; p95Ms: number; maxMs: number; queryCalls: number; queryTotalMs: number; queryMaxMs: number; queryP95Ms: number; renderNonQueryJsMs: number } {
    const values = [...this.timings].sort((a,b) => a-b), queries = [...this.queryTimings].sort((a,b) => a-b), total = this.timings.reduce((sum, value) => sum + value, 0), queryWindowTotal = this.queryTimings.reduce((sum, value) => sum + value, 0);
    return {
      frames: values.length,
      p50Ms: values[Math.floor(values.length * .5)] ?? 0,
      p95Ms: values[Math.min(values.length - 1, Math.floor(values.length * .95))] ?? 0,
      maxMs: Math.max(...values, 0),
      queryCalls: this.queryCalls,
      queryTotalMs: this.queryTotalMs,
      queryMaxMs: this.queryMaxMs,
      queryP95Ms: queries[Math.min(queries.length - 1, Math.floor(queries.length * .95))] ?? 0,
      renderNonQueryJsMs: Math.max(0, total - queryWindowTotal),
    };
  }
}
