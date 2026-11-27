import {
  samplePosition,
  sampleFloor,
  sampleCeil,
  minSample,
  maxSample,
  absSample,
  compareSamples,
  scaleSamples,
  sampleRatio,
  rescaleSample,
  type SampleInput,
} from '../libhakei/sample-index.js';
import type { DecoderId } from './protocol.js';
import type { ProtocolSettings } from './workspace.js';
import { decoderDefinition, decoderDefinitions } from '../decoders/index.js';
import {
  contrastTextForHex,
  isDarkColor,
  normalizeHiddenRows,
  protocolTrackColor,
  visibleProtocolRows,
} from './protocol-tracks.js';
import type { Capture } from './capture.js';
import type { AnalogColumnView, AnalogStore } from './data/analogStore.js';
import type { ColumnView } from './data/types.js';
import { AnnotationIndex } from './event-index.js';
import { readPalette } from './theme.js';
import { hasMessage, t } from './i18n.js';
import { rowKey, reconcileRowOrder, moveTimelineRow, type TimelineRow } from './timeline.js';
import {
  analogAxis,
  analogHeight,
  defaultAnalogSettings,
  parseAnalogSettings,
  type AnalogSettings,
} from './analog-settings.js';
const timeUnits = [
  [1e-15, 'fs'],
  [1e-12, 'ps'],
  [1e-9, 'ns'],
  [1e-6, 'µs'],
  [1e-3, 'ms'],
  [1, 's'],
  [1e3, 'ks'],
  [1e6, 'Ms'],
  [1e9, 'Gs'],
  [1e12, 'Ts'],
  [1e15, 'Ps'],
  [1e18, 'Es'],
] as const;
const SAMPLE_POINT_GAP = 3,
  SAMPLE_POINT_RADIUS = 1.75,
  ANALOG_LINE_WIDTH = 1.5,
  ANALOG_LINE_MIN_PIXELS = 0.25,
  MIN_VIEW_SAMPLES = 2n;
export function voltageLabel(value: number): string {
  const magnitude = Math.abs(value),
    units = [
      [1e9, 'GV'],
      [1e6, 'MV'],
      [1e3, 'kV'],
      [1, 'V'],
      [1e-3, 'mV'],
      [1e-6, 'µV'],
      [1e-9, 'nV'],
      [1e-12, 'pV'],
    ] as const;
  const [scale, unit] =
    magnitude === 0 ? units[3] : (units.find(([scale]) => magnitude >= scale) ?? units[units.length - 1]);
  return `${Number((value / scale).toPrecision(4))} ${unit}`;
}
export function timeLabel(seconds: number, resolutionSeconds?: number, digits = 3): string {
  const basis = Math.abs(resolutionSeconds ?? (seconds || 1e-9));
  let index = 0;
  while (index < timeUnits.length - 1 && basis >= timeUnits[index + 1][0]) index++;
  while (index < timeUnits.length - 1 && Number((Math.abs(seconds) / timeUnits[index][0]).toFixed(digits)) >= 1000)
    index++;
  const [scale, unit] = timeUnits[index],
    text = (seconds / scale).toFixed(digits);
  return (Number(text) === 0 ? (0).toFixed(digits) : text) + ' ' + unit;
}
export function frequencyLabel(hz: number, digits = 3): string {
  if (!Number.isFinite(hz)) return '∞ Hz';
  const units = ['Hz', 'kHz', 'MHz', 'GHz', 'THz', 'PHz', 'EHz'];
  let index = 0;
  while (index < units.length - 1 && Number((Math.abs(hz) / 1000 ** index).toFixed(digits)) >= 1000) index++;
  return (hz / 1000 ** index).toFixed(digits) + ' ' + units[index];
}
export interface TimelineLayoutRow {
  entry: TimelineRow;
  top: number;
  height: number;
}
export interface ProtocolTrace extends ProtocolSettings {
  annotations: AnnotationIndex;
  readonly frameCount?: number;
  readonly state?: string;
}
export class WaveformRenderer {
  decoder: DecoderId = decoderDefinitions[0]?.descriptor.id ?? '';
  capture: Capture | null = null;
  protocols: ProtocolTrace[] = [];
  selectedProtocolId: string | null = null;
  private readonly fallbackAnnotations = new AnnotationIndex();
  get annotations(): AnnotationIndex {
    return this.protocols.find((p) => p.id === this.selectedProtocolId)?.annotations ?? this.fallbackAnnotations;
  }
  channels: number[] = [];
  digitalHeights: number[] = [];
  analogChannels: number[] = [];
  analogSettings: AnalogSettings[] = [];
  rowOrder: TimelineRow[] = [];
  start = 0n;
  end = 1n;
  cursorA: bigint | null = null;
  cursorB: bigint | null = null;
  get cursor(): bigint | null {
    return this.cursorA;
  }
  set cursor(value: bigint | null) {
    this.cursorA = value;
  }
  cursorMode = false;
  onAnnotationClick: (id: string, ss: bigint, es: bigint) => void = () => {};
  onChange: () => void = () => {};
  onProtocolOrderChange: () => void = () => {};
  onAnalogSettings: (channel: number) => void = () => {};
  onDigitalSettings: (channel: number) => void = () => {};
  onProtocolSettings: (id: string) => void = () => {};
  onToggleProtocolCollapse: (id: string) => void = () => {};
  onToggleProtocolRow: (id: string, rowId: string, visible: boolean) => void = () => {};
  private readonly settingsLayer = document.createElement('div');
  private readonly settingsButtons = new Map<string, HTMLButtonElement>();
  private readonly collapseButtons = new Map<string, HTMLButtonElement>();
  private readonly trackHideButtons = new Map<string, HTMLButtonElement>();
  private pending = false;
  private viewRefresh: Promise<void> | null = null;
  private viewRefreshDirty = false;
  private viewRefreshFailures = 0;
  private viewRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private viewReady = true;
  private viewGeneration = 0;
  private renderingEnabled = true;
  private frameRequest = 0;
  private readonly observer: ResizeObserver;
  private draggingCursor = false;
  private pointerStart: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; start: bigint; end: bigint; scrollLeft: number; scrollTop: number } | null =
    null;
  private cursorDrag: 'a' | 'b' | null = null;
  private cursorRange: { startX: number; moved: boolean } | null = null;
  private rowDrag: {
    entry: TimelineRow;
    startY: number;
    clientY: number;
    y: number;
    offset: number;
    moved: boolean;
  } | null = null;
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
  private presentedViewport: readonly [bigint, bigint] | null = null;
  private presentedSamples = 0n;
  private lastRefreshViewport: readonly [bigint, bigint] | null = null;
  private hoverX: number | null = null;
  private hoverSample: bigint | null = null;
  private hoverResult: { capture: Capture; sample: bigint; length: bigint; values: readonly (number | null)[] } | null =
    null;
  private hoverPending = false;
  private hoverFrame = 0;
  private readonly themeChanged = (): void => {
    this.palette = readPalette();
    this.schedule();
  };
  readonly gutter = 136;
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly overview: HTMLCanvasElement,
    readonly axisCanvas?: HTMLCanvasElement,
  ) {
    window.addEventListener('hakei:themechange', this.themeChanged);
    const scroll = canvas.parentElement!;
    this.settingsLayer.className = 'wave-row-settings';
    scroll.append(this.settingsLayer);
    this.observer = new ResizeObserver(() => this.invalidateView());
    this.observer.observe(scroll);
    scroll.addEventListener(
      'wheel',
      (event) => {
        if (!this.capture) return;
        event.preventDefault();
        const rect = scroll.getBoundingClientRect();
        const x = event.clientX - rect.left + scroll.scrollLeft;
        this.moveHover(x);
        const anchor = (x - this.gutter) / (this.width - this.gutter - 16);
        this.zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * 0.006), anchor);
      },
      { passive: false },
    );
    const target = canvas;
    target.addEventListener('pointerdown', (event) => {
      if (!this.capture || event.button !== 0 || this.pointerId !== null) return;
      this.pointerId = event.pointerId;
      const rect = target.getBoundingClientRect(),
        x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      this.pointerStart = { x, y };
      target.setPointerCapture(event.pointerId);
      const row = this.rowAt(x, y);
      if (row) {
        this.settleRows();
        this.rowDrag = {
          entry: row.entry,
          startY: event.clientY,
          clientY: event.clientY,
          y,
          offset: y - row.top,
          moved: false,
        };
        this.schedule();
        return;
      }
      if (x < this.gutter) return;
      if (this.cursorMode) {
        const sample = minSample(this.capture.store.length - 1n, this.sampleAtX(event.offsetX));
        this.cursorA = sample;
        this.cursorB = null;
        this.cursorRange = { startX: event.clientX, moved: false };
        this.draggingCursor = true;
        this.onChange();
        this.schedule();
      } else {
        this.cursorDrag = this.nearestCursor(event.offsetX, event.offsetY < this.axisHeight());
        if (this.cursorDrag) {
          this.draggingCursor = true;
          this.setCursor(event.offsetX, this.cursorDrag);
        } else {
          const scroll = this.canvas.parentElement!;
          this.drag = {
            x: event.clientX,
            y: event.clientY,
            start: this.start,
            end: this.end,
            scrollLeft: scroll.scrollLeft,
            scrollTop: scroll.scrollTop,
          };
        }
      }
    });
    target.addEventListener('pointermove', (event) => {
      const rect = target.getBoundingClientRect(),
        x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      this.moveHover(x);
      if (this.pointerId === null) {
        target.style.cursor = this.rowAt(x, y) ? 'grab' : this.cursorMode ? 'crosshair' : 'grab';
        return;
      }
      if (this.pointerId !== event.pointerId) return;
      if (this.rowDrag) {
        this.rowDrag.clientY = event.clientY;
        this.rowDrag.y = event.clientY - this.canvas.getBoundingClientRect().top;
        if (!this.rowDrag.moved && Math.abs(event.clientY - this.rowDrag.startY) >= 4) {
          this.snapshotRows();
          this.rowDrag.moved = true;
        }
        if (this.rowDrag.moved) {
          target.style.cursor = 'grabbing';
          this.reorderRow(this.rowDrag.y);
          this.schedule();
        }
      } else if (this.cursorRange) {
        if (Math.abs(event.clientX - this.cursorRange.startX) >= 3) this.cursorRange.moved = true;
        if (this.cursorRange.moved) this.setCursor(event.offsetX, 'b');
      } else if (this.draggingCursor && this.cursorDrag) this.setCursor(event.offsetX, this.cursorDrag);
      else if (this.drag) {
        const amount = scaleSamples(
          this.drag.end - this.drag.start,
          (this.drag.x - event.clientX) / (this.width - this.gutter - 16),
        );
        this.setViewport(this.drag.start + amount, this.drag.end + amount);
        const scroll = this.canvas.parentElement!;
        scroll.scrollLeft = Math.max(0, this.drag.scrollLeft + this.drag.x - event.clientX);
        scroll.scrollTop = Math.max(0, this.drag.scrollTop + this.drag.y - event.clientY);
      }
    });
    target.addEventListener('pointerup', (event) => {
      if (this.pointerId !== event.pointerId) return;
      const begin = this.pointerStart;
      const rect = target.getBoundingClientRect(),
        x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      if (this.cursorRange?.moved) this.setCursor(event.offsetX, 'b');
      if (
        begin &&
        !this.draggingCursor &&
        !this.rowDrag?.moved &&
        Math.abs(x - begin.x) < 4 &&
        Math.abs(y - begin.y) < 4
      )
        this.selectAnnotation(x, y);
      this.finishPointer(target);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    });
    target.addEventListener('pointercancel', () => this.finishPointer(target));
    target.addEventListener('pointerleave', () => this.moveHover(null));
    target.addEventListener('lostpointercapture', () => {
      if (this.pointerId !== null) this.finishPointer(target);
    });
    overview.addEventListener('pointerdown', (event) => {
      if (!this.capture || event.button !== 0) return;
      overview.setPointerCapture(event.pointerId);
      this.overviewDrag = { pointerId: event.pointerId };
      this.moveOverview(event);
    });
    overview.addEventListener('pointermove', (event) => {
      if (this.overviewDrag?.pointerId === event.pointerId) this.moveOverview(event);
    });
    overview.addEventListener('pointerup', (event) => {
      if (this.overviewDrag?.pointerId === event.pointerId) this.overviewDrag = null;
    });
    overview.addEventListener('pointercancel', () => {
      this.overviewDrag = null;
    });
    overview.addEventListener('lostpointercapture', () => {
      this.overviewDrag = null;
    });
  }
  setCapture(capture: Capture, viewport?: readonly [SampleInput, SampleInput]): void {
    this.clearHover();
    this.viewRefreshFailures = 0;
    if (this.viewRefreshRetryTimer !== null) {
      clearTimeout(this.viewRefreshRetryTimer);
      this.viewRefreshRetryTimer = null;
    }
    this.capture = capture;
    this.channels = Array.from({ length: capture.logicChannelCount ?? capture.store.channelCount }, (_, i) => i);
    this.digitalHeights = this.channels.map((id) => capture.workspace?.digitalHeights?.[id] ?? 22);
    this.analogChannels = Array.from({ length: capture.analogChannels?.length ?? 0 }, (_, i) => i);
    this.analogSettings = this.analogChannels.map(
      (id) =>
        capture.workspace?.analogSettings?.[id] ??
        defaultAnalogSettings(
          this.palette.channels[(id + (capture.logicChannelCount ?? 0)) % this.palette.channels.length],
        ),
    );
    this.rowOrder = this.channels.map((id) => ({ kind: 'channel', id }));
    this.settleRows();
    this.annotations.clear();
    this.cursorA = null;
    this.cursorB = null;
    this.cursorMode = false;
    const limit = this.viewLength(capture);
    let start = 0n,
      end = limit;
    if (viewport) {
      try {
        const requestedStart = sampleFloor(viewport[0]),
          requestedEnd = sampleCeil(viewport[1]);
        if (requestedStart >= 0n && requestedEnd > requestedStart && requestedEnd <= limit) {
          start = requestedStart;
          end = requestedEnd;
        }
      } catch {}
    }
    this.applyViewport(start, end);
  }
  clearCapture(): void {
    this.clearHover();
    this.viewRefreshFailures = 0;
    if (this.viewRefreshRetryTimer !== null) {
      clearTimeout(this.viewRefreshRetryTimer);
      this.viewRefreshRetryTimer = null;
    }
    this.capture = null;
    this.channels = [];
    this.digitalHeights = [];
    this.analogChannels = [];
    this.analogSettings = [];
    this.rowOrder = [];
    this.start = 0n;
    this.end = 1n;
    this.cursorA = null;
    this.cursorB = null;
    this.cursorMode = false;
    this.viewGeneration++;
    this.viewReady = true;
    this.schedule();
    this.onChange();
  }

  updateCapture(capture: Capture): void {
    this.capture = capture;
    if (capture.acquisition?.mode === 'continuous') this.hoverResult = null;
    if (this.end > this.viewLength(capture)) this.applyViewport(this.start, this.end);
    else this.schedule();
  }
  setAnalogSettings(channel: number, settings: AnalogSettings): void {
    if (!this.analogSettings[channel]) throw new RangeError('Analog channel out of range');
    this.analogSettings[channel] = parseAnalogSettings(settings);
    this.settleRows();
    this.invalidateView();
  }
  setDigitalHeight(channel: number, height: number): void {
    if (this.digitalHeights[channel] === undefined || !Number.isInteger(height) || height < 12 || height > 250)
      throw new RangeError('Invalid digital channel height');
    this.digitalHeights[channel] = height;
    this.settleRows();
    this.schedule();
  }
  setViewport(startInput: SampleInput, endInput: SampleInput): void {
    this.applyViewport(startInput, endInput);
  }
  private applyViewport(startInput: SampleInput, endInput: SampleInput): void {
    if (!this.capture) return;
    let start: bigint, end: bigint;
    try {
      start = sampleFloor(startInput);
      end = sampleCeil(endInput);
    } catch {
      return;
    }
    const length = this.viewLength(this.capture),
      span = maxSample(minSample(MIN_VIEW_SAMPLES, length), minSample(length, end - start));
    const nextStart = maxSample(0n, minSample(length - span, start)),
      nextEnd = nextStart + span,
      changed = nextStart !== this.start || nextEnd !== this.end;
    this.start = nextStart;
    this.end = nextEnd;
    this.onChange();
    if (changed) this.invalidateView();
    else this.schedule();
  }
  private invalidateView(): void {
    this.viewGeneration++;
    this.viewReady = false;
    this.schedule();
  }
  zoom(factor: number, anchor = 0.5): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const bounded = Math.max(0, Math.min(1, anchor)),
      span = this.end - this.start;
    const point = this.start + scaleSamples(span, bounded),
      scaled = scaleSamples(span, 1 / factor);
    const next = factor < 1 ? maxSample(span + 1n, scaled) : maxSample(1n, scaled);
    const start = point - scaleSamples(next, bounded);
    this.setViewport(start, start + next);
  }
  pan(samples: SampleInput): void {
    const delta = samplePosition(samples);
    this.setViewport(this.start + delta, this.end + delta);
  }
  fit(): void {
    if (this.capture) this.setViewport(0n, this.viewLength(this.capture));
  }
  focus(ss: bigint, es: bigint): void {
    const pad = maxSample(32n, ((es - ss) * 3n) / 2n);
    this.setViewport(ss - pad, es + pad);
  }
  sampleAtX(x: number): bigint {
    return (
      this.start +
      scaleSamples(this.end - this.start, Math.max(0, Math.min(1, (x - this.gutter) / (this.width - this.gutter - 16))))
    );
  }
  xAtSample(sample: SampleInput): number {
    return (
      this.gutter +
      sampleRatio(samplePosition(sample) - this.start, this.end - this.start) *
        Math.max(1, this.width - this.gutter - 16)
    );
  }
  timeResolution(): number {
    if (!this.capture) return 1;
    const plotWidth = Math.max(1, this.width - this.gutter - 16),
      ticks = Math.max(2, Math.min(8, Math.floor(plotWidth / 115)));
    return Number(this.end - this.start) / ticks / this.capture.store.samplerate;
  }
  private viewLength(capture: Capture | null = this.capture): bigint {
    return capture?.acquisition?.stopReason === 'complete'
      ? capture.acquisition.targetSamples
      : (capture?.store.length ?? 0n);
  }
  private setCursor(x: number, which: 'a' | 'b' = 'a'): void {
    if (!this.capture) return;
    const sample = minSample(this.capture.store.length - 1n, this.sampleAtX(x));
    if (which === 'b') this.cursorB = sample;
    else this.cursorA = sample;
    this.onChange();
    this.schedule();
  }
  private axisHeight(): number {
    return this.cursorA !== null && this.cursorB !== null ? 60 : 30;
  }
  private waveformTop(): number {
    return this.axisHeight() + 8;
  }
  private visibleRowsFor(protocol: ProtocolTrace) {
    return visibleProtocolRows(decoderDefinition(protocol.decoder), protocol);
  }
  private protocolRows(protocol: ProtocolTrace): number {
    return this.visibleRowsFor(protocol).length;
  }
  private annotationQueryBudget(bins: number, rows: number): number {
    return Math.min(4_000, Math.max(512, Math.floor(bins * Math.min(Math.max(1, rows), 3))));
  }
  private protocolHeight(protocol: ProtocolTrace): number {
    return 28 + this.protocolRows(protocol) * 28 + 4;
  }
  getRowOrder(): TimelineRow[] {
    const count = this.capture ? (this.capture.logicChannelCount ?? this.capture.store.channelCount) : 0;
    const channels = [
      ...this.channels,
      ...Array.from({ length: count }, (_, id) => id).filter((id) => !this.channels.includes(id)),
    ];
    this.rowOrder = reconcileRowOrder(
      this.rowOrder,
      channels,
      this.protocols.map((p) => p.id),
      Array.from({ length: this.capture?.analogChannels?.length ?? 0 }, (_, id) => id),
    );
    const visible = new Set(this.channels);
    this.channels = this.rowOrder.flatMap((row) => (row.kind === 'channel' && visible.has(row.id) ? [row.id] : []));
    const analogVisible = new Set(this.analogChannels);
    this.analogChannels = this.rowOrder.flatMap((row) =>
      row.kind === 'analog' && analogVisible.has(row.id) ? [row.id] : [],
    );
    return this.rowOrder.map((row) => ({ ...row }));
  }
  rowLayout(): TimelineLayoutRow[] {
    const visible = new Set(this.channels),
      analogVisible = new Set(this.analogChannels),
      protocols = new Map(this.protocols.map((p) => [p.id, p]));
    let top = this.waveformTop();
    const rows = this.getRowOrder().flatMap((entry) => {
      if (entry.kind === 'channel' && !visible.has(entry.id)) return [];
      if (entry.kind === 'analog' && !analogVisible.has(entry.id)) return [];
      const height =
        entry.kind === 'analog'
          ? analogHeight(this.analogSettings[entry.id]!)
          : entry.kind === 'channel'
            ? this.digitalHeights[entry.id]! + 32
            : this.protocolHeight(protocols.get(entry.id)!);
      const row = { entry, top, height };
      top += height;
      return [row];
    });
    return rows;
  }
  private rowAt(x: number, y: number): TimelineLayoutRow | null {
    if (x < 0 || x >= this.gutter - 12) return null;
    return this.rowLayout().find((row) => y >= row.top && y < row.top + row.height) ?? null;
  }
  private settleRows(): void {
    this.rowSnapshot = null;
    this.rowMotions.clear();
  }
  private snapshotRows(): void {
    this.settleRows();
    this.drawNow();
    const image = document.createElement('canvas');
    image.width = this.canvas.width;
    image.height = this.canvas.height;
    image.getContext('2d')!.drawImage(this.canvas, 0, 0);
    this.rowSnapshot = {
      canvas: image,
      rects: new Map(this.rowLayout().map((row) => [rowKey(row.entry), row])),
      dpr: window.devicePixelRatio || 1,
    };
  }
  private motionTop(row: TimelineLayoutRow, now: number): number {
    const motion = this.rowMotions.get(rowKey(row.entry));
    if (!motion) return row.top;
    const progress = Math.max(0, Math.min(1, (now - motion.started) / this.motionDuration));
    return motion.from + (motion.to - motion.from) * (1 - (1 - progress) ** 3);
  }
  private reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  private floatingTop(): number {
    const drag = this.rowDrag!;
    return Math.max(this.waveformTop(), drag.y - drag.offset);
  }
  private reorderRow(y: number): void {
    const drag = this.rowDrag;
    if (!drag?.moved) return;
    const rows = this.rowLayout(),
      others = rows.filter((row) => rowKey(row.entry) !== rowKey(drag.entry));
    const before = others.find((row) => y < row.top + row.height / 2)?.entry;
    const next = moveTimelineRow(this.getRowOrder(), drag.entry, before);
    if (next.every((row, i) => rowKey(row) === rowKey(this.rowOrder[i]))) return;
    const now = performance.now(),
      previous = new Map(rows.map((row) => [rowKey(row.entry), this.motionTop(row, now)]));
    this.rowOrder = next;
    const visible = new Set(this.channels);
    this.channels = next.flatMap((row) => (row.kind === 'channel' && visible.has(row.id) ? [row.id] : []));
    const analogVisible = new Set(this.analogChannels);
    this.analogChannels = next.flatMap((row) => (row.kind === 'analog' && analogVisible.has(row.id) ? [row.id] : []));
    const protocols = new Map(this.protocols.map((p) => [p.id, p]));
    this.protocols.splice(
      0,
      this.protocols.length,
      ...next.flatMap((row) => (row.kind === 'protocol' ? [protocols.get(row.id)!] : [])),
    );
    if (!this.reducedMotion())
      for (const row of this.rowLayout()) {
        const key = rowKey(row.entry),
          from = previous.get(key)!;
        if (key === rowKey(drag.entry)) continue;
        if (Math.abs(from - row.top) > 0.1) this.rowMotions.set(key, { from, to: row.top, started: now });
        else this.rowMotions.delete(key);
      }
    this.onProtocolOrderChange();
    this.schedule();
  }
  private scrollDraggedRow(): boolean {
    const drag = this.rowDrag;
    if (!drag?.moved) return false;
    const scroll = this.canvas.parentElement!,
      rect = scroll.getBoundingClientRect();
    const amount = drag.clientY < rect.top + this.axisHeight() + 20 ? -12 : drag.clientY > rect.bottom - 24 ? 12 : 0;
    if (!amount) return false;
    const previous = scroll.scrollTop;
    scroll.scrollTop += amount;
    if (scroll.scrollTop === previous) return false;
    drag.y = drag.clientY - this.canvas.getBoundingClientRect().top;
    this.reorderRow(drag.y);
    return true;
  }
  private finishPointer(target: HTMLCanvasElement): void {
    const measuring = this.draggingCursor;
    if (this.rowDrag?.moved && !this.reducedMotion()) {
      const row = this.rowLayout().find((row) => rowKey(row.entry) === rowKey(this.rowDrag!.entry));
      if (row)
        this.rowMotions.set(rowKey(row.entry), { from: this.floatingTop(), to: row.top, started: performance.now() });
    }
    this.drag = null;
    this.cursorRange = null;
    this.draggingCursor = false;
    this.cursorDrag = null;
    this.pointerStart = null;
    this.rowDrag = null;
    this.pointerId = null;
    if (measuring) {
      this.cursorMode = false;
      this.onChange();
    }
    target.style.cursor = this.cursorMode ? 'crosshair' : 'grab';
    this.schedule();
  }
  private drawGrip(ctx: CanvasRenderingContext2D, top: number, height: number): void {
    ctx.fillStyle = this.palette['label'];
    for (const x of [4, 8]) for (const y of [-4, 0, 4]) ctx.fillRect(x, top + height / 2 + y, 1.5, 1.5);
  }
  private updateSettingsButtons(layout: readonly TimelineLayoutRow[], now: number): void {
    const visible = new Set<string>();
    const visibleCollapse = new Set<string>();
    const visibleTracks = new Set<string>();
    for (const row of layout) {
      const entry = row.entry;
      const key = rowKey(entry);
      const motionTop = this.motionTop(row, now);
      visible.add(key);
      let button = this.settingsButtons.get(key);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.textContent = '⚙';
        button.style.left = `${this.gutter - 36}px`;
        button.addEventListener('click', () => {
          if (entry.kind === 'analog') this.onAnalogSettings(entry.id);
          else if (entry.kind === 'channel') this.onDigitalSettings(entry.id);
          else this.onProtocolSettings(entry.id);
        });
        this.settingsButtons.set(key, button);
        this.settingsLayer.append(button);
      }
      const protocol = entry.kind === 'protocol' ? this.protocols.find((p) => p.id === entry.id) : undefined;
      const label =
        entry.kind === 'analog'
          ? `${t('analog.settings')} · A${this.capture?.deviceChannels?.analog[entry.id] ?? entry.id}`
          : entry.kind === 'channel'
            ? `${t('channels.digitalSettings')} · D${this.capture?.deviceChannels?.logic[entry.id] ?? entry.id}`
            : `${t('decoder.settings')} · ${protocol?.name ?? entry.id}`;
      if (button.title !== label) {
        button.title = label;
        button.setAttribute('aria-label', label);
      }
      const top = `${motionTop + (entry.kind === 'protocol' ? 3 : 5)}px`;
      if (button.style.top !== top) button.style.top = top;
      if (button.hidden !== !!this.rowDrag) button.hidden = !!this.rowDrag;

      if (protocol) {
        visibleCollapse.add(protocol.id);
        let collapseBtn = this.collapseButtons.get(protocol.id);
        if (!collapseBtn) {
          collapseBtn = document.createElement('button');
          collapseBtn.type = 'button';
          collapseBtn.className = 'protocol-collapse-btn';
          collapseBtn.style.left = `${this.gutter - 59}px`;
          collapseBtn.addEventListener('click', () => {
            this.onToggleProtocolCollapse(protocol.id);
          });
          this.collapseButtons.set(protocol.id, collapseBtn);
          this.settingsLayer.append(collapseBtn);
        }
        const collapsed = !!protocol.collapsed;
        const glyph = collapsed ? '▸' : '▾';
        if (collapseBtn.textContent !== glyph) collapseBtn.textContent = glyph;
        const collapseLabel = collapsed ? t('decoder.expandTracks') : t('decoder.collapseTracks');
        if (collapseBtn.title !== collapseLabel) {
          collapseBtn.title = collapseLabel;
          collapseBtn.setAttribute('aria-label', collapseLabel);
        }
        const collapseTop = `${motionTop + 3}px`;
        if (collapseBtn.style.top !== collapseTop) collapseBtn.style.top = collapseTop;
        collapseBtn.hidden = !!this.rowDrag || !decoderDefinition(protocol.decoder).ui.rows.length;

        const tracks = this.visibleRowsFor(protocol);
        tracks.forEach((track, trackIndex) => {
          const trackKey = `${protocol.id}:${track.id}`;
          visibleTracks.add(trackKey);
          let hideBtn = this.trackHideButtons.get(trackKey);
          if (!hideBtn) {
            hideBtn = document.createElement('button');
            hideBtn.type = 'button';
            hideBtn.className = 'protocol-track-hide';
            hideBtn.textContent = '−';
            hideBtn.style.left = `${this.gutter - 34}px`;
            hideBtn.addEventListener('click', () => {
              this.onToggleProtocolRow(protocol.id, track.id, false);
            });
            this.trackHideButtons.set(trackKey, hideBtn);
            this.settingsLayer.append(hideBtn);
          }
          const rowName =
            track.row.labelKey && hasMessage(track.row.labelKey) ? t(track.row.labelKey) : track.row.label;
          const hideLabel = t('decoder.trackHide', { name: rowName });
          if (hideBtn.title !== hideLabel) {
            hideBtn.title = hideLabel;
            hideBtn.setAttribute('aria-label', hideLabel);
          }
          const trackTop = `${motionTop + 28 + trackIndex * 28 + 4}px`;
          if (hideBtn.style.top !== trackTop) hideBtn.style.top = trackTop;
          if (hideBtn.hidden !== !!this.rowDrag) hideBtn.hidden = !!this.rowDrag;
        });
      }
    }
    for (const [key, button] of this.settingsButtons) {
      if (visible.has(key)) continue;
      button.remove();
      this.settingsButtons.delete(key);
    }
    for (const [key, button] of this.collapseButtons) {
      if (visibleCollapse.has(key)) continue;
      button.remove();
      this.collapseButtons.delete(key);
    }
    for (const [key, button] of this.trackHideButtons) {
      if (visibleTracks.has(key)) continue;
      button.remove();
      this.trackHideButtons.delete(key);
    }
  }
  private nearestCursor(x: number, label: boolean): 'a' | 'b' | null {
    if (!this.capture) return null;
    const candidates = (
      [
        ['a', this.cursorA],
        ['b', this.cursorB],
      ] as const
    )
      .filter(([, sample]) => sample !== null)
      .map(([key, sample]) => ({ key, distance: Math.abs(x - this.xAtSample(sample!)) }));
    const nearest = candidates.sort((a, b) => a.distance - b.distance)[0];
    if (nearest && (nearest.distance <= 9 || (label && nearest.distance <= 80))) return nearest.key;
    return null;
  }
  private moveOverview(event: PointerEvent): void {
    if (!this.capture) return;
    const rect = this.overview.getBoundingClientRect(),
      x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const center = scaleSamples(this.viewLength(this.capture), x / Math.max(1, rect.width)),
      span = this.end - this.start,
      start = center - span / 2n;
    this.setViewport(start, start + span);
  }
  private selectAnnotation(x: number, y: number): void {
    const row = this.rowLayout().find(
      (row) => row.entry.kind === 'protocol' && y >= row.top && y < row.top + row.height,
    );
    if (!row || row.entry.kind !== 'protocol') return;
    const protocol = this.protocols.find((p) => p.id === row.entry.id)!;
    const top = row.top;
    if (x < this.gutter || y - top < 28) {
      this.onAnnotationClick(protocol.id, this.start, this.end);
      return;
    }
    const visible = this.visibleRowsFor(protocol);
    const index = Math.floor((y - top - 28) / 28);
    if (index < 0 || index >= visible.length) return;
    const classes = visible[index]?.row.classes ?? [];
    const sample = this.sampleAtX(x),
      annotation = protocol.annotations.query(sample, sample).find((a) => classes.includes(a.classIndex));
    if (annotation) this.onAnnotationClick(protocol.id, annotation.ss, annotation.es);
  }
  setRenderingEnabled(enabled: boolean): void {
    this.renderingEnabled = enabled;
    if (!enabled) {
      cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = 0;
      if (this.pending) {
        cancelAnimationFrame(this.frameRequest);
        this.pending = false;
      }
    } else if (enabled) this.schedule();
  }
  resetMetrics(): void {
    this.timings = [];
    this.queryTimings = [];
    this.queryTotalMs = 0;
    this.queryCalls = 0;
    this.queryMaxMs = 0;
  }
  schedule(): void {
    if (!this.renderingEnabled) return;
    this.viewRefreshDirty = true;
    if (this.pending) return;
    this.pending = true;
    this.frameRequest = requestAnimationFrame(() => {
      this.pending = false;
      const capture = this.capture;
      if (!capture) {
        this.drawNow();
        return;
      }
      this.refreshView();
    });
  }
  private refreshView(): void {
    const capture = this.capture;
    if (!this.renderingEnabled || !capture) return;
    if (this.viewRefresh) {
      this.viewRefreshDirty = true;
      return;
    }
    const store = capture.store as
      | (Capture['store'] & {
          prepareView?: (
            channels: readonly number[],
            start: bigint,
            end: bigint,
            bins: number,
            includeEdges?: boolean,
          ) => Promise<void>;
        })
      | undefined;
    const width = Math.max(300, Math.floor(this.canvas.parentElement?.clientWidth || 1000));
    const bins = Math.max(1, width - this.gutter - 16),
      start = this.start,
      end = this.end,
      generation = this.viewGeneration;
    const tasks: Promise<void>[] = [];
    if (store?.prepareView && end > start) tasks.push(store.prepareView(this.channels, start, end, bins));
    for (const channel of this.analogChannels) {
      const analog = capture.analogChannels?.[channel]?.store as
        | (AnalogStore & {
            prepareView?: (start: bigint, end: bigint, bins: number, settings?: AnalogSettings) => Promise<void>;
          })
        | undefined;
      if (!analog?.prepareView) continue;
      const samples = this.analogSampleRange(analog, bins, ANALOG_LINE_MIN_PIXELS);
      if (samples)
        tasks.push(analog.prepareView(samples.start, samples.end, samples.count, this.analogSettings[channel]));
      else {
        const analogStart = this.timelineToAnalogSample(analog, start),
          analogEnd = this.timelineToAnalogSample(analog, end, 'ceil'),
          availableEnd = minSample(analog.length, analogEnd);
        if (availableEnd > analogStart)
          tasks.push(
            analog.prepareView(
              analogStart,
              availableEnd,
              this.availableBins(availableEnd, bins, analogStart, analogEnd),
              this.analogSettings[channel],
            ),
          );
      }
    }
    const protocolTasks: Promise<void>[] = [];
    for (const protocol of this.protocols) {
      const rows = this.protocolRows(protocol);
      if (rows > 0)
        protocolTasks.push(protocol.annotations.prepareView(start, end, this.annotationQueryBudget(bins, rows)));
    }
    if (!tasks.length && !protocolTasks.length) {
      this.viewReady = true;
      this.drawNow();
      return;
    }
    const viewportChanged =
      this.lastRefreshViewport !== null &&
      (this.lastRefreshViewport[0] !== start || this.lastRefreshViewport[1] !== end);
    this.lastRefreshViewport = [start, end];
    const waitProtocols = (): Promise<void> => {
      if (!protocolTasks.length) return Promise.resolve();
      const decodingActive = this.protocols.some((protocol) => protocol.state === 'decoding');
      const liveContinuous = capture.acquisition?.mode === 'continuous' && decodingActive;
      // On the very first non-empty paint while live decoding is active, or while actively
      // zooming/panning during live continuous decoding, never stall digital waveform rendering.
      if (
        tasks.length &&
        capture.store.length > 0n &&
        ((this.presentedSamples === 0n && decodingActive) || (liveContinuous && viewportChanged))
      ) {
        void Promise.allSettled(protocolTasks);
        return Promise.resolve();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        Promise.all(protocolTasks).then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, liveContinuous ? 16 : 24);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    };
    this.viewRefreshDirty = false;
    const task = Promise.all([...tasks, waitProtocols()])
      .then(
        () => ({ ready: true as const, error: null as unknown }),
        (error: unknown) => ({ ready: false as const, error }),
      )
      .then(({ ready, error }) => {
        if (this.viewRefresh === task) this.viewRefresh = null;
        if (!this.renderingEnabled || this.capture !== capture) return;
        const current = generation === this.viewGeneration && start === this.start && end === this.end;
        if (!ready) {
          const message = error instanceof Error ? error.message : String(error ?? '');
          const transient =
            (error instanceof Error && error.name === 'AbortError') ||
            /Superseded|timed out|page budget/i.test(message);
          if (!current || this.viewRefreshDirty || transient) {
            if (!current) this.viewRefreshFailures = 0;
            this.viewRefreshFailures++;
            if (!current || this.viewRefreshFailures <= 3) this.schedule();
            else if (this.viewRefreshRetryTimer === null) {
              const delay = Math.min(200, 40 * Math.min(this.viewRefreshFailures - 2, 5));
              this.viewRefreshRetryTimer = setTimeout(() => {
                this.viewRefreshRetryTimer = null;
                if (this.renderingEnabled && this.capture === capture) this.schedule();
              }, delay);
            }
          }
          return;
        }
        this.viewRefreshFailures = 0;
        const currentWidth = Math.max(300, Math.floor(this.canvas.parentElement?.clientWidth || 1000));
        if (Math.max(1, currentWidth - this.gutter - 16) !== bins) {
          this.schedule();
          return;
        }
        if (current) {
          this.viewReady = true;
          this.drawNow();
        }
        if (!current || this.viewRefreshDirty) this.schedule();
      });
    this.viewRefresh = task;
  }
  drawNow(): number {
    if (!this.renderingEnabled) return 0;
    if (this.capture && !this.viewReady) return 0;
    if (this.pending) {
      cancelAnimationFrame(this.frameRequest);
      this.pending = false;
    }
    const started = performance.now();
    const capture = this.capture;
    this.width = Math.max(300, Math.floor(this.canvas.parentElement?.clientWidth || 1000));
    const scrolling = this.scrollDraggedRow(),
      layout = this.rowLayout();
    const height = Math.max(270, this.waveformTop() + layout.reduce((sum, row) => sum + row.height, 0)),
      dpr = window.devicePixelRatio || 1;
    this.canvas.style.height = height + 'px';
    const pixelWidth = Math.round(this.width * dpr),
      pixelHeight = Math.round(height * dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    if (this.frameCanvas.width !== pixelWidth || this.frameCanvas.height !== pixelHeight) {
      this.frameCanvas.width = pixelWidth;
      this.frameCanvas.height = pixelHeight;
    }
    const ctx = this.frameContext;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.palette['bg'];
    ctx.fillRect(0, 0, this.width, height);
    if (!capture) {
      this.updateSettingsButtons([], started);
      if (this.axisCanvas) {
        const axisCtx = this.axisCanvas.getContext('2d');
        axisCtx?.clearRect(0, 0, this.axisCanvas.width, this.axisCanvas.height);
      }
      const overviewCtx = this.overview.getContext('2d');
      if (overviewCtx) {
        overviewCtx.setTransform(1, 0, 0, 1, 0, 0);
        overviewCtx.clearRect(0, 0, this.overview.width, this.overview.height);
      }
      this.presentFrame();
      return performance.now() - started;
    }
    const { store, triggerSample } = capture,
      plotWidth = Math.max(1, this.width - this.gutter - 16);
    const toX = (sample: bigint): number =>
      this.gutter + sampleRatio(sample - this.start, this.end - this.start) * plotWidth;
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    const ticks = Math.max(2, Math.min(8, Math.floor(plotWidth / 128)));
    const tickResolution = Number(this.end - this.start) / ticks / store.samplerate;
    const axisLabels: Array<{ x: number; text: string; width: number }> = [];
    for (let i = 0; i <= ticks; i++) {
      const x = this.gutter + (plotWidth * i) / ticks,
        sample = this.start + ((this.end - this.start) * BigInt(i)) / BigInt(ticks);
      ctx.strokeStyle = this.palette['grid'];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, this.axisHeight());
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
      if (!this.axisCanvas) {
        const text = timeLabel(Number(sample - triggerSample) / store.samplerate, tickResolution);
        axisLabels.push({ x, text, width: ctx.measureText(text).width });
      }
    }
    if (!this.axisCanvas && axisLabels.length) this.drawTickLabels(ctx, axisLabels);
    ctx.textAlign = 'left';
    const now = performance.now(),
      floating = this.rowDrag?.moved ? rowKey(this.rowDrag.entry) : null;
    this.updateSettingsButtons(layout, now);
    for (const row of layout)
      if (rowKey(row.entry) !== floating) this.drawTimelineRow(ctx, row, this.motionTop(row, now), toX, plotWidth);
    if (floating) {
      const row = layout.find((row) => rowKey(row.entry) === floating)!;
      ctx.fillStyle = this.palette['cursor'];
      ctx.globalAlpha = 0.1;
      ctx.fillRect(0, row.top, this.width - 16, row.height);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.palette['cursor'];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(4, row.top);
      ctx.lineTo(this.width - 16, row.top);
      ctx.stroke();
      const top = this.floatingTop();
      ctx.save();
      ctx.shadowColor = this.palette['cursor'];
      ctx.shadowBlur = 12;
      ctx.fillStyle = this.palette['bg'];
      ctx.fillRect(4, top, this.width - 20, row.height);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.94;
      ctx.translate(4, 0);
      this.drawTimelineRow(ctx, row, top, toX, plotWidth);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.palette['cursor'];
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, top + 0.5, this.width - 20, row.height - 1);
      ctx.restore();
    }
    this.drawCursor(ctx, height, !this.axisCanvas);
    this.drawAxis(capture, dpr);
    this.drawOverview(capture, dpr);
    this.presentedViewport = [this.start, this.end];
    if (capture.store.length > 0n) this.presentedSamples = capture.store.length;
    this.refreshHover();
    this.presentFrame();
    const animating = [...this.rowMotions.values()].some((motion) => now - motion.started < this.motionDuration);
    if (animating || scrolling) this.schedule();
    else if (!this.rowDrag?.moved && this.rowSnapshot) {
      this.settleRows();
      this.schedule();
    }
    const elapsed = performance.now() - started;
    this.timings.push(elapsed);
    if (this.timings.length > 240) this.timings.shift();
    return elapsed;
  }
  private presentFrame(): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.frameCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    this.drawHover(ctx);
  }
  private clearHover(): void {
    cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0;
    this.hoverX = null;
    this.hoverSample = null;
    this.hoverResult = null;
    this.presentedViewport = null;
    this.presentedSamples = 0n;
    this.lastRefreshViewport = null;
  }
  private moveHover(x: number | null): void {
    this.hoverX = x !== null && x >= this.gutter && x <= this.width - 16 ? x : null;
    if (this.hoverX === null) this.hoverSample = null;
    this.scheduleHover();
  }
  private scheduleHover(): void {
    if (this.hoverFrame || !this.renderingEnabled) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      if (!this.capture || !this.presentedViewport) return;
      this.refreshHover();
      this.presentFrame();
    });
  }
  private refreshHover(): void {
    const capture = this.capture,
      viewport = this.presentedViewport;
    this.hoverSample =
      this.hoverX === null || !viewport
        ? null
        : minSample(
            viewport[1] - 1n,
            viewport[0] +
              scaleSamples(
                viewport[1] - viewport[0],
                (this.hoverX - this.gutter) / Math.max(1, this.width - this.gutter - 16),
              ),
          );
    const sample = this.hoverSample,
      store = capture?.store as
        | (Capture['store'] & {
            readAnalogProbe?: (sample: bigint) => Promise<readonly (number | null)[]>;
          })
        | undefined;
    if (
      !capture ||
      sample === null ||
      !store?.readAnalogProbe ||
      this.hoverPending ||
      (this.hoverResult?.capture === capture &&
        this.hoverResult.sample === sample &&
        this.hoverResult.length === store.length)
    )
      return;
    this.hoverPending = true;
    const length = store.length;
    void store
      .readAnalogProbe(sample)
      .then(
        (values) => {
          this.hoverResult = { capture, sample, length, values };
        },
        () => {
          this.hoverResult = { capture, sample, length, values: [] };
        },
      )
      .finally(() => {
        this.hoverPending = false;
        this.scheduleHover();
      });
  }
  private drawHover(ctx: CanvasRenderingContext2D): void {
    const capture = this.capture;
    if (!capture || !this.presentedViewport || this.rowSnapshot) return;
    ctx.save();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.hoverX !== null) {
      ctx.strokeStyle = this.palette['hover'];
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(this.hoverX, this.axisHeight());
      ctx.lineTo(this.hoverX, this.canvas.height / dpr);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const row of this.rowLayout()) {
      if (row.entry.kind !== 'analog') continue;
      const channel = row.entry.id,
        range = capture.analogChannels?.[channel]?.store.range;
      if (!range) continue;
      const value =
        this.hoverSample !== null &&
        this.hoverResult?.capture === capture &&
        this.hoverResult.sample === this.hoverSample
          ? this.hoverResult.values[channel]
          : null;
      const settings = this.analogSettings[channel]!;
      const text = `[ ${value == null ? '—' : voltageLabel(value)} ] ${voltageLabel(analogAxis(range, settings).perDivision)}/div`,
        padX = 8,
        boxRight = this.width - 24,
        maxBoxWidth = Math.max(40, boxRight - this.gutter - 4),
        textWidth = Math.min(maxBoxWidth - padX * 2, ctx.measureText(text).width),
        boxWidth = textWidth + padX * 2,
        top = row.top + 3;
      ctx.fillStyle = this.palette['bg'];
      ctx.globalAlpha = 0.94;
      ctx.fillRect(boxRight - boxWidth, top, boxWidth, 20);
      ctx.globalAlpha = 1;
      ctx.fillStyle = settings.color;
      ctx.fillText(text, boxRight - padX, top + 10, textWidth);
    }
    ctx.restore();
  }
  private drawTimelineRow(
    ctx: CanvasRenderingContext2D,
    row: TimelineLayoutRow,
    top: number,
    toX: (sample: bigint) => number,
    plotWidth: number,
  ): void {
    const snapshot = this.rowSnapshot,
      cached = snapshot?.rects.get(rowKey(row.entry));
    if (snapshot && cached) {
      ctx.drawImage(
        snapshot.canvas,
        0,
        cached.top * snapshot.dpr,
        snapshot.canvas.width,
        cached.height * snapshot.dpr,
        0,
        top,
        this.width,
        row.height,
      );
      return;
    }
    if (row.entry.kind === 'channel') this.drawChannel(ctx, row.entry.id, top, plotWidth);
    else if (row.entry.kind === 'analog') this.drawAnalog(ctx, row.entry.id, top, plotWidth);
    else
      this.drawProtocol(
        ctx,
        this.protocols.find((protocol) => protocol.id === row.entry.id)!,
        top,
        toX,
        plotWidth,
      );
  }
  private drawChannel(ctx: CanvasRenderingContext2D, channel: number, top: number, plotWidth: number): void {
    const capture = this.capture!,
      store = capture.store,
      y = top + 5,
      rowHeight = this.digitalHeights[channel]! + 32,
      highY = y + 8,
      lowY = highY + this.digitalHeights[channel]!,
      color = this.palette.channels[(capture.deviceChannels?.logic[channel] ?? channel) % this.palette.channels.length];
    ctx.fillStyle = this.palette['label-bg'];
    ctx.fillRect(0, top, this.gutter - 12, rowHeight - 8);
    this.drawGrip(ctx, top, rowHeight - 8);
    ctx.fillStyle = color;
    ctx.fillRect(14, y + 5, 3, 25);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(`D${capture.deviceChannels?.logic[channel] ?? channel}`, 26, y + 12);
    ctx.fillStyle = this.palette['label'];
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(capture.labels[channel].slice(0, 12), 26, y + 28);
    const queryStarted = performance.now();
    const availableEnd = minSample(store.length, this.end);
    if (availableEnd <= this.start) {
      ctx.strokeStyle = this.palette['divider'];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, top + rowHeight - 3);
      ctx.lineTo(this.width, top + rowHeight - 3);
      ctx.stroke();
      return;
    }
    const view =
      typeof (store as typeof store & { prepareView?: unknown }).prepareView === 'function'
        ? store.query(channel, this.start, this.end, plotWidth)
        : store.query(channel, this.start, availableEnd, this.availableBins(availableEnd, plotWidth));
    const exactEdges = this.end - this.start < plotWidth ? store.edges(channel, this.start, this.end) : undefined;
    const samples = this.digitalSampleRange(store.length, plotWidth);
    this.recordQuery?.(performance.now() - queryStarted);
    this.drawDigital(ctx, view, highY, lowY, color, exactEdges);
    if (samples) this.drawDigitalPoints(ctx, view, highY, lowY, color);
    ctx.strokeStyle = this.palette['divider'];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top + rowHeight - 3);
    ctx.lineTo(this.width, top + rowHeight - 3);
    ctx.stroke();
  }
  private drawAnalog(ctx: CanvasRenderingContext2D, channel: number, top: number, plotWidth: number): void {
    const capture = this.capture!,
      item = capture.analogChannels![channel]!,
      settings = this.analogSettings[channel]!,
      height = (settings.positiveDivs + settings.negativeDivs) * settings.divHeight,
      rowHeight = analogHeight(settings),
      y = top + 5;
    const color = settings.color;
    ctx.fillStyle = this.palette['label-bg'];
    ctx.fillRect(0, top, this.gutter - 12, rowHeight - 8);
    this.drawGrip(ctx, top, rowHeight - 8);
    ctx.fillStyle = color;
    ctx.fillRect(14, y + 5, 3, Math.min(25, Math.max(4, rowHeight - 17)));
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(`A${capture.deviceChannels?.analog[channel] ?? channel}`, 26, y + 12);
    ctx.fillStyle = this.palette['label'];
    ctx.font = '11px system-ui, sans-serif';
    if (rowHeight >= 40) ctx.fillText(item.name.slice(0, 12), 26, y + 28);
    const range = item.store.range;
    if (!range) return;
    const { minimum, maximum, perDivision } = analogAxis(range, settings);
    ctx.strokeStyle = this.palette['grid'];
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let div = 0; div <= settings.positiveDivs + settings.negativeDivs; div++) {
      const gridY = y - 2 + div * settings.divHeight;
      ctx.moveTo(this.gutter, gridY);
      ctx.lineTo(this.width - 16, gridY);
    }
    ctx.stroke();
    const queryStarted = performance.now();
    const zeroY = y - 2 + settings.positiveDivs * settings.divHeight;
    const pointY = (value: number): number => zeroY - (value / perDivision) * settings.divHeight;
    if (minimum <= 0 && maximum >= 0) {
      ctx.strokeStyle = this.palette['axis'];
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(this.gutter - 8, pointY(0));
      ctx.lineTo(this.width - 16, pointY(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    let prepared: AnalogColumnView | undefined;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.gutter, y - 2, plotWidth, height);
    ctx.clip();
    if (settings.conversion !== 'none' && settings.traces === 'converted') ctx.globalAlpha = 0;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    const samples = this.analogSampleRange(item.store, plotWidth, ANALOG_LINE_MIN_PIXELS);
    if (samples) {
      const points: AnalogColumnView = item.store.query(samples.start, samples.end, samples.count);
      prepared = points;
      this.recordQuery?.(performance.now() - queryStarted);
      ctx.lineWidth = ANALOG_LINE_WIDTH;
      ctx.beginPath();
      let lastY = 0;
      for (let i = 0; i < points.bins; i++) {
        const x = this.xAtAnalogSample(item.store, points.startSample + BigInt(i)),
          sampleY = pointY(points.low[i]!);
        if (i) ctx.lineTo(x, sampleY);
        else {
          ctx.moveTo(this.gutter, sampleY);
          ctx.lineTo(x, sampleY);
        }
        lastY = sampleY;
      }
      if (points.endSample >= this.timelineToAnalogSample(item.store, this.end, 'ceil'))
        ctx.lineTo(this.width - 16, lastY);
      ctx.stroke();
      if (this.analogPointsVisible(samples, plotWidth)) {
        ctx.beginPath();
        for (let i = 0; i < points.bins; i++) {
          const x = this.xAtAnalogSample(item.store, points.startSample + BigInt(i)),
            sampleY = pointY(points.low[i]!);
          ctx.moveTo(x + SAMPLE_POINT_RADIUS, sampleY);
          ctx.arc(x, sampleY, SAMPLE_POINT_RADIUS, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    } else {
      const analogStart = this.timelineToAnalogSample(item.store, this.start),
        analogEnd = this.timelineToAnalogSample(item.store, this.end, 'ceil'),
        availableEnd = minSample(item.store.length, analogEnd);
      if (availableEnd <= analogStart) {
        ctx.restore();
        return;
      }
      const view: AnalogColumnView = item.store.query(
        analogStart,
        availableEnd,
        this.availableBins(availableEnd, plotWidth, analogStart, analogEnd),
      );
      prepared = view;
      this.recordQuery?.(performance.now() - queryStarted);
      const viewSpan = view.endSample - view.startSample;
      const xAt = (index: number): number =>
        this.xAtAnalogSample(item.store, view.startSample + (viewSpan * BigInt(index)) / BigInt(view.bins));
      let first = 0,
        previousLow = 0,
        previousHigh = 0;
      for (let i = 0; i <= view.bins; i++) {
        const low = i < view.bins ? pointY(view.low[i]!) : 0;
        const high = i < view.bins ? pointY(view.high[i]!) : 0;
        if (i === 0) {
          previousLow = low;
          previousHigh = high;
        } else if (i === view.bins || low !== previousLow || high !== previousHigh) {
          const rawHeight = previousLow - previousHigh,
            height = Math.max(ANALOG_LINE_WIDTH, rawHeight);
          ctx.fillRect(xAt(first), previousHigh - (height - rawHeight) / 2, xAt(i) - xAt(first), height);
          first = i;
          previousLow = low;
          previousHigh = high;
        }
      }
    }
    ctx.restore();
    if (settings.conversion !== 'none' && settings.traces !== 'analog' && prepared?.logic) {
      const logic = prepared.logic,
        both = settings.traces === 'both',
        highY = both ? y - 2 + height + 4 : y + 3,
        lowY = both ? highY + 16 : y - 2 + height - 4;
      const toX = (sample: bigint): number => this.xAtAnalogSample(item.store, sample);
      this.drawDigital(ctx, logic, highY, lowY, color, logic.edges, toX);
      if (samples && this.analogPointsVisible(samples, plotWidth))
        this.drawDigitalPoints(ctx, logic, highY, lowY, color, toX);
    }
  }
  private drawDigital(
    ctx: CanvasRenderingContext2D,
    view: ColumnView,
    highY: number,
    lowY: number,
    color: string,
    exactEdges?: bigint[],
    toX: (sample: bigint) => number = (sample) => this.xAtSample(sample),
  ): void {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const viewSpan = view.endSample - view.startSample;
    const xAt = (index: number): number => toX(view.startSample + (viewSpan * BigInt(index)) / BigInt(view.bins));
    for (const high of [true, false]) {
      const y = high ? highY : lowY;
      let first = -1;
      for (let i = 0; i <= view.bins; i++) {
        const active = i < view.bins && !(view.packed[i] & 8) && (high ? view.high[i] === 1 : view.low[i] === 0);
        if (active && first < 0) first = i;
        if (!active && first >= 0) {
          ctx.moveTo(xAt(first), y);
          ctx.lineTo(xAt(i), y);
          first = -1;
        }
      }
    }
    if (exactEdges) {
      for (const sample of exactEdges) {
        const x = Math.round(toX(sample)) + 0.5;
        if (x >= this.gutter && x <= this.width - 16) {
          ctx.moveTo(x, highY);
          ctx.lineTo(x, lowY);
        }
      }
    }
    ctx.stroke();
    if (!exactEdges) {
      let first = -1;
      for (let i = 0; i <= view.bins; i++) {
        const active = i < view.bins && !(view.packed[i] & 8) && view.edge[i] === 1;
        if (active && first < 0) first = i;
        if (!active && first >= 0) {
          ctx.fillRect(xAt(first), highY, xAt(i) - xAt(first), lowY - highY);
          first = -1;
        }
      }
    }
  }
  private drawDigitalPoints(
    ctx: CanvasRenderingContext2D,
    view: ColumnView,
    highY: number,
    lowY: number,
    color: string,
    toX: (sample: bigint) => number = (sample) => this.xAtSample(sample),
  ): void {
    if (!view.points?.length) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < view.points.length; i++) {
      const sample = view.startSample + BigInt(i);
      const x = toX(sample),
        y = view.points[i] ? highY : lowY;
      if (x < this.gutter || x > this.width - 16) continue;
      ctx.moveTo(x + SAMPLE_POINT_RADIUS, y);
      ctx.arc(x, y, SAMPLE_POINT_RADIUS, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  private digitalSampleRange(
    length: bigint,
    plotWidth: number,
    gap = SAMPLE_POINT_GAP,
  ): { start: bigint; end: bigint; count: number } | null {
    const start = maxSample(0n, this.start),
      end = minSample(length, this.end),
      limit = BigInt(Math.floor(plotWidth / gap));
    if (end <= start || this.end - this.start > limit) return null;
    return { start, end, count: Number(end - start) };
  }
  private analogSampleRange(
    store: AnalogStore,
    plotWidth: number,
    gap = SAMPLE_POINT_GAP,
  ): { start: bigint; end: bigint; count: number } | null {
    const start = this.timelineToAnalogSample(store, this.start),
      end = minSample(store.length, this.timelineToAnalogSample(store, this.end, 'ceil')),
      limit = BigInt(Math.floor(plotWidth / gap));
    if (end <= start || end - start > limit) return null;
    return { start, end, count: Number(end - start) };
  }
  private analogPointsVisible(samples: { start: bigint; end: bigint }, plotWidth: number): boolean {
    return plotWidth / Number(maxSample(1n, samples.end - samples.start)) >= SAMPLE_POINT_GAP;
  }
  private timelineToAnalogSample(store: AnalogStore, sample: bigint, rounding: 'floor' | 'ceil' = 'floor') {
    return rescaleSample(sample, this.capture!.store.samplerate, store.samplerate, rounding);
  }
  private xAtAnalogSample(store: AnalogStore, sample: bigint): number {
    const timelineRate = BigInt(this.capture!.store.samplerate),
      analogRate = BigInt(store.samplerate);
    return (
      this.gutter +
      sampleRatio(sample * timelineRate - this.start * analogRate, (this.end - this.start) * analogRate) *
        Math.max(1, this.width - this.gutter - 16)
    );
  }
  private availableBins(availableEnd: bigint, plotWidth: number, start = this.start, end = this.end): number {
    const span = end - start;
    if (span <= 0n || availableEnd <= start) return 1;
    return Math.max(1, Number((BigInt(plotWidth) * (availableEnd - start)) / span));
  }
  private drawCursor(ctx: CanvasRenderingContext2D, height: number, label: boolean): void {
    if (!this.capture) return;
    const rate = this.capture.store.samplerate,
      trigger = this.capture.triggerSample;
    const samples = [this.cursorA, this.cursorB]
      .filter((sample): sample is bigint => sample !== null && sample >= this.start && sample < this.end)
      .sort(compareSamples);
    ctx.save();
    ctx.font = (samples.length > 1 ? '10px' : '11px') + ' ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const labels = samples.map((sample) => {
      const x = this.xAtSample(sample),
        text = timeLabel(Number(sample - trigger) / rate, this.timeResolution()),
        width = ctx.measureText(text).width + 14;
      return { x, text, width, left: Math.max(this.gutter, Math.min(this.width - 16 - width, x - width / 2)) };
    });
    if (labels.length === 2 && labels[0].left + labels[0].width + 6 > labels[1].left) {
      labels[0].left = Math.max(
        this.gutter,
        Math.min(labels[0].left, this.width - 22 - labels[1].width - labels[0].width),
      );
      labels[1].left = Math.min(
        this.width - 16 - labels[1].width,
        Math.max(labels[1].left, labels[0].left + labels[0].width + 6),
      );
    }
    for (const { x, text, width, left } of labels) {
      ctx.strokeStyle = this.palette['cursor'];
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, label ? 28 : 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = this.palette['cursor'];
        ctx.fillRect(left, 2, width, 22);
        ctx.beginPath();
        ctx.moveTo(x - 4, 24);
        ctx.lineTo(x, 28);
        ctx.lineTo(x + 4, 24);
        ctx.fill();
        ctx.fillStyle = this.palette['bg'];
        ctx.fillText(text, left + 7, 13);
      }
    }
    if (label && this.cursorA !== null && this.cursorB !== null) {
      const delta = Number(absSample(this.cursorB - this.cursorA)) / rate;
      const text =
        t('wave.delta') +
        ': ' +
        timeLabel(delta) +
        ' · ' +
        t('wave.frequency') +
        ': ' +
        frequencyLabel(delta > 0 ? 1 / delta : Infinity);
      const left = Math.max(
        this.gutter,
        Math.min(this.width - 16, this.xAtSample(minSample(this.cursorA, this.cursorB))),
      );
      const right = Math.max(
        this.gutter,
        Math.min(this.width - 16, this.xAtSample(maxSample(this.cursorA, this.cursorB))),
      );
      ctx.strokeStyle = this.palette['cursor'];
      ctx.beginPath();
      ctx.moveTo(left, 39);
      ctx.lineTo(left, 49);
      ctx.moveTo(left, 44);
      ctx.lineTo(right, 44);
      ctx.moveTo(right, 39);
      ctx.lineTo(right, 49);
      ctx.stroke();
      ctx.font = '10px ui-monospace, Consolas, monospace';
      const width = Math.min(this.width - this.gutter - 16, ctx.measureText(text).width + 12);
      const center = Math.max(this.gutter + width / 2, Math.min(this.width - 16 - width / 2, (left + right) / 2));
      ctx.fillStyle = this.palette['bg'];
      ctx.fillRect(center - width / 2, 33, width, 22);
      ctx.fillStyle = this.palette['cursor'];
      ctx.textAlign = 'center';
      ctx.fillText(text, center, 44, width - 8);
    }
    ctx.restore();
  }
  private drawProtocol(
    ctx: CanvasRenderingContext2D,
    protocol: ProtocolTrace,
    annY: number,
    toX: (sample: bigint) => number,
    plotWidth: number,
  ): void {
    if (!this.capture || !this.capture.store.length) return;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const definition = decoderDefinition(protocol.decoder),
      allRows = definition.ui.rows,
      hiddenCount = normalizeHiddenRows(definition, protocol.hiddenRows).length,
      visibleRows = visibleProtocolRows(definition, protocol),
      rows = visibleRows.length,
      mainHeight = 28,
      rowHeight = 28,
      totalHeight = this.protocolHeight(protocol),
      darkTheme = isDarkColor(this.palette['bg'] ?? '#ffffff');

    ctx.save();
    ctx.textAlign = 'left';

    // PulseView-style Main Header Row (主行)
    ctx.fillStyle = this.palette['label-bg'];
    ctx.fillRect(0, annY, this.gutter - 12, mainHeight - 2);
    this.drawGrip(ctx, annY, mainHeight - 2);

    const badgeLeft = 15,
      badgeRight = this.gutter - 62,
      badgeTop = annY + 4,
      badgeBottom = annY + mainHeight - 6,
      badgeMid = (badgeTop + badgeBottom) / 2,
      tip = 6;
    if (badgeRight > badgeLeft + tip + 6) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(badgeLeft, badgeTop);
      ctx.lineTo(badgeRight - tip, badgeTop);
      ctx.lineTo(badgeRight, badgeMid);
      ctx.lineTo(badgeRight - tip, badgeBottom);
      ctx.lineTo(badgeLeft, badgeBottom);
      ctx.closePath();
      ctx.fillStyle = protocol.color;
      ctx.fill();
      ctx.strokeStyle = darkTheme ? 'rgba(255,255,255,0.22)' : 'rgba(15,23,42,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.clip();
      ctx.fillStyle = contrastTextForHex(protocol.color);
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(protocol.name, badgeLeft + 6, badgeMid + 0.5);
      ctx.restore();
    }

    // Header band across timeline plot area
    ctx.save();
    ctx.fillStyle = protocol.color;
    ctx.globalAlpha = protocol.id === this.selectedProtocolId ? 0.1 : 0.05;
    ctx.fillRect(this.gutter, annY, plotWidth, mainHeight - 2);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.palette['grid'];
    ctx.beginPath();
    ctx.moveTo(this.gutter, annY + mainHeight - 2);
    ctx.lineTo(this.width - 16, annY + mainHeight - 2);
    ctx.stroke();

    const activeTrackCount = Math.max(0, allRows.length - hiddenCount);
    const kindKey = `decoder.${protocol.decoder}.name`;
    const kindName = hasMessage(kindKey) ? t(kindKey) : (definition.descriptor.name ?? protocol.decoder);
    const summaryText = protocol.collapsed
      ? `${kindName} · ${t('decoder.collapsedSummary', {
          visible: activeTrackCount,
          total: allRows.length,
          frames: protocol.frameCount ?? 0,
        })}`
      : `${kindName} · ${t('decoder.tracksCount', {
          visible: activeTrackCount,
          total: allRows.length,
        })}`;
    ctx.fillStyle = this.palette['label'];
    ctx.globalAlpha = 0.72;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(summaryText, this.gutter + 8, annY + (mainHeight - 2) / 2);
    ctx.restore();

    // Sub-tracks (轨道)
    for (let rowIdx = 0; rowIdx < rows; rowIdx++) {
      const visibleRow = visibleRows[rowIdx]!,
        y = annY + mainHeight + rowIdx * rowHeight;
      const trackStyle = protocolTrackColor(protocol.color, visibleRow.rowIndex, 0, darkTheme);
      ctx.fillStyle = this.palette['label-bg'];
      ctx.fillRect(0, y, this.gutter - 12, rowHeight - 2);

      // Tree connector from Main Row + colored track bar
      ctx.save();
      ctx.strokeStyle = protocol.color;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(10, y - 2);
      ctx.lineTo(10, y + (rowHeight - 2) / 2);
      ctx.lineTo(17, y + (rowHeight - 2) / 2);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = trackStyle.fill;
      ctx.strokeStyle = trackStyle.border;
      ctx.fillRect(18, y + 4, 4, rowHeight - 10);
      ctx.strokeRect(18, y + 4, 4, rowHeight - 10);

      // Disclosure chevron matching PulseView row header (`▶ MISO bits`)
      ctx.fillStyle = this.palette['label'];
      ctx.beginPath();
      ctx.moveTo(26, y + rowHeight / 2 - 4);
      ctx.lineTo(31, y + rowHeight / 2 - 1);
      ctx.lineTo(26, y + rowHeight / 2 + 2);
      ctx.closePath();
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.rect(34, y, Math.max(8, this.gutter - 70), rowHeight - 2);
      ctx.clip();
      ctx.fillStyle = this.palette['label'];
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const rowLabel =
        visibleRow.row.labelKey && hasMessage(visibleRow.row.labelKey)
          ? t(visibleRow.row.labelKey)
          : visibleRow.row.label;
      ctx.fillText(rowLabel, 34, y + (rowHeight - 2) / 2);
      ctx.restore();

      ctx.strokeStyle = this.palette['grid'];
      ctx.beginPath();
      ctx.moveTo(this.gutter, y + rowHeight - 2);
      ctx.lineTo(this.width - 16, y + rowHeight - 2);
      ctx.stroke();
    }

    if (!rows) {
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.rect(this.gutter, annY + mainHeight, plotWidth, totalHeight - mainHeight - 2);
    ctx.clip();
    const queryStarted = performance.now();
    const budget = this.annotationQueryBudget(plotWidth, rows);
    const visible = protocol.annotations.query(this.start, this.end, budget);
    this.recordQuery?.(performance.now() - queryStarted);
    const rowOfClass = new Map<number, { row: number; rowIndex: number; classOffset: number }>();
    visibleRows.forEach((visibleRow, index) => {
      visibleRow.row.classes.forEach((classIndex, classOffset) => {
        if (!rowOfClass.has(classIndex)) {
          rowOfClass.set(classIndex, { row: index, rowIndex: visibleRow.rowIndex, classOffset });
        }
      });
    });
    const viewStart = this.start,
      viewSpan = this.end - viewStart,
      fastScale = viewSpan > 0n && viewSpan <= BigInt(Number.MAX_SAFE_INTEGER) ? plotWidth / Number(viewSpan) : 0,
      gutter = this.gutter,
      maxX = this.width - 16;
    const fastToX = fastScale ? (sample: bigint): number => gutter + Number(sample - viewStart) * fastScale : toX;
    const dense = visible.length >= Math.min(budget, Math.floor(plotWidth * rows));
    const merged = new Map<
      string,
      {
        annotation: (typeof visible)[number];
        row: number;
        rowIndex: number;
        classOffset: number;
        x: number;
        right: number;
        error: boolean;
      }
    >();
    const blocks: Array<{
      annotation: (typeof visible)[number];
      row: number;
      rowIndex: number;
      classOffset: number;
      x: number;
      right: number;
      merged: boolean;
    }> = [];
    const mergeWidth = dense ? 12 : 5;
    for (let i = 0; i < visible.length; i++) {
      const annotation = visible[i]!;
      const mapping = rowOfClass.get(annotation.classIndex);
      if (mapping === undefined) continue;
      const rawX = fastToX(annotation.ss),
        rawRight = fastToX(annotation.es),
        instant = annotation.ss === annotation.es;
      const x = rawX < gutter ? gutter : rawX > maxX ? maxX : rawX,
        right = rawRight < x ? x : rawRight > maxX ? maxX : rawRight;
      const w = instant ? 18 : right - x;
      if (!instant && w < mergeWidth) {
        const error = definition.ui.isErrorClass?.(annotation.classIndex) ?? false;
        const cell = Math.floor(x);
        const key = `${mapping.row}:${cell}:${error ? 1 : 0}`;
        const previous = merged.get(key);
        const effRight = right > x + 2 ? right : x + 2;
        if (previous) {
          if (x < previous.x) previous.x = x;
          if (effRight > previous.right) previous.right = effRight;
        } else {
          merged.set(key, {
            annotation,
            row: mapping.row,
            rowIndex: mapping.rowIndex,
            classOffset: mapping.classOffset,
            x,
            right: effRight,
            error,
          });
        }
      } else {
        blocks.push({
          annotation,
          row: mapping.row,
          rowIndex: mapping.rowIndex,
          classOffset: mapping.classOffset,
          x: instant ? rawX : x,
          right: instant ? rawX : right,
          merged: false,
        });
      }
    }
    const compact: Array<{
      annotation: (typeof visible)[number];
      row: number;
      rowIndex: number;
      classOffset: number;
      x: number;
      right: number;
      error: boolean;
    }> = [];
    if (merged.size) {
      const sortedMerged = [...merged.values()].sort((a, b) => a.row - b.row || a.x - b.x);
      for (let i = 0; i < sortedMerged.length; i++) {
        const block = sortedMerged[i]!;
        const previous = compact.at(-1);
        if (previous && previous.row === block.row && previous.error === block.error && block.x <= previous.right + 1.5)
          previous.right = Math.max(previous.right, block.right);
        else compact.push(block);
      }
    }
    const sampleRate = this.capture!.store.samplerate,
      decimals = protocol.decimalPlaces ?? 3,
      blockHeight = Math.max(6, rowHeight - 6),
      alpha = protocol.id === this.selectedProtocolId ? 0.95 : 0.85;
    if (compact.length) {
      ctx.globalAlpha = alpha;
      for (let i = 0; i < compact.length; i++) {
        const block = compact[i]!;
        const y = annY + mainHeight + block.row * rowHeight + 2;
        const style = block.error
          ? {
              fill: this.palette['annotation-error'] ?? '#ef4444',
              border: darkTheme ? '#fca5a5' : '#b91c1c',
              text: '#ffffff',
            }
          : protocolTrackColor(protocol.color, block.rowIndex, block.classOffset, darkTheme);
        ctx.fillStyle = style.fill;
        ctx.fillRect(block.x, y, Math.max(2, block.right - block.x), blockHeight);
      }
      ctx.globalAlpha = 1;
    }
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const { annotation, row, rowIndex, classOffset, x, right } = block;
      const y = annY + mainHeight + row * rowHeight + 2,
        middle = y + blockHeight / 2,
        error = definition.ui.isErrorClass?.(annotation.classIndex) ?? false;
      const style = error
        ? {
            fill: this.palette['annotation-error'] ?? '#ef4444',
            border: darkTheme ? '#fca5a5' : '#b91c1c',
            text: '#ffffff',
          }
        : protocolTrackColor(protocol.color, rowIndex, classOffset, darkTheme);
      const texts =
        definition.ui.annotationTexts?.(annotation, {
          sampleRate,
          decimals,
          text: (key, fallback) => (hasMessage(key) ? t(key) : fallback),
        }) ?? annotation.texts;

      ctx.globalAlpha = alpha;
      if (annotation.ss === annotation.es) {
        // PulseView draw_instant: centered rounded pill (START, Repeated START, STOP)
        ctx.font = '11px system-ui, sans-serif';
        const label = texts.at(-1) ?? texts[0] ?? '';
        const textWidth = label ? ctx.measureText(label).width : 0;
        const pillW = Math.min(Math.max(blockHeight, textWidth + 10), Math.max(blockHeight, plotWidth));
        const pillX = Math.max(this.gutter, Math.min(this.width - 16 - pillW, x - pillW / 2));
        const radius = blockHeight / 2;
        ctx.fillStyle = style.fill;
        ctx.strokeStyle = style.border;
        ctx.beginPath();
        ctx.roundRect(pillX, y, pillW, blockHeight, radius);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (label) {
          ctx.fillStyle = style.text;
          ctx.textAlign = 'center';
          ctx.fillText(label, pillX + pillW / 2, middle);
          ctx.textAlign = 'left';
        }
        continue;
      }

      const w = Math.max(2, right - x);
      const leftTab = Math.min(5, Math.max(1.5, w / 4)),
        rightTab = leftTab;
      ctx.fillStyle = style.fill;
      ctx.strokeStyle = style.border;
      ctx.beginPath();
      ctx.moveTo(x, middle);
      ctx.lineTo(x + leftTab, y);
      ctx.lineTo(Math.max(x + leftTab, x + w - rightTab), y);
      ctx.lineTo(x + w, middle);
      ctx.lineTo(Math.max(x + leftTab, x + w - rightTab), y + blockHeight);
      ctx.lineTo(x + leftTab, y + blockHeight);
      ctx.closePath();
      ctx.fill();
      if (w >= 4) {
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (w > 8) {
        ctx.fillStyle = style.text;
        ctx.font = '11px system-ui, sans-serif';
        const available = Math.max(8, w - 6),
          text = texts.find((value) => ctx.measureText(value).width <= available);
        if (text) {
          ctx.textAlign = 'center';
          ctx.fillText(text, x + w / 2, middle);
          ctx.textAlign = 'left';
        }
      }
    }
    ctx.restore();
  }
  private drawTickLabels(
    ctx: CanvasRenderingContext2D,
    labels: ReadonlyArray<{ x: number; text: string; width: number }>,
  ): void {
    const lastIndex = labels.length - 1;
    const last = labels[lastIndex]!;
    const lastLeft = last.x - 4 - last.width;
    let previousRight = -Infinity;
    ctx.fillStyle = this.palette['axis'];
    for (let i = 0; i <= lastIndex; i++) {
      const item = labels[i]!;
      if (i === lastIndex) {
        if (lastLeft >= previousRight + 10) {
          ctx.textAlign = 'right';
          ctx.fillText(item.text, item.x - 4, 16);
        }
      } else {
        const left = item.x + 4;
        const right = left + item.width;
        if (left >= previousRight + 10 && right + 12 <= lastLeft) {
          ctx.textAlign = 'left';
          ctx.fillText(item.text, left, 16);
          previousRight = right;
        }
      }
    }
  }
  private drawAxis(capture: Capture, dpr: number): void {
    const target = this.axisCanvas;
    if (!target) return;
    const height = this.axisHeight();
    target.style.width = this.width + 'px';
    target.style.height = height + 'px';
    target.style.marginBottom = -height + 'px';
    if (target.width !== Math.round(this.width * dpr) || target.height !== Math.round(height * dpr)) {
      target.width = Math.round(this.width * dpr);
      target.height = Math.round(height * dpr);
    }
    const ctx = target.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.palette['bg'];
    ctx.fillRect(0, 0, this.width, height);
    const plotWidth = Math.max(1, this.width - this.gutter - 16),
      ticks = Math.max(2, Math.min(8, Math.floor(plotWidth / 128)));
    const tickResolution = Number(this.end - this.start) / ticks / capture.store.samplerate;
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    const labels: Array<{ x: number; text: string; width: number }> = [];
    for (let i = 0; i <= ticks; i++) {
      const x = this.gutter + (plotWidth * i) / ticks,
        sample = this.start + ((this.end - this.start) * BigInt(i)) / BigInt(ticks);
      ctx.strokeStyle = this.palette['grid'];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
      const text = timeLabel(Number(sample - capture.triggerSample) / capture.store.samplerate, tickResolution);
      labels.push({ x, text, width: ctx.measureText(text).width });
    }
    this.drawTickLabels(ctx, labels);
    this.drawCursor(ctx, height, true);
  }
  private drawOverview(capture: Capture, dpr: number): void {
    const width = Math.max(1, this.overview.clientWidth || this.width),
      height = 14;
    if (this.overview.width !== Math.round(width * dpr) || this.overview.height !== Math.round(height * dpr)) {
      this.overview.width = Math.round(width * dpr);
      this.overview.height = Math.round(height * dpr);
    }
    const ctx = this.overview.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.palette['overview-bg'];
    ctx.fillRect(0, 0, width, height);
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.palette['overview-line'];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(1, 7);
    ctx.lineTo(Math.max(1, width - 1), 7);
    ctx.stroke();
    const length = this.viewLength(capture),
      x = sampleRatio(this.start, length) * width,
      end = sampleRatio(this.end, length) * width;
    const selectionWidth = Math.min(width, Math.max(10, end - x));
    const left = Math.max(0, Math.min(width - selectionWidth, (x + end - selectionWidth) / 2));
    ctx.fillStyle = this.palette['overview-selection'];
    ctx.fillRect(left, 1, selectionWidth, height - 2);
    ctx.strokeStyle = this.palette['overview-border'];
    ctx.lineWidth = 2;
    ctx.strokeRect(left + 1, 2, selectionWidth - 2, height - 4);
    if (selectionWidth >= 28) {
      const center = left + selectionWidth / 2;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const offset of [-2, 2]) {
        ctx.moveTo(center + offset, 5);
        ctx.lineTo(center + offset, 9);
      }
      ctx.stroke();
    }
  }
  private recordQuery(elapsed: number): void {
    this.queryTimings.push(elapsed);
    if (this.queryTimings.length > 240) this.queryTimings.shift();
    this.queryCalls++;
    this.queryTotalMs += elapsed;
    this.queryMaxMs = Math.max(this.queryMaxMs, elapsed);
  }
  dispose(): void {
    this.settingsLayer.remove();
    this.settingsButtons.clear();
    this.renderingEnabled = false;
    this.clearHover();
    window.removeEventListener('hakei:themechange', this.themeChanged);
    this.observer.disconnect();
    this.settleRows();
    cancelAnimationFrame(this.frameRequest);
    this.pending = false;
  }
  metrics(): {
    frames: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    queryCalls: number;
    queryTotalMs: number;
    queryMaxMs: number;
    queryP95Ms: number;
    renderNonQueryJsMs: number;
  } {
    const values = [...this.timings].sort((a, b) => a - b),
      queries = [...this.queryTimings].sort((a, b) => a - b),
      total = this.timings.reduce((sum, value) => sum + value, 0),
      queryWindowTotal = this.queryTimings.reduce((sum, value) => sum + value, 0);
    return {
      frames: values.length,
      p50Ms: values[Math.floor(values.length * 0.5)] ?? 0,
      p95Ms: values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? 0,
      maxMs: Math.max(...values, 0),
      queryCalls: this.queryCalls,
      queryTotalMs: this.queryTotalMs,
      queryMaxMs: this.queryMaxMs,
      queryP95Ms: queries[Math.min(queries.length - 1, Math.floor(queries.length * 0.95))] ?? 0,
      renderNonQueryJsMs: Math.max(0, total - queryWindowTotal),
    };
  }
}
