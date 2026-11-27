import { minSample, maxSample } from '../libhakei/sample-index.js';
import { formatDuration, formatRate, formatSampleCount } from '../libhakei/units.js';
import type { TransferProgress } from '../libhakei/device.js';
import { scaleSamples } from '../libhakei/sample-index.js';
import { decoderDefinition, decoderDefinitions, hasDecoderDefinition } from '../decoders/index.js';
import { deviceCapture, importCapture, captureMemory, type Capture, type StageTiming } from './capture.js';
import { MemoryBudgetError, type BudgetSnapshot } from './memory.js';
import { DeviceControls } from './device-controls.js';
import { SignalControls } from './signal-controls.js';
import { driverDefinitions } from '../drivers/index.js';
import type { DriverDefinition } from '../drivers/definition.js';
import { DeviceClient } from './device-client.js';
import {
  DecodeClient,
  type DecodeGraphResult,
  type DecodeResult,
  type LiveDecodeGraphSession,
  type LiveDecodeSession,
} from './decode-client.js';
import { WaveformRenderer, timeLabel, frequencyLabel } from './renderer.js';
import { moveTimelineRow, type TimelineRow } from './timeline.js';
import { openAnalogSettings, openDigitalSettings } from './channel-controls.js';
import {
  buildDecoderMappingField,
  buildDecoderOptionField,
  openProtocolSettings,
  renderDecoderTracksSection,
  type DecoderMappingCandidate,
} from './protocol-controls.js';
import { parseAnalogSettings, type AnalogSettings } from './analog-settings.js';
import type { AnnotationIndex } from './event-index.js';
import { PagedAnnotationIndex } from './paged-annotation-index.js';
import type { DecoderId } from './protocol.js';
import type { ProtocolMappingValue, ProtocolSettings, WorkspaceSettings } from './workspace.js';
import { validateProtocolGraph } from './workspace.js';
import { normalizeHiddenRows, protocolRowId } from './protocol-tracks.js';
import type { DecodeGraphNode, ProtocolBinding } from '../decoders/definition.js';
import type { DecodeProgressMessage } from './protocol.js';
import type { OptionDeclaration, OptionValue } from '../libhakeidecode/types.js';
import { SearchSelect, decoderSearchText } from './search-select.js';
import './preferences.js';
import {
  errorLabel,
  hasMessage,
  numberLabel,
  t,
  translateDOM,
  UIError,
  type MessageKey,
  type MessageParams,
} from './i18n.js';

const FIRST_RUN_CAPTURE_KEY = 'hakei.firstRunCapture';
const PROTOCOLS_STORAGE_KEY = 'hakei.protocols.v1';
const WAVE_SETTINGS_VERSION = 1;

interface DigitalWaveSettings {
  name?: string;
  height?: number;
}
interface AnalogWaveSettings {
  name?: string;
  settings?: AnalogSettings;
}
type SavedRowEntry =
  | { kind: 'channel'; physical: number }
  | { kind: 'analog'; physical: number }
  | { kind: 'protocol'; id: string };

interface SavedProtocolsState {
  version: 1;
  driverId?: string;
  selectedId: string | null;
  protocols: ProtocolSettings[];
}

function rowOrderStorageKey(driverId: string): string {
  return `hakei.${driverId}.rowOrder.v1`;
}
function waveSettingsKey(driverId: string, kind: 'logic' | 'analog', channel: number): string {
  return `hakei.${driverId}.wave.v${WAVE_SETTINGS_VERSION}.${kind}.${channel}`;
}
function storedWaveSettings<T>(key: string): T | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}
function storeWaveSettings(key: string, value: DigitalWaveSettings | AnalogWaveSettings): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
function validWaveName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= 80 ? name : null;
}
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
}
function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export interface ProtocolInstance extends ProtocolSettings {
  client: DecodeClient;
  ownClient: DecodeClient;
  annotations: AnnotationIndex;
  frameCount: number;
  annotationCount: number;
  resultBytes: number;
  result: DecodeResult | null;
  state: 'ready' | 'decoding' | 'done' | 'cancelled' | 'error';
  progress: number;
  error: string | UIError | null;
  savedOptions: Record<DecoderId, Record<string, OptionValue>>;
  liveSession?: LiveDecodeSession | LiveDecodeGraphSession;
}
const colors = ['#70d7a1', '#efbc6b', '#79adff', '#d091eb', '#72c9df', '#ec8291', '#b3ca78', '#aca6eb'];
interface ProtocolGraphGroup {
  protocols: ProtocolInstance[];
  nodes: DecodeGraphNode[];
  channels: Record<string, number>;
}
function addStageTiming(stage: StageTiming, elapsed: number): void {
  stage.calls++;
  stage.totalMs += elapsed;
  stage.maxMs = Math.max(stage.maxMs, elapsed);
}
function declarations(decoder: DecoderId): readonly OptionDeclaration[] {
  if (!hasDecoderDefinition(decoder)) return [];
  const options = decoderDefinition(decoder).descriptor.options;
  if (!options) return [];
  return Array.isArray(options)
    ? (options as readonly OptionDeclaration[])
    : Object.entries(options).map(([id, value]) => ({ id, default: value }));
}
function defaults(decoder: DecoderId): Record<string, OptionValue> {
  return Object.fromEntries(declarations(decoder).map((option) => [option.id, option.default]));
}
function decoderName(decoder: DecoderId): string {
  const key = 'decoder.' + decoder + '.name';
  if (hasMessage(key)) return t(key);
  return hasDecoderDefinition(decoder) ? (decoderDefinition(decoder).descriptor.name ?? decoder) : decoder;
}
function parseSavedRowOrder(raw: unknown): SavedRowEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: SavedRowEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (
      (row.kind === 'channel' || row.kind === 'analog') &&
      typeof row.physical === 'number' &&
      Number.isInteger(row.physical) &&
      row.physical >= 0
    ) {
      entries.push({ kind: row.kind, physical: row.physical });
    } else if (row.kind === 'protocol' && typeof row.id === 'string' && row.id) {
      entries.push({ kind: 'protocol', id: row.id });
    }
  }
  return entries.length ? entries : null;
}

export class AnalyzerApp {
  protocols: ProtocolInstance[] = [];
  selectedId: string | null = null;
  get selectedProtocol(): ProtocolInstance | null {
    return this.protocols.find((p) => p.id === this.selectedId) ?? null;
  }
  get decoder(): DecoderId {
    return this.selectedProtocol?.decoder ?? decoderDefinitions[0]?.descriptor.id ?? '';
  }
  get result(): DecodeResult | null {
    return this.selectedProtocol?.result ?? null;
  }
  capture: Capture | null = null;
  state: 'ready' | 'loading' | 'decoding' | 'done' | 'cancelled' | 'error' = 'ready';
  readonly renderer = new WaveformRenderer(element('waveform'), element('overview'), element('time-axis'));
  private version = 0;
  private nextId = 0;
  private mappingChannels: readonly number[] = [];
  private mappingDevice = '';
  private selectingDeviceChannels = true;
  private readonly deviceClients = new Map<string, DeviceClient>();
  readonly deviceControls: DeviceControls;
  readonly signalControls: SignalControls;
  private readonly addDecoderPicker: SearchSelect;
  private readonly editDecoderPicker: SearchSelect;
  private captureAbort: AbortController | null = null;
  private decodeTimer: ReturnType<typeof setTimeout> | null = null;
  private captureStop: AbortController | null = null;
  private acquisitionMemory: BudgetSnapshot | null = null;
  private transferProgress: TransferProgress | null = null;
  private importAbort: AbortController | null = null;
  private saveAbort: AbortController | null = null;
  private firstRunCapturePending = false;
  private hasSavedProtocols = false;
  private draggedProtocolId: string | null = null;
  private readonly cachedRowOrders = new Map<string, SavedRowEntry[]>();
  private statusMessage: { key: MessageKey; params: MessageParams } = { key: 'status.ready', params: {} };
  private displayedMessage: string | UIError | { key: MessageKey; params?: MessageParams } = '';
  private messageIsError = false;
  private readonly onLocaleChange: () => void;
  private readonly onKeyDown: (event: KeyboardEvent) => void;

  constructor() {
    const initialClients = driverDefinitions.map((definition) => {
      const client = new DeviceClient(definition);
      this.deviceClients.set(definition.descriptor.id, client);
      return client;
    });
    this.deviceControls = new DeviceControls(element<HTMLFormElement>('device-form'), initialClients);
    this.signalControls = new SignalControls(this.deviceControls);
    this.addDecoderPicker = new SearchSelect(element<HTMLSelectElement>('add-decoder-type'));
    this.editDecoderPicker = new SearchSelect(element<HTMLSelectElement>('decoder-type'));

    this.firstRunCapturePending = this.claimFirstRunCapture();
    this.populateDecoderSelects();
    this.mappingChannels = [...this.deviceControls.selectedChannels('logic')];
    this.mappingDevice = this.deviceControls.device.descriptor.id;
    this.restoreProtocols();

    this.renderer.onChange = () => this.updateViewport();
    this.renderer.onProtocolOrderChange = () => {
      const order = new Map(this.renderer.protocols.map((protocol, index) => [protocol.id, index]));
      this.protocols.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      this.renderProtocolList();
      this.saveProtocols();
      this.saveRowOrder();
    };
    this.renderer.onAnalogSettings = (channel) => this.configureAnalog(channel);
    this.renderer.onDigitalSettings = (channel) => this.configureDigital(channel);
    this.renderer.onProtocolSettings = (id) => this.configureProtocol(id);
    this.renderer.onToggleProtocolCollapse = (id) => this.toggleProtocolCollapsed(id);
    this.renderer.onToggleProtocolRow = (id, rowId, visible) => this.setProtocolRowVisible(id, rowId, visible);
    this.renderer.onAnnotationClick = (id, ss, es) => {
      this.selectProtocol(id);
      if (ss !== this.renderer.start || es !== this.renderer.end) this.renderer.focus(ss, es);
    };
    this.onLocaleChange = () => this.refreshLocale();
    window.addEventListener('hakei:localechange', this.onLocaleChange);
    element('add-protocol').addEventListener('click', () => {
      const value = element<HTMLSelectElement>('add-decoder-type').value;
      if (value) this.addProtocol(value);
    });
    element('remove-protocol').addEventListener('click', () => {
      if (this.selectedId) this.removeProtocol(this.selectedId);
    });
    element<HTMLSelectElement>('decoder-type').addEventListener('change', () =>
      this.changeDecoder(element<HTMLSelectElement>('decoder-type').value),
    );
    element<HTMLInputElement>('protocol-name').addEventListener('input', () => {
      const protocol = this.selectedProtocol;
      if (!protocol) return;
      protocol.name =
        element<HTMLInputElement>('protocol-name').value.trim().slice(0, 80) || decoderName(protocol.decoder);
      this.renderProtocolList();
      this.saveProtocols();
      this.renderer.schedule();
    });
    element<HTMLInputElement>('protocol-color').addEventListener('input', () => {
      const protocol = this.selectedProtocol;
      if (!protocol) return;
      protocol.color = element<HTMLInputElement>('protocol-color').value;
      this.renderProtocolList();
      this.renderDecoderTracks();
      this.saveProtocols();
      this.renderer.schedule();
    });
    element<HTMLFormElement>('decoder-form').addEventListener('submit', (event) => {
      event.preventDefault();
    });
    element('decoder-decimals').addEventListener('change', () => {
      const protocol = this.selectedProtocol;
      if (!protocol) return;
      protocol.decimalPlaces = Number(element<HTMLSelectElement>('decoder-decimals').value);
      this.saveProtocols();
      this.updateDecodeSummary();
      this.renderer.schedule();
    });
    element('decoder-form').addEventListener('change', (event) => {
      if ((event.target as HTMLElement).id === 'decoder-decimals') return;
      if ((this.state === 'loading' && !this.captureAbort) || !this.selectedProtocol) return;
      const protocol = this.selectedProtocol;
      this.commitForm();
      this.scheduleProtocolDecode(protocol);
    });
    element('open-file').addEventListener('click', () => element<HTMLInputElement>('file-input').click());
    element('empty-open-file').addEventListener('click', () => element<HTMLInputElement>('file-input').click());
    element('empty-run-capture').addEventListener('click', () => {
      void this.startCapture();
    });
    const wavePanel = element('wave-panel');
    let waveDropDepth = 0;
    const hasDroppedFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    wavePanel.addEventListener('dragenter', (event) => {
      if (!hasDroppedFiles(event)) return;
      event.preventDefault();
      waveDropDepth++;
      wavePanel.classList.add('dragover');
    });
    wavePanel.addEventListener('dragover', (event) => {
      if (!hasDroppedFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      wavePanel.classList.add('dragover');
    });
    wavePanel.addEventListener('dragleave', (event) => {
      if (!hasDroppedFiles(event)) return;
      waveDropDepth = Math.max(0, waveDropDepth - 1);
      if (!waveDropDepth) wavePanel.classList.remove('dragover');
    });
    wavePanel.addEventListener('drop', (event) => {
      if (!hasDroppedFiles(event)) return;
      event.preventDefault();
      waveDropDepth = 0;
      wavePanel.classList.remove('dragover');
      const file = event.dataTransfer?.files?.[0];
      if (file) void this.openFile(file);
    });
    element<HTMLInputElement>('file-input').addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement,
        file = input.files?.[0];
      input.value = '';
      if (file) void this.openFile(file);
    });
    element<HTMLFormElement>('device-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.startCapture();
    });
    this.deviceControls.onConnectionChange = () => {
      this.signalControls.refresh();
      this.refreshProtocolMappings();
      this.renderChannelControls();
      this.renderStatus();
      this.runFirstCapture();
    };
    this.deviceControls.onChange = () => {
      this.cancelTask(false);
      this.selectingDeviceChannels = true;
      this.signalControls.refresh();
      this.refreshProtocolMappings();
      this.renderChannelControls();
      this.setStatus('ready', 'status.updated');
      this.updateMemoryUsage();
      this.runFirstCapture();
    };
    this.updateMemoryUsage();
    element('cancel').addEventListener('click', () => this.cancelTask());
    element('zoom-in').addEventListener('click', () => this.renderer.zoom(2));
    element('zoom-out').addEventListener('click', () => this.renderer.zoom(0.5));
    element('fit').addEventListener('click', () => this.renderer.fit());
    element('cursor-toggle').addEventListener('click', () => {
      this.renderer.cursorMode = !this.renderer.cursorMode;
      this.updateViewport();
      this.renderer.schedule();
    });
    element('cursor-clear').addEventListener('click', () => {
      this.renderer.cursorA = null;
      this.renderer.cursorB = null;
      this.renderer.cursorMode = false;
      this.updateViewport();
      this.renderer.schedule();
    });
    element('export-csv').addEventListener('click', () => {
      void this.exportCSV();
    });
    element('export-binary').addEventListener('click', () => {
      void this.exportBinary();
    });
    element('save-capture').addEventListener('click', () => {
      void this.saveCapture();
    });
    this.onKeyDown = (event) => {
      if ((event.target as HTMLElement)?.matches('input,select,textarea')) return;
      if (event.key === '+' || event.key === '=') this.renderer.zoom(2);
      else if (event.key === '-') this.renderer.zoom(0.5);
      else if (event.key === '0') this.renderer.fit();
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        this.renderer.pan(
          scaleSamples(this.renderer.end - this.renderer.start, event.key === 'ArrowLeft' ? -0.2 : 0.2),
        );
      } else if (event.key === 'Escape') this.cancelTask();
    };
    document.addEventListener('keydown', this.onKeyDown);
    this.syncTraces();
    this.selectProtocol(this.selectedId, false);
    this.refreshProtocolMappings();
    this.renderChannelControls();
    this.runFirstCapture();
  }

  dispose(): void {
    this.cancelTask(false);
    this.releaseCapture(this.capture);
    this.capture = null;
    for (const protocol of this.protocols) protocol.ownClient.cancel();
    window.removeEventListener('hakei:localechange', this.onLocaleChange);
    document.removeEventListener('keydown', this.onKeyDown);
    this.addDecoderPicker.dispose();
    this.editDecoderPicker.dispose();
    this.signalControls.dispose();
    this.deviceControls.dispose();
    for (const client of this.deviceClients.values()) client.dispose();
    this.deviceClients.clear();
    this.renderer.dispose();
  }

  refreshComponents(drivers?: readonly DriverDefinition[]): void {
    if (drivers) {
      const activeIds = new Set(drivers.map((item) => item.descriptor.id));
      for (const [id, client] of [...this.deviceClients]) {
        if (!activeIds.has(id)) {
          client.dispose();
          this.deviceClients.delete(id);
        }
      }
      const nextClients = drivers.map((definition) => {
        const existing = this.deviceClients.get(definition.descriptor.id);
        if (existing && existing.definition === definition) return existing;
        existing?.dispose();
        const created = new DeviceClient(definition);
        this.deviceClients.set(definition.descriptor.id, created);
        return created;
      });
      this.deviceControls.setDevices(nextClients);
    }
    this.populateDecoderSelects();
    this.signalControls.refreshDecoders();
    const removedIds = new Set(
      this.protocols.filter((protocol) => !hasDecoderDefinition(protocol.decoder)).map((protocol) => protocol.id),
    );
    if (removedIds.size) {
      for (const protocol of this.protocols) {
        if (removedIds.has(protocol.id)) {
          protocol.client.cancel();
          protocol.liveSession = undefined;
        }
      }
      this.protocols = this.protocols.filter((protocol) => !removedIds.has(protocol.id));
      for (const protocol of this.protocols) {
        for (const [key, value] of Object.entries(protocol.mapping)) {
          if (value && typeof value === 'object' && !Array.isArray(value) && removedIds.has(value.instanceId))
            delete protocol.mapping[key];
        }
      }
      if (this.selectedId && removedIds.has(this.selectedId)) this.selectedId = this.protocols[0]?.id ?? null;
      this.syncTraces();
    }
    this.selectProtocol(this.selectedId, false);
    this.refreshProtocolMappings();
    this.renderChannelControls();
    translateDOM();
  }

  private claimFirstRunCapture(): boolean {
    try {
      if (localStorage.getItem(FIRST_RUN_CAPTURE_KEY)) return false;
      localStorage.setItem(FIRST_RUN_CAPTURE_KEY, '1');
      return this.deviceControls.device.descriptor.id === 'demo';
    } catch {
      return false;
    }
  }
  private runFirstCapture(): void {
    if (!this.firstRunCapturePending) return;
    if (this.captureAbort || this.deviceControls.device.descriptor.id !== 'demo') {
      this.firstRunCapturePending = false;
      return;
    }
    if (!this.deviceControls.ready) return;
    this.firstRunCapturePending = false;
    if (!this.hasSavedProtocols && !this.protocols.length && hasDecoderDefinition('pwm')) {
      const pwm = this.addProtocol('pwm', false);
      pwm.mapping = { data: 0 };
      this.selectProtocol(pwm.id, false);
      this.saveProtocols();
    }
    void this.startCapture();
  }
  private restoreProtocols(): void {
    try {
      const raw = localStorage.getItem(PROTOCOLS_STORAGE_KEY);
      if (raw === null) {
        this.hasSavedProtocols = false;
        return;
      }
      this.hasSavedProtocols = true;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const saved = parsed as Partial<SavedProtocolsState>;
      if (!Array.isArray(saved.protocols)) return;
      const sameDevice = !saved.driverId || saved.driverId === this.mappingDevice;
      const logicCount = this.mappingChannels.length;
      const seenIds = new Set<string>();
      const restored: ProtocolInstance[] = [];
      for (const item of saved.protocols) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as Partial<ProtocolSettings>;
        if (
          typeof candidate.id !== 'string' ||
          !candidate.id ||
          seenIds.has(candidate.id) ||
          typeof candidate.decoder !== 'string' ||
          !hasDecoderDefinition(candidate.decoder)
        )
          continue;
        seenIds.add(candidate.id);
        const mapping: Record<string, ProtocolMappingValue> = {};
        if (candidate.mapping && typeof candidate.mapping === 'object' && !Array.isArray(candidate.mapping)) {
          for (const [key, value] of Object.entries(candidate.mapping)) {
            if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
              if (sameDevice && value < logicCount) mapping[key] = value;
            } else if (
              value &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              typeof value.instanceId === 'string' &&
              typeof value.protoId === 'string'
            ) {
              mapping[key] = { instanceId: value.instanceId, protoId: value.protoId };
            }
          }
        }
        const options: Record<string, OptionValue> = {};
        if (candidate.options && typeof candidate.options === 'object' && !Array.isArray(candidate.options)) {
          for (const [key, value] of Object.entries(candidate.options)) {
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
              options[key] = value;
          }
        }
        const definition = decoderDefinition(candidate.decoder);
        const hiddenRows = Array.isArray(candidate.hiddenRows)
          ? normalizeHiddenRows(
              definition,
              candidate.hiddenRows.filter((value): value is string => typeof value === 'string'),
            )
          : [];
        restored.push(
          this.createProtocol({
            id: candidate.id,
            decoder: candidate.decoder,
            name: validWaveName(candidate.name) ?? decoderName(candidate.decoder),
            color:
              typeof candidate.color === 'string' && /^#[0-9a-f]{6}$/i.test(candidate.color)
                ? candidate.color
                : colors[restored.length % colors.length]!,
            decimalPlaces:
              typeof candidate.decimalPlaces === 'number' &&
              Number.isInteger(candidate.decimalPlaces) &&
              candidate.decimalPlaces >= 0 &&
              candidate.decimalPlaces <= 9
                ? candidate.decimalPlaces
                : 3,
            ...(hiddenRows.length ? { hiddenRows } : {}),
            ...(typeof candidate.collapsed === 'boolean' && candidate.collapsed ? { collapsed: true } : {}),
            options,
            mapping,
          }),
        );
      }
      const validIds = new Set(restored.map((item) => item.id));
      for (const protocol of restored) {
        for (const [key, value] of Object.entries(protocol.mapping)) {
          if (value && typeof value === 'object' && !Array.isArray(value) && !validIds.has(value.instanceId))
            delete protocol.mapping[key];
        }
      }
      this.protocols = restored;
      this.nextId = Math.max(this.nextId, restored.length);
      this.selectedId =
        typeof saved.selectedId === 'string' && validIds.has(saved.selectedId)
          ? saved.selectedId
          : (restored[0]?.id ?? null);
    } catch {}
  }
  private saveProtocols(): void {
    this.hasSavedProtocols = true;
    try {
      const payload: SavedProtocolsState = {
        version: 1,
        driverId: this.mappingDevice || this.deviceControls.device.descriptor.id,
        selectedId: this.selectedId,
        protocols: this.protocols.map((protocol) => {
          const hiddenRows = hasDecoderDefinition(protocol.decoder)
            ? normalizeHiddenRows(decoderDefinition(protocol.decoder), protocol.hiddenRows)
            : [];
          return {
            id: protocol.id,
            decoder: protocol.decoder,
            name: protocol.name,
            color: protocol.color,
            decimalPlaces: protocol.decimalPlaces,
            ...(hiddenRows.length ? { hiddenRows } : {}),
            ...(protocol.collapsed ? { collapsed: true } : {}),
            options: { ...protocol.options },
            mapping: this.mappingFor(protocol),
          };
        }),
      };
      localStorage.setItem(PROTOCOLS_STORAGE_KEY, JSON.stringify(payload));
    } catch {}
  }
  private currentRowOrderDriverId(): string {
    return this.capture ? (this.capture.deviceChannels?.driverId ?? 'file') : this.deviceControls.device.descriptor.id;
  }
  private loadSavedRowOrder(driverId: string): SavedRowEntry[] | null {
    const cached = this.cachedRowOrders.get(driverId);
    if (cached) return cached.map((item) => ({ ...item }));
    try {
      const parsed = parseSavedRowOrder(JSON.parse(localStorage.getItem(rowOrderStorageKey(driverId)) ?? 'null'));
      if (parsed) this.cachedRowOrders.set(driverId, parsed);
      return parsed ? parsed.map((item) => ({ ...item })) : null;
    } catch {
      return null;
    }
  }
  private saveRowOrder(): void {
    const driverId = this.currentRowOrderDriverId();
    let entries: SavedRowEntry[];
    if (this.capture) {
      const capture = this.capture;
      entries = this.renderer.getRowOrder().map((row): SavedRowEntry => {
        if (row.kind === 'channel')
          return { kind: 'channel', physical: capture.deviceChannels?.logic[row.id] ?? row.id };
        if (row.kind === 'analog')
          return { kind: 'analog', physical: capture.deviceChannels?.analog[row.id] ?? row.id };
        return { kind: 'protocol', id: row.id };
      });
    } else {
      const existing = this.loadSavedRowOrder(driverId);
      if (!existing || !existing.some((entry) => entry.kind !== 'protocol')) return;
      const protocolIds = this.protocols.map((item) => item.id);
      const present = new Set(protocolIds);
      const queue = [...protocolIds];
      entries = existing.flatMap((entry): SavedRowEntry[] => {
        if (entry.kind !== 'protocol') return [entry];
        if (!present.has(entry.id)) return [];
        const next = queue.shift();
        return next ? [{ kind: 'protocol', id: next }] : [];
      });
      for (const id of queue) entries.push({ kind: 'protocol', id });
    }
    this.cachedRowOrders.set(driverId, entries);
    try {
      localStorage.setItem(rowOrderStorageKey(driverId), JSON.stringify(entries));
    } catch {}
  }
  private restoreRowOrder(capture: Capture): void {
    const driverId = capture.deviceChannels?.driverId ?? 'file';
    const saved = this.loadSavedRowOrder(driverId);
    if (!saved || !saved.some((entry) => entry.kind !== 'protocol')) return;
    const logicCount = capture.logicChannelCount ?? capture.store.channelCount;
    const analogCount = capture.analogChannels?.length ?? 0;
    const protocolIds = new Set(this.protocols.map((protocol) => protocol.id));
    const restored: TimelineRow[] = [];
    for (const entry of saved) {
      if (entry.kind === 'channel') {
        const id = capture.deviceChannels ? capture.deviceChannels.logic.indexOf(entry.physical) : entry.physical;
        if (id >= 0 && id < logicCount) restored.push({ kind: 'channel', id });
      } else if (entry.kind === 'analog') {
        const id = capture.deviceChannels ? capture.deviceChannels.analog.indexOf(entry.physical) : entry.physical;
        if (id >= 0 && id < analogCount) restored.push({ kind: 'analog', id });
      } else if (protocolIds.has(entry.id)) {
        restored.push({ kind: 'protocol', id: entry.id });
      }
    }
    if (restored.length) {
      this.renderer.rowOrder = restored;
      this.renderer.getRowOrder();
    }
  }
  private reorderProtocol(draggedId: string, targetId: string, after: boolean): void {
    if (draggedId === targetId) return;
    const fromIndex = this.protocols.findIndex((item) => item.id === draggedId);
    if (fromIndex < 0) return;
    const [moved] = this.protocols.splice(fromIndex, 1);
    const targetIndex = this.protocols.findIndex((item) => item.id === targetId);
    if (targetIndex < 0) {
      this.protocols.splice(fromIndex, 0, moved!);
      return;
    }
    this.protocols.splice(after ? targetIndex + 1 : targetIndex, 0, moved!);
    if (this.capture) {
      const current = this.renderer.getRowOrder();
      let before: TimelineRow | undefined;
      if (!after) {
        before = { kind: 'protocol', id: targetId };
      } else {
        const idx = current.findIndex((row) => row.kind === 'protocol' && row.id === targetId);
        before = idx >= 0 ? current[idx + 1] : undefined;
      }
      this.renderer.rowOrder = moveTimelineRow(current, { kind: 'protocol', id: draggedId }, before);
    }
    this.renderer.protocols = this.protocols;
    this.renderProtocolList();
    this.saveProtocols();
    this.saveRowOrder();
    this.renderer.schedule();
  }
  private populateDecoderSelects(): void {
    for (const id of ['add-decoder-type', 'decoder-type']) {
      const select = element<HTMLSelectElement>(id);
      const previous = select.value;
      select.replaceChildren();
      for (const definition of decoderDefinitions) {
        const option = document.createElement('option');
        option.value = definition.descriptor.id;
        const key = 'decoder.' + definition.descriptor.id + '.name';
        if (hasMessage(key)) {
          option.dataset.i18n = key;
          option.textContent = t(key);
        } else option.textContent = decoderName(definition.descriptor.id);
        option.dataset.search = decoderSearchText(definition);
        select.append(option);
      }
      if (previous && decoderDefinitions.some((definition) => definition.descriptor.id === previous))
        select.value = previous;
      else if (id === 'add-decoder-type' && hasDecoderDefinition('pwm')) select.value = 'pwm';
    }
    this.addDecoderPicker.refresh();
    this.editDecoderPicker.refresh();
  }
  addProtocol(decoder: DecoderId, decode = true): ProtocolInstance {
    if (this.protocols.length >= 100) {
      this.showMessage({ key: 'message.protocolLimit' });
      return this.protocols[this.protocols.length - 1]!;
    }
    const count = this.protocols.filter((p) => p.decoder === decoder).length;
    const protocol = this.createProtocol({
      id: `protocol-${++this.nextId}-${crypto.randomUUID()}`,
      decoder,
      name: decoderName(decoder) + (count ? ` ${count + 1}` : ''),
      color: colors[this.nextId % colors.length]!,
      options: defaults(decoder),
      mapping: {},
    });
    this.commitForm();
    this.protocols.push(protocol);
    this.syncTraces();
    this.selectProtocol(protocol.id, false);
    this.saveProtocols();
    this.saveRowOrder();
    if (decode) {
      if (this.captureAbort) this.scheduleLiveDecode();
      else void this.runProtocols([protocol]);
    }
    return protocol;
  }
  private createProtocol(settings: ProtocolSettings): ProtocolInstance {
    const client = new DecodeClient();
    const hiddenRows = hasDecoderDefinition(settings.decoder)
      ? normalizeHiddenRows(decoderDefinition(settings.decoder), settings.hiddenRows)
      : [];
    return {
      ...settings,
      decimalPlaces: settings.decimalPlaces ?? 3,
      ...(hiddenRows.length ? { hiddenRows } : { hiddenRows: undefined }),
      collapsed: !!settings.collapsed,
      options: { ...defaults(settings.decoder), ...settings.options },
      mapping: { ...settings.mapping },
      client,
      ownClient: client,
      annotations: new PagedAnnotationIndex(client, settings.id, () => {
        this.updateMemoryUsage();
        this.renderer.schedule();
      }),
      frameCount: 0,
      annotationCount: 0,
      resultBytes: 0,
      result: null,
      state: 'ready',
      progress: 0,
      error: null,
      savedOptions: {},
    };
  }
  removeProtocol(id: string): void {
    this.commitForm();
    const index = this.protocols.findIndex((p) => p.id === id);
    if (index < 0) return;
    const downstream = this.downstreamOf(id);
    if (this.captureAbort) this.cancelDecodeOnly();
    else this.cancelDecodes();
    this.protocols.splice(index, 1);
    for (const item of downstream) {
      for (const [key, value] of Object.entries(item.mapping))
        if (value && typeof value === 'object' && !Array.isArray(value) && value.instanceId === id)
          delete item.mapping[key];
      this.clearProtocol(item);
    }
    this.syncTraces();
    this.selectProtocol(this.protocols[Math.min(index, this.protocols.length - 1)]?.id ?? null, false);
    this.saveProtocols();
    this.saveRowOrder();
    this.setStatus(
      this.protocols.length && this.protocols.every((p) => p.state === 'done') ? 'done' : 'ready',
      'status.ready',
    );
  }
  selectProtocol(id: string | null, commit = true): void {
    if (id !== null && !this.protocols.some((p) => p.id === id)) return;
    if (commit) this.commitForm();
    this.selectedId = id;
    this.renderer.selectedProtocolId = id;
    this.renderer.decoder = this.decoder;
    element('protocol-editor').hidden = !this.selectedProtocol;
    element('protocol-empty').hidden = !!this.protocols.length;
    if (this.selectedProtocol) {
      element<HTMLSelectElement>('decoder-type').value = this.decoder;
      this.editDecoderPicker.refresh();
      element<HTMLInputElement>('protocol-name').value = this.selectedProtocol.name;
      element<HTMLInputElement>('protocol-color').value = this.selectedProtocol.color;
      element<HTMLSelectElement>('decoder-decimals').value = String(this.selectedProtocol.decimalPlaces ?? 3);
      this.createOptions();
      this.populateMapping();
      this.refreshDecoderUI();
    }
    this.renderProtocolList();
    this.updateDecodeSummary();
    this.renderStatus();
    this.renderer.schedule();
  }
  private syncTraces(): void {
    this.renderer.protocols = this.protocols;
    this.renderer.schedule();
  }
  private renderProtocolList(): void {
    const list = element('protocol-list');
    list.replaceChildren();
    for (const protocol of this.protocols) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'protocol-item' + (protocol.id === this.selectedId ? ' selected' : '');
      button.dataset.protocolId = protocol.id;
      button.draggable = true;
      button.setAttribute('aria-pressed', String(protocol.id === this.selectedId));
      const grip = document.createElement('span');
      grip.className = 'protocol-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.textContent = '⋮⋮';
      const dot = document.createElement('i');
      dot.style.backgroundColor = protocol.color;
      const name = document.createElement('span');
      name.textContent = protocol.name;
      name.title = protocol.name;
      const kind = document.createElement('small');
      kind.dataset.i18n = 'decoder.' + protocol.decoder + '.name';
      kind.textContent = decoderName(protocol.decoder);
      button.append(grip, dot, name, kind);
      button.addEventListener('click', () => {
        this.selectProtocol(protocol.id);
        this.saveProtocols();
      });
      button.addEventListener('keydown', (event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        const index = this.protocols.findIndex((item) => item.id === protocol.id);
        const neighbor = this.protocols[event.key === 'ArrowUp' ? index - 1 : index + 1];
        if (!neighbor) return;
        this.reorderProtocol(protocol.id, neighbor.id, event.key === 'ArrowDown');
        list.querySelector<HTMLElement>(`[data-protocol-id="${CSS.escape(protocol.id)}"]`)?.focus();
      });
      button.addEventListener('dragstart', (event) => {
        this.draggedProtocolId = protocol.id;
        button.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', protocol.id);
        }
      });
      button.addEventListener('dragover', (event) => {
        if (!this.draggedProtocolId || this.draggedProtocolId === protocol.id) return;
        event.preventDefault();
        const rect = button.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        button.classList.toggle('drop-before', !after);
        button.classList.toggle('drop-after', after);
      });
      button.addEventListener('dragleave', () => {
        button.classList.remove('drop-before', 'drop-after');
      });
      button.addEventListener('drop', (event) => {
        event.preventDefault();
        const sourceId = this.draggedProtocolId || event.dataTransfer?.getData('text/plain') || '';
        const rect = button.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        button.classList.remove('drop-before', 'drop-after');
        this.draggedProtocolId = null;
        if (sourceId && sourceId !== protocol.id) this.reorderProtocol(sourceId, protocol.id, after);
      });
      button.addEventListener('dragend', () => {
        this.draggedProtocolId = null;
        for (const item of list.querySelectorAll('.protocol-item'))
          item.classList.remove('dragging', 'drop-before', 'drop-after');
      });
      list.append(button);
    }
  }
  private createOptions(): void {
    element('decoder-options').replaceChildren();
    element('advanced-options').replaceChildren();
    const protocol = this.selectedProtocol;
    if (!protocol || !hasDecoderDefinition(protocol.decoder)) return;
    const primary = new Set(decoderDefinition(protocol.decoder).ui.primaryOptions ?? []);
    let advanced = 0;
    for (const option of declarations(protocol.decoder)) {
      const { label } = buildDecoderOptionField(
        protocol.decoder,
        option,
        protocol.options[option.id] ?? option.default,
        'option-',
      );
      if (primary.has(option.id)) element('decoder-options').append(label);
      else {
        element('advanced-options').append(label);
        advanced++;
      }
    }
    element('decoder-advanced').hidden = advanced === 0;
    translateDOM();
  }
  private commitForm(): void {
    const protocol = this.selectedProtocol;
    if (!protocol || !hasDecoderDefinition(protocol.decoder)) return;
    for (const option of declarations(protocol.decoder)) {
      const input = document.getElementById('option-' + option.id) as HTMLInputElement | HTMLSelectElement | null;
      if (input) protocol.options[option.id] = input.value;
    }
    for (const input of decoderDefinition(protocol.decoder).ui.inputs) {
      const select = document.getElementById('mapping-' + input.key) as HTMLSelectElement | null;
      if (select?.options.length) {
        if (select.value === '') delete protocol.mapping[input.key];
        else if (input.kind === 'protocol') protocol.mapping[input.key] = JSON.parse(select.value);
        else protocol.mapping[input.key] = Number(select.value);
      }
    }
  }
  private upstreamCandidates(): DecoderMappingCandidate[] {
    return this.protocols.flatMap((upstream) =>
      hasDecoderDefinition(upstream.decoder)
        ? [
            {
              id: upstream.id,
              name: upstream.name,
              outputs: decoderDefinition(upstream.decoder).descriptor.outputs ?? [],
            },
          ]
        : [],
    );
  }
  private mappingChannelCount(): number {
    return this.capture
      ? (this.capture.logicChannelCount ?? this.capture.store.channelCount)
      : this.deviceControls.configuration().logicChannels;
  }
  private populateMapping(): void {
    const protocol = this.selectedProtocol,
      capture = this.capture;
    if (!protocol || !hasDecoderDefinition(protocol.decoder)) return;
    const container = element('decoder-mapping');
    container.replaceChildren();
    const count = this.mappingChannelCount();
    const downstream = new Set(this.downstreamOf(protocol.id).map((item) => item.id));
    const candidates = this.upstreamCandidates();
    const logicChannels = this.deviceControls.selectedChannels('logic');
    for (const input of decoderDefinition(protocol.decoder).ui.inputs) {
      const { label } = buildDecoderMappingField({
        input,
        count,
        labels: capture?.labels,
        selectedLogicChannels: logicChannels,
        protocolId: protocol.id,
        downstreamIds: downstream,
        upstreamCandidates: candidates,
        value: protocol.mapping[input.key],
        idPrefix: 'mapping-',
      });
      container.append(label);
    }
    translateDOM();
  }
  private refreshProtocolMappings(): void {
    const capture = this.capture;
    const channels = capture
      ? (capture.deviceChannels?.logic ??
        Array.from({ length: capture.logicChannelCount ?? capture.store.channelCount }, (_, i) => i))
      : this.deviceControls.selectedChannels('logic');
    const device = capture ? (capture.deviceChannels?.driverId ?? 'file') : this.deviceControls.device.descriptor.id;
    for (const protocol of this.protocols) {
      if (!hasDecoderDefinition(protocol.decoder)) continue;
      const keys = new Set(decoderDefinition(protocol.decoder).ui.inputs.map((input) => input.key));
      for (const [key, value] of Object.entries(protocol.mapping)) {
        if (typeof value !== 'number') continue;
        const physical = this.mappingChannels[value],
          next = physical === undefined ? -1 : channels.indexOf(physical);
        if (!keys.has(key) || device !== this.mappingDevice || next < 0) delete protocol.mapping[key];
        else protocol.mapping[key] = next;
      }
    }
    this.mappingChannels = [...channels];
    this.mappingDevice = device;
    this.populateMapping();
  }
  changeDecoder(decoder: DecoderId): void {
    const protocol = this.selectedProtocol;
    if (!protocol || !hasDecoderDefinition(decoder) || decoder === protocol.decoder) return;
    this.commitForm();
    const downstream = this.downstreamOf(protocol.id);
    if (this.captureAbort) this.cancelDecodeOnly();
    else this.cancelDecodes();
    protocol.savedOptions[protocol.decoder] = { ...protocol.options };
    protocol.decoder = decoder;
    protocol.options = protocol.savedOptions[decoder] ?? defaults(decoder);
    protocol.hiddenRows = undefined;
    protocol.collapsed = false;
    const previous = protocol.mapping,
      next: Record<string, ProtocolMappingValue> = {},
      inputs = decoderDefinition(decoder).ui.inputs;
    for (const input of inputs) {
      const value = previous[input.key];
      if (input.kind === 'protocol' ? value && typeof value === 'object' : typeof value === 'number')
        next[input.key] = value!;
    }
    if (!Object.keys(next).length && inputs.length) {
      const first = Object.values(previous).find((value) => typeof value === 'number');
      if (first !== undefined && inputs[0]?.kind !== 'protocol') next[inputs[0]!.key] = first;
    }
    protocol.mapping = next;
    this.clearProtocol(protocol);
    for (const item of downstream) {
      for (const [key, value] of Object.entries(item.mapping))
        if (value && typeof value === 'object' && !Array.isArray(value) && value.instanceId === protocol.id)
          delete item.mapping[key];
      this.clearProtocol(item);
    }
    this.selectProtocol(protocol.id, false);
    this.saveProtocols();
    void this.startDecode();
  }
  private downstreamOf(id: string): ProtocolInstance[] {
    const result: ProtocolInstance[] = [];
    const seen = new Set<string>();
    const visit = (upstreamId: string): void => {
      for (const protocol of this.protocols) {
        if (seen.has(protocol.id)) continue;
        const dependent = Object.values(protocol.mapping).some(
          (value) =>
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            (value as ProtocolBinding).instanceId === upstreamId,
        );
        if (!dependent) continue;
        seen.add(protocol.id);
        result.push(protocol);
        visit(protocol.id);
      }
    };
    visit(id);
    return result;
  }
  private refreshDecoderUI(): void {
    const description = element('protocol-description');
    if (!this.decoder || !hasDecoderDefinition(this.decoder)) {
      description.textContent = '';
      element('decoder-display-options').hidden = true;
      element<HTMLSelectElement>('binary-output').hidden = true;
      return;
    }
    const definition = decoderDefinition(this.decoder);
    if (definition.ui.descriptionKey && hasMessage(definition.ui.descriptionKey))
      description.dataset.i18n = definition.ui.descriptionKey;
    else delete description.dataset.i18n;
    description.textContent =
      definition.ui.descriptionKey && hasMessage(definition.ui.descriptionKey)
        ? t(definition.ui.descriptionKey)
        : (definition.ui.description ?? definition.descriptor.desc ?? '');
    element('decoder-display-options').hidden = !definition.ui.decimals;
    const binary = element<HTMLSelectElement>('binary-output');
    binary.replaceChildren();
    for (const output of definition.ui.binaryOutputs ?? []) {
      const option = document.createElement('option');
      option.value = output.key;
      if (output.labelKey && hasMessage(output.labelKey)) option.dataset.i18n = output.labelKey;
      option.textContent = output.label;
      binary.append(option);
    }
    binary.hidden = !definition.ui.binaryOutputs?.length;
    this.renderDecoderTracks();
    translateDOM();
  }
  private renderDecoderTracks(): void {
    const container = element('decoder-tracks');
    const protocol = this.selectedProtocol;
    if (!protocol || !hasDecoderDefinition(protocol.decoder)) {
      delete container.dataset.protocolKey;
      container.replaceChildren();
      container.hidden = true;
      return;
    }
    renderDecoderTracksSection(container, {
      protocolId: protocol.id,
      decoder: protocol.decoder,
      color: protocol.color,
      definition: decoderDefinition(protocol.decoder),
      hiddenRows: protocol.hiddenRows,
      onToggleRow: (rowId, visible) => this.setProtocolRowVisible(protocol.id, rowId, visible),
      onSetAll: (visible) => this.setAllProtocolRowsVisible(protocol.id, visible),
    });
  }
  private setAllProtocolRowsVisible(id: string, visible: boolean): void {
    const protocol = this.protocols.find((item) => item.id === id);
    if (!protocol || !hasDecoderDefinition(protocol.decoder)) return;
    const definition = decoderDefinition(protocol.decoder);
    protocol.hiddenRows = visible ? undefined : definition.ui.rows.map((row, index) => protocolRowId(row, index));
    if (visible && protocol.collapsed) protocol.collapsed = false;
    if (protocol.id === this.selectedId) this.renderDecoderTracks();
    this.saveProtocols();
    this.renderer.schedule();
  }
  private setProtocolRowVisible(id: string, rowId: string, visible: boolean): void {
    const protocol = this.protocols.find((item) => item.id === id);
    if (!protocol || !hasDecoderDefinition(protocol.decoder)) return;
    const definition = decoderDefinition(protocol.decoder);
    const hidden = new Set(normalizeHiddenRows(definition, protocol.hiddenRows));
    if (visible) hidden.delete(rowId);
    else hidden.add(rowId);
    const next = normalizeHiddenRows(definition, [...hidden]);
    protocol.hiddenRows = next.length ? next : undefined;
    if (visible && protocol.collapsed) protocol.collapsed = false;
    if (protocol.id === this.selectedId) {
      this.renderDecoderTracks();
      translateDOM(element('decoder-tracks'));
    }
    this.saveProtocols();
    this.renderer.schedule();
  }
  private scheduleProtocolDecode(protocol: ProtocolInstance): void {
    this.saveProtocols();
    if (this.state === 'loading' && !this.captureAbort) return;
    if (this.decodeTimer) clearTimeout(this.decodeTimer);
    const affected = [protocol, ...this.downstreamOf(protocol.id)];
    if (this.captureAbort) this.cancelDecodeOnly();
    else this.cancelDecodes();
    for (const item of affected) this.clearProtocol(item);
    this.setStatus('ready', 'status.updated');
    this.decodeTimer = setTimeout(() => {
      this.decodeTimer = null;
      if (this.captureAbort) this.scheduleLiveDecode();
      else void this.runProtocols(affected);
    }, 180);
  }
  private configureProtocol(id: string): void {
    const protocol = this.protocols.find((item) => item.id === id);
    if (!protocol) return;
    this.selectProtocol(id);
    if (!hasDecoderDefinition(protocol.decoder)) return;
    const definition = decoderDefinition(protocol.decoder);
    const capture = this.capture;
    openProtocolSettings({
      protocol,
      definition,
      declarations: declarations(protocol.decoder),
      count: this.mappingChannelCount(),
      labels: capture?.labels,
      selectedLogicChannels: this.deviceControls.selectedChannels('logic'),
      downstreamIds: new Set(this.downstreamOf(protocol.id).map((item) => item.id)),
      upstreamCandidates: this.upstreamCandidates(),
      onIdentityChange: (name, color) => {
        protocol.name = name || decoderName(protocol.decoder);
        protocol.color = color;
        if (this.selectedId === protocol.id) {
          element<HTMLInputElement>('protocol-name').value = protocol.name;
          element<HTMLInputElement>('protocol-color').value = protocol.color;
          this.renderDecoderTracks();
        }
        this.renderProtocolList();
        this.saveProtocols();
        this.renderer.schedule();
      },
      onMappingChange: (key, value) => {
        if (value === undefined) delete protocol.mapping[key];
        else protocol.mapping[key] = value;
        if (this.selectedId === protocol.id) {
          const sidebarSelect = document.getElementById('mapping-' + key) as HTMLSelectElement | null;
          if (sidebarSelect) {
            sidebarSelect.value =
              value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
          }
        }
        this.scheduleProtocolDecode(protocol);
      },
      onOptionChange: (optId, value) => {
        protocol.options[optId] = value;
        if (this.selectedId === protocol.id) {
          const sidebarInput = document.getElementById('option-' + optId) as
            | HTMLInputElement
            | HTMLSelectElement
            | null;
          if (sidebarInput) sidebarInput.value = value;
        }
        this.scheduleProtocolDecode(protocol);
      },
      onDecimalsChange: (decimals) => {
        protocol.decimalPlaces = decimals;
        if (this.selectedId === protocol.id) {
          element<HTMLSelectElement>('decoder-decimals').value = String(decimals);
        }
        this.saveProtocols();
        this.updateDecodeSummary();
        this.renderer.schedule();
      },
      onToggleRow: (rowId, visible) => {
        this.setProtocolRowVisible(protocol.id, rowId, visible);
        return protocol.hiddenRows;
      },
      onSetAllRows: (visible) => {
        this.setAllProtocolRowsVisible(protocol.id, visible);
        return protocol.hiddenRows;
      },
      onRemove: () => this.removeProtocol(protocol.id),
    });
  }
  private toggleProtocolCollapsed(id: string): void {
    const protocol = this.protocols.find((item) => item.id === id);
    if (!protocol) return;
    protocol.collapsed = !protocol.collapsed;
    this.saveProtocols();
    this.renderer.schedule();
  }
  readOptions(protocol = this.selectedProtocol): Record<string, OptionValue> {
    if (!protocol) return {};
    return Object.fromEntries(
      declarations(protocol.decoder).map((option) => {
        const value = protocol.options[option.id] ?? option.default;
        if (typeof option.default === 'number' && (!String(value).trim() || !Number.isFinite(Number(value))))
          throw new UIError('error.option', {
            option: { key: ('decoder.' + protocol.decoder + '.option.' + option.id) as MessageKey },
          });
        return [
          option.id,
          typeof option.default === 'number'
            ? Number(value)
            : typeof option.default === 'boolean'
              ? String(value) === 'true'
              : value,
        ];
      }),
    );
  }
  private physicalMappingFor(protocol: ProtocolSettings): Record<string, number | string> {
    return Object.fromEntries(
      decoderDefinition(protocol.decoder).ui.inputs.flatMap((input) =>
        typeof protocol.mapping[input.key] === 'number' ? [[input.key, protocol.mapping[input.key] as number]] : [],
      ),
    );
  }
  private mappingFor(protocol: ProtocolSettings): Record<string, ProtocolMappingValue> {
    return { ...protocol.mapping };
  }
  private bindClient(protocol: ProtocolInstance, client: DecodeClient): void {
    protocol.client = client;
    if (protocol.annotations instanceof PagedAnnotationIndex) protocol.annotations.bind(client);
  }
  private protocolParents(protocol: ProtocolSettings): ProtocolInstance[] {
    const parents = new Map<string, ProtocolInstance>();
    for (const value of Object.values(protocol.mapping)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const parent = this.protocols.find((candidate) => candidate.id === value.instanceId);
      if (parent) parents.set(parent.id, parent);
    }
    return [...parents.values()];
  }
  private graphGroups(requested: readonly ProtocolInstance[]): ProtocolGraphGroup[] {
    const included = new Set(requested);
    const queue = [...requested];
    while (queue.length) {
      const protocol = queue.pop()!;
      for (const parent of this.protocolParents(protocol)) {
        if (included.has(parent)) continue;
        if (!this.hasInput(parent)) throw this.missingInputError(parent);
        included.add(parent);
        queue.push(parent);
      }
      for (const child of this.downstreamOf(protocol.id)) {
        if (included.has(child)) continue;
        included.add(child);
        queue.push(child);
      }
    }
    for (const protocol of included) if (!this.hasInput(protocol)) throw this.missingInputError(protocol);
    validateProtocolGraph([...included], true);

    const groups: ProtocolInstance[][] = [];
    const seen = new Set<string>();
    for (const start of included) {
      if (seen.has(start.id)) continue;
      const group: ProtocolInstance[] = [];
      const members = [start];
      seen.add(start.id);
      while (members.length) {
        const protocol = members.pop()!;
        group.push(protocol);
        const parents = new Set(this.protocolParents(protocol).map((item) => item.id));
        for (const candidate of included) {
          if (seen.has(candidate.id)) continue;
          const linked =
            parents.has(candidate.id) || this.protocolParents(candidate).some((parent) => parent.id === protocol.id);
          if (!linked) continue;
          seen.add(candidate.id);
          members.push(candidate);
        }
      }
      groups.push(group);
    }

    return groups.map((group) => {
      const remaining = new Set(group);
      const ordered: ProtocolInstance[] = [];
      while (remaining.size) {
        const next = [...remaining].find((protocol) =>
          this.protocolParents(protocol).every((parent) => !remaining.has(parent)),
        );
        if (!next) throw new UIError('error.protocolCycle');
        remaining.delete(next);
        ordered.push(next);
      }
      const channels: Record<string, number> = {};
      const nodes = ordered.map((protocol): DecodeGraphNode => {
        const inputs = decoderDefinition(protocol.decoder).ui.inputs;
        const bindings = Object.fromEntries(
          inputs.flatMap((input) => {
            const value = protocol.mapping[input.key];
            return input.kind === 'protocol' && value && typeof value === 'object' && !Array.isArray(value)
              ? [[input.key, { instanceId: value.instanceId, protoId: value.protoId }] as const]
              : [];
          }),
        );
        const mappedChannels: Record<string, string> = {};
        if (!inputs.some((input) => input.kind === 'protocol')) {
          for (const [key, value] of Object.entries(this.physicalMappingFor(protocol))) {
            if (typeof value !== 'number') continue;
            const source = `graph:${protocol.id}:${key}`;
            mappedChannels[key] = source;
            channels[source] = value;
          }
        }
        return {
          id: protocol.id,
          decoder: protocol.decoder,
          options: this.readOptions(protocol),
          ...(Object.keys(mappedChannels).length ? { channels: mappedChannels } : {}),
          ...(Object.keys(bindings).length ? { inputs: bindings } : {}),
        };
      });
      return { protocols: ordered, nodes, channels };
    });
  }
  stopCapture(): void {
    if (!this.captureStop || this.captureStop.signal.aborted) return;
    this.captureStop.abort();
    if (this.capture?.acquisition?.mode === 'continuous') {
      this.cancelDecodeOnly(true);
    }
    this.setStatus('loading', 'device.stopping');
  }
  async startCapture(): Promise<void> {
    if (this.captureAbort) {
      this.stopCapture();
      return;
    }
    if (!this.deviceControls.ready) return;
    if (!element<HTMLFormElement>('device-form').reportValidity()) return;
    if (this.deviceControls.device.descriptor.id === 'demo') {
      this.signalControls.sync();
      const error = this.signalControls.validate();
      if (error) {
        this.setStatus('error', 'device.captureError');
        this.showMessage(error, true);
        return;
      }
    }
    this.commitForm();
    this.cancelTask(false);
    const previous = this.capture;
    const previousViewport =
      previous && this.renderer.end > this.renderer.start
        ? { start: this.renderer.start, end: this.renderer.end, sampleRate: previous.store.samplerate }
        : null;
    const initialView = (capture: Capture): [bigint, bigint] | undefined => {
      if (!previousViewport) return undefined;
      const rate = BigInt(capture.store.samplerate),
        sourceRate = BigInt(previousViewport.sampleRate);
      const start = (previousViewport.start * rate) / sourceRate;
      const end = (previousViewport.end * rate + sourceRate - 1n) / sourceRate;
      const limit = capture.acquisition?.targetSamples ?? capture.store.length;
      return start >= 0n && end > start && end <= limit ? [start, end] : undefined;
    };
    const device = this.deviceControls.device,
      configuration = this.deviceControls.configuration(),
      mode = this.deviceControls.captureMode,
      deviceNameKey = `driver.${device.descriptor.id}.name`,
      nameKey = hasMessage(deviceNameKey) ? (deviceNameKey as MessageKey) : undefined;
    this.clearCaptureForAcquisition();
    const heading = element('capture-name');
    if (nameKey) heading.dataset.i18n = nameKey;
    else delete heading.dataset.i18n;
    heading.textContent = nameKey ? t(nameKey) : device.descriptor.name;
    const token = ++this.version,
      abort = new AbortController(),
      stop = new AbortController();
    this.captureAbort = abort;
    this.captureStop = stop;
    this.acquisitionMemory = null;
    this.setStatus('loading', 'device.acquiring');
    this.showMessage('');
    this.updateMemoryUsage();
    try {
      const capture = await deviceCapture(device, configuration, abort.signal, {
        mode,
        stopSignal: stop.signal,
        onTransferProgress: (progress) => {
          if (token !== this.version) return;
          this.transferProgress = progress;
          this.renderTransferProgress();
        },
        onProgress: (samples, memory) => {
          if (token !== this.version) return;
          this.acquisitionMemory = memory;
          this.updateMemoryUsage();
          if (!stop.signal.aborted && this.state !== 'decoding')
            this.setStatus('loading', mode === 'continuous' ? 'capture.continuousProgress' : 'capture.progress', {
              duration: formatDuration(Number(samples) / configuration.sampleRate),
              target: formatDuration(Number(configuration.sampleCount) / configuration.sampleRate),
              memory: (memory.usedBytes / 1048576).toFixed(2),
            });
        },
        onCapture: (capture) => {
          if (token !== this.version) return;
          capture.nameKey = nameKey;
          const diagnostics = capture.diagnostics;
          let stageStarted = performance.now();
          if (!this.capture) {
            this.setCapture(capture, false, true, initialView(capture));
            this.renderer.updateCapture(capture);
            this.updateViewport();
          } else {
            this.capture = capture;
            const labelsStarted = performance.now();
            this.updateCaptureLabels();
            if (diagnostics) addStageTiming(diagnostics.ui.captureLabels, performance.now() - labelsStarted);
            this.renderer.updateCapture(capture);
            this.updateViewport();
          }
          if (diagnostics) addStageTiming(diagnostics.ui.captureRefresh, performance.now() - stageStarted);
          this.acquisitionMemory = capture.acquisition?.memory ?? this.acquisitionMemory;
          stageStarted = performance.now();
          this.updateMemoryUsage();
          addStageTiming(capture.diagnostics!.ui.memoryRefresh, performance.now() - stageStarted);
          stageStarted = performance.now();
          this.scheduleLiveDecode();
          addStageTiming(capture.diagnostics!.ui.decodeScheduling, performance.now() - stageStarted);
        },
      });
      if (token !== this.version) {
        this.releaseCapture(capture);
        return;
      }
      this.captureAbort = null;
      this.captureStop = null;
      this.acquisitionMemory = null;
      capture.nameKey = nameKey;
      if (!this.capture) this.setCapture(capture, false, true, initialView(capture));
      else {
        this.capture = capture;
        this.flushLiveCaptureView();
        this.updateCaptureLabels();
      }
      this.setStatus('ready', 'status.ready');
      this.updateMemoryUsage();
      if (capture.store.length) {
        const live = new Set(this.protocols.filter((protocol) => protocol.liveSession));
        await this.finishLiveDecodes(capture);
        const remaining = this.protocols.filter((protocol) => !live.has(protocol));
        if (remaining.length) await this.runProtocols(remaining);
      }
      if (this.capture === capture && capture.acquisition?.stopReason !== 'complete') this.showCaptureOutcome();
    } catch (error) {
      if (token !== this.version) return;
      this.captureAbort = null;
      this.captureStop = null;
      this.acquisitionMemory = null;
      this.updateMemoryUsage();
      if (stop.signal.aborted && error === stop.signal.reason) {
        this.setStatus('ready', 'device.stopped');
        return;
      }
      this.setStatus('error', 'device.captureError');
      this.showMessage(
        error instanceof MemoryBudgetError
          ? { key: 'capture.reason.budget' }
          : error instanceof UIError
            ? error
            : errorLabel(error, 'error.capture'),
        true,
      );
    }
  }
  setCapture(capture: Capture, cancel = true, live = false, viewport?: readonly [bigint, bigint]): void {
    if (cancel) {
      this.cancelTask(false);
      this.transferProgress = null;
      this.renderTransferProgress();
    }
    if (this.capture && this.capture !== capture) this.releaseCapture(this.capture);
    this.capture = capture;
    this.selectingDeviceChannels = !!capture.deviceChannels;
    for (const protocol of this.protocols) {
      this.clearProtocol(protocol);
    }
    this.refreshProtocolMappings();
    if (capture.workspace) {
      this.protocols = capture.workspace.protocols.map((p) => this.createProtocol(p));
      this.selectedId = capture.workspace.selectedId;
      this.nextId += this.protocols.length;
    }
    this.syncTraces();
    this.renderer.setCapture(capture, viewport);
    if (!capture.workspace) {
      this.restoreWaveSettings(capture);
      this.restoreRowOrder(capture);
    }
    this.updateCaptureLabels();
    this.syncEmptyState();
    this.selectProtocol(this.selectedId, false);
    if (capture.workspace) {
      this.renderer.cursorA = capture.workspace.cursorA ?? capture.workspace.cursor;
      this.renderer.cursorB = capture.workspace.cursorB ?? null;
      this.renderer.channels = [...capture.workspace.channels];
      this.renderer.analogChannels = capture.workspace.analogChannels
        ? [...capture.workspace.analogChannels]
        : Array.from({ length: capture.analogChannels?.length ?? 0 }, (_, id) => id);
      this.renderer.rowOrder = capture.workspace.rowOrder?.map((row) => ({ ...row })) ?? [];
      this.renderer.setViewport(...capture.workspace.viewport);
    }
    this.renderChannelControls();
    if (!live) {
      this.showMessage('');
      this.setStatus('ready', 'status.ready');
      this.updateViewport();
      this.updateMemoryUsage();
      this.showCaptureOutcome();
    }
  }
  private renderChannelControls(): void {
    const capture = this.capture,
      selection = capture?.deviceChannels;
    const device = this.selectingDeviceChannels || !capture || !!selection;
    const matching = selection?.driverId === this.deviceControls.device.descriptor.id;
    const list = element('channel-list');
    list.replaceChildren();
    let enabled = 0;
    for (const kind of ['logic', 'analog'] as const) {
      const analog = kind === 'analog',
        prefix = analog ? 'A' : 'D';
      const capturedCount = analog
        ? (capture?.analogChannels?.length ?? 0)
        : capture
          ? (capture.logicChannelCount ?? capture.store.channelCount)
          : 0;
      const selected = this.deviceControls.selectedChannels(kind);
      const ids = device
        ? this.deviceControls.channelIndices(kind)
        : Array.from({ length: capturedCount }, (_, index) => index);
      for (const id of ids) {
        const index = device ? (matching ? selection![kind].indexOf(id) : -1) : id;
        const chip = document.createElement('label');
        chip.className = analog ? 'channel-chip analog-chip' : 'channel-chip';
        chip.style.setProperty('--channel-color', `var(--channel-${id % 8})`);
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.dataset.channelKind = kind;
        check.dataset.channelId = String(id);
        check.checked = device
          ? selected.includes(id)
          : analog
            ? this.renderer.analogChannels.includes(index)
            : this.renderer.channels.includes(index);
        check.disabled = !!this.captureAbort || (device && !this.deviceControls.channelAvailable(kind, id));
        check.setAttribute(
          'aria-label',
          t(device ? 'channels.capture' : 'channels.display', {
            channel: device ? this.deviceControls.channelName(kind, id) : `${prefix}${id}`,
          }),
        );
        if (check.checked) enabled++;
        const tag = document.createElement('strong');
        tag.textContent = device ? this.deviceControls.channelName(kind, id) : `${prefix}${id}`;
        chip.append(check, tag);
        if (capture && index >= 0) {
          const name = analog ? capture.analogChannels![index]!.name : capture.labels[index]!;
          const label = document.createElement('span');
          label.className = 'channel-name';
          label.textContent = name;
          label.title = name;
          chip.append(label);
          const configure = document.createElement('button');
          configure.type = 'button';
          configure.className = 'channel-settings';
          configure.textContent = '⚙';
          configure.setAttribute(
            'aria-label',
            `${t(analog ? 'analog.settings' : 'channels.digitalSettings')} · ${prefix}${id}`,
          );
          configure.title = configure.getAttribute('aria-label')!;
          configure.addEventListener('click', () =>
            analog ? this.configureAnalog(index) : this.configureDigital(index),
          );
          chip.append(configure);
        }
        check.addEventListener('change', () => {
          if (this.captureAbort) return;
          if (device) this.deviceControls.selectChannel(kind, id, check.checked);
          if (index >= 0) {
            const visible = new Set(analog ? this.renderer.analogChannels : this.renderer.channels);
            if (check.checked) visible.add(index);
            else visible.delete(index);
            if (analog) this.renderer.analogChannels = [...visible];
            else this.renderer.channels = [...visible];
            this.renderer.schedule();
          }
          element('channel-badge').textContent = String(list.querySelectorAll('input[type="checkbox"]:checked').length);
        });
        list.append(chip);
      }
    }
    element('channel-badge').textContent = String(enabled);
  }
  private updateChannelName(kind: 'logic' | 'analog', channel: number, name: string): HTMLElement | null {
    const capture = this.capture;
    if (!capture) return null;
    if (kind === 'logic') capture.labels[channel] = name;
    else capture.analogChannels![channel]!.name = name;
    const physical = capture.deviceChannels?.[kind][channel] ?? channel;
    const chip = element('channel-list')
      .querySelector<HTMLInputElement>(`input[data-channel-kind="${kind}"][data-channel-id="${physical}"]`)
      ?.closest<HTMLElement>('.channel-chip');
    const label = chip?.querySelector<HTMLElement>('.channel-name');
    if (label) {
      label.textContent = name;
      label.title = name;
    }
    this.refreshProtocolMappings();
    this.renderer.schedule();
    return label ? chip! : null;
  }
  private configureDigital(channel: number): void {
    const capture = this.capture,
      height = this.renderer.digitalHeights[channel];
    if (!capture || height === undefined) return;
    openDigitalSettings(
      capture.deviceChannels?.logic[channel] ?? channel,
      capture.labels[channel]!,
      height,
      (name, nextHeight) => {
        if (this.capture !== capture) return;
        this.updateChannelName('logic', channel, name);
        this.renderer.setDigitalHeight(channel, nextHeight);
        this.saveDigitalWaveSettings(capture, channel, name, nextHeight);
      },
      !this.captureAbort,
    );
  }
  private configureAnalog(channel: number): void {
    const capture = this.capture,
      item = capture?.analogChannels?.[channel];
    if (!capture || !item) return;
    openAnalogSettings(
      capture.deviceChannels?.analog[channel] ?? channel,
      item.name,
      this.renderer.analogSettings[channel]!,
      item.store.range,
      (name, settings) => {
        if (this.capture !== capture) return;
        const chip = this.updateChannelName('analog', channel, name);
        this.renderer.setAnalogSettings(channel, settings);
        this.saveAnalogWaveSettings(capture, channel, name, settings);
        if (chip) {
          chip.style.setProperty('--channel-color', settings.color);
        }
      },
      !this.captureAbort,
    );
  }
  private restoreWaveSettings(capture: Capture): void {
    const selection = capture.deviceChannels;
    if (!selection) return;
    selection.logic.forEach((physical, channel) => {
      const stored = storedWaveSettings<DigitalWaveSettings>(waveSettingsKey(selection.driverId, 'logic', physical));
      if (!stored) return;
      const name = validWaveName(stored.name);
      if (name !== null) capture.labels[channel] = name;
      const height = stored.height;
      if (typeof height === 'number' && Number.isInteger(height) && height >= 12 && height <= 250)
        this.renderer.setDigitalHeight(channel, height);
    });
    selection.analog.forEach((physical, channel) => {
      const item = capture.analogChannels?.[channel],
        stored = storedWaveSettings<AnalogWaveSettings>(waveSettingsKey(selection.driverId, 'analog', physical));
      if (!item || !stored) return;
      const name = validWaveName(stored.name);
      if (name !== null) item.name = name;
      if (stored.settings) {
        try {
          this.renderer.setAnalogSettings(channel, parseAnalogSettings(stored.settings));
        } catch {}
      }
    });
  }
  private saveDigitalWaveSettings(capture: Capture, channel: number, name: string, height: number): void {
    const selection = capture.deviceChannels,
      physical = selection?.logic[channel];
    if (!selection || physical === undefined) return;
    storeWaveSettings(waveSettingsKey(selection.driverId, 'logic', physical), { name, height });
  }
  private saveAnalogWaveSettings(capture: Capture, channel: number, name: string, settings: AnalogSettings): void {
    const selection = capture.deviceChannels,
      physical = selection?.analog[channel];
    if (!selection || physical === undefined) return;
    storeWaveSettings(waveSettingsKey(selection.driverId, 'analog', physical), { name, settings });
  }
  private clearCaptureForAcquisition(): void {
    const previous = this.capture;
    this.releaseCapture(previous);
    this.clearCaptureView();
  }
  private releaseCapture(capture: Capture | null): void {
    if (!capture) return;
    if ('dispose' in capture.store && typeof capture.store.dispose === 'function') capture.store.dispose();
  }
  private clearCaptureView(): void {
    this.transferProgress = null;
    this.renderTransferProgress();
    this.capture = null;
    this.refreshProtocolMappings();
    this.renderer.clearCapture();
    for (const protocol of this.protocols) this.clearProtocol(protocol);
    element('capture-name').dataset.i18n = 'capture.empty';
    element('capture-name').textContent = t('capture.empty');
    element('capture-streams').replaceChildren();
    element('duration-label').textContent = '—';
    element('view-range').textContent = '—';
    element('cursor-measurement').textContent = t('wave.hint');
    const memoryStatus = element('memory-status');
    memoryStatus.textContent = '—';
    memoryStatus.title = '';
    const renderStatus = element('render-status');
    renderStatus.textContent = '—';
    renderStatus.title = '';
    this.syncEmptyState();
    this.renderChannelControls();
    this.updateDecodeSummary();
    this.updateViewport();
    this.updateMemoryUsage();
    this.showMessage('');
  }
  async openFile(file: File): Promise<void> {
    this.commitForm();
    this.cancelTask(false);
    const token = ++this.version;
    this.importAbort = new AbortController();
    this.setStatus('loading', 'status.loading');
    this.showMessage('');
    try {
      const capture = await importCapture(file, 2_000_000, 8, undefined, this.importAbort.signal);
      if (token !== this.version) {
        this.releaseCapture(capture);
        return;
      }
      this.importAbort = null;
      this.setCapture(capture);
      await this.decodeAll();
    } catch (error) {
      if (token === this.version) {
        this.importAbort = null;
        this.setStatus('error', 'status.importError');
        this.showMessage(error instanceof UIError ? error : errorLabel(error), true);
      }
    }
  }
  private hasInput(protocol: ProtocolSettings): boolean {
    if (!hasDecoderDefinition(protocol.decoder)) return false;
    const definition = decoderDefinition(protocol.decoder),
      mapped = definition.ui.inputs.filter((input) => protocol.mapping[input.key] !== undefined);
    if (!mapped.length) return false;
    const usable = (input: (typeof definition.ui.inputs)[number]): boolean => {
      const value = protocol.mapping[input.key];
      return (
        input.optional ||
        (input.kind === 'protocol'
          ? !!value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            this.protocols.some((candidate) => candidate.id === value.instanceId)
          : typeof value === 'number')
      );
    };
    return definition.ui.inputRequirement === 'any' ? mapped.some(usable) : definition.ui.inputs.every(usable);
  }
  private missingInputError(protocol: ProtocolSettings): UIError {
    const missingProtocol = decoderDefinition(protocol.decoder).ui.inputs.some((input) => {
      if (input.kind !== 'protocol') return false;
      const value = protocol.mapping[input.key];
      return (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !this.protocols.some((candidate) => candidate.id === value.instanceId)
      );
    });
    return new UIError(missingProtocol ? 'error.protocolMapping' : 'error.noMapping');
  }
  async startDecode(): Promise<void> {
    if (
      !this.capture ||
      (this.state === 'loading' && !this.captureAbort) ||
      !this.selectedProtocol ||
      !element<HTMLFormElement>('decoder-form').reportValidity()
    )
      return;
    this.commitForm();
    if (!this.hasInput(this.selectedProtocol)) {
      this.showMessage(this.missingInputError(this.selectedProtocol), true);
      return;
    }
    if (this.captureAbort) {
      if (this.selectedProtocol.liveSession) {
        this.selectedProtocol.client.cancel();
        this.selectedProtocol.liveSession = undefined;
        this.selectedProtocol.state = 'ready';
      }
      if (this.selectedProtocol.state === 'error') this.selectedProtocol.state = 'ready';
      this.scheduleLiveDecode();
      return;
    }
    await this.runProtocols([this.selectedProtocol]);
  }
  async decodeAll(): Promise<void> {
    await this.runProtocols(this.protocols);
  }
  private flushLiveCaptureView(): void {
    if (this.capture) {
      this.renderer.updateCapture(this.capture);
      this.updateViewport();
    }
  }
  private scheduleLiveDecode(): void {
    const capture = this.capture;
    if (
      !this.captureAbort ||
      this.captureStop?.signal.aborted ||
      !capture ||
      (!capture.store.length && !capture.sharedSource?.publishedSamples)
    )
      return;
    let started = false;
    let groups: ProtocolGraphGroup[];
    try {
      groups = this.graphGroups(this.protocols);
    } catch (error) {
      this.showMessage(errorLabel(error), true);
      return;
    }
    const canStartLive = !capture.sharedSource || capture.sharedSource.acceptingConsumers !== false;
    for (const group of groups) {
      const protocols = group.protocols;
      if (capture.acquisition?.mode === 'continuous' && protocols.every((protocol) => protocol.state === 'error'))
        continue;
      const sessions = new Set(protocols.map((protocol) => protocol.liveSession).filter(Boolean));
      if (sessions.size !== 1 || protocols.some((protocol) => !protocol.liveSession)) {
        if (!canStartLive) continue;
        for (const client of new Set(protocols.map((protocol) => protocol.client))) client.cancel();
        for (const protocol of protocols) this.clearProtocol(protocol);
        const leader = protocols[0]!;
        for (const protocol of protocols) {
          this.bindClient(protocol, leader.ownClient);
          protocol.state = 'decoding';
        }
        try {
          const session = leader.ownClient.startLiveGraph(
            capture,
            group.nodes,
            group.channels,
            capture.sharedSource,
            (progress) => this.applyGraphProgress(protocols, progress),
          );
          for (const protocol of protocols) protocol.liveSession = session;
          started = true;
        } catch (error) {
          for (const protocol of protocols) {
            protocol.state = 'error';
            protocol.error = error instanceof UIError ? error : errorLabel(error);
          }
          this.showMessage(`${leader.name}: ${errorLabel(error)}`, true);
          continue;
        }
      }
      const session = protocols[0]!.liveSession;
      if (!session) continue;
      started = true;
      void session.advance(capture).catch((error) => {
        const active = protocols.some((protocol) => protocol.liveSession === session);
        if (!active) return;
        for (const protocol of protocols) {
          if (protocol.liveSession !== session) continue;
          protocol.liveSession = undefined;
          protocol.state = 'error';
          protocol.error = error instanceof UIError ? error : errorLabel(error);
          this.showMessage(`${protocol.name}: ${errorLabel(error)}`, true);
        }
        this.updateDecodeSummary();
      });
    }
    if (started && this.state !== 'decoding') this.setStatus('decoding', 'status.decoding');
    else this.updateDecodeSummary();
  }
  private applyGraphProgress(group: readonly ProtocolInstance[], progress: DecodeProgressMessage): void {
    for (const protocol of group) {
      const result = progress.instances?.[protocol.id];
      protocol.progress = progress.progress;
      if (!result) continue;
      protocol.frameCount = result.frames;
      protocol.annotationCount = result.annotations;
      protocol.resultBytes = result.resultBytes;
      if (protocol.annotations instanceof PagedAnnotationIndex) protocol.annotations.setTotal(result.annotations);
    }
    this.updateMemoryUsage();
    this.updateDecodeSummary();
    if (group.includes(this.selectedProtocol!)) this.renderer.schedule();
  }
  private applyGraphResult(protocol: ProtocolInstance, result: DecodeGraphResult): DecodeResult {
    const decoded: DecodeResult = {
      type: 'done',
      decoder: result.decoder,
      stats: result.stats,
      result: result.result,
    };
    protocol.result = decoded;
    protocol.frameCount = result.stats.frames;
    protocol.annotationCount = result.stats.annotations;
    protocol.resultBytes = result.stats.memory.totalBytes;
    protocol.state = 'done';
    protocol.progress = 1;
    protocol.error = null;
    if (protocol.annotations instanceof PagedAnnotationIndex) {
      protocol.annotations.setTotal(protocol.annotationCount);
      protocol.annotations.invalidate();
    }
    return decoded;
  }
  private async finishLiveDecodes(capture: Capture): Promise<boolean> {
    const pending = this.protocols.filter((protocol) => protocol.liveSession);
    if (!pending.length) return false;
    const sessions = new Map<LiveDecodeSession | LiveDecodeGraphSession, ProtocolInstance[]>();
    for (const protocol of pending) {
      const session = protocol.liveSession!;
      const group = sessions.get(session) ?? [];
      group.push(protocol);
      sessions.set(session, group);
    }
    this.setStatus('decoding', 'status.decoding');
    await Promise.all(
      [...sessions].map(async ([session, group]) => {
        try {
          const result = await session.finish(capture);
          if (Array.isArray(result)) {
            const byId = new Map(result.map((item) => [item.id, item]));
            for (const protocol of group) {
              const item = byId.get(protocol.id);
              if (!item || protocol.liveSession !== session) continue;
              const decoded = this.applyGraphResult(protocol, item);
              if (capture.diagnostics && decoded.stats.stages)
                capture.diagnostics.decodeWorker = { ...decoded.stats.stages };
              if (decoded.stats.truncated || decoded.stats.binaryTruncated)
                this.showMessage({ key: 'message.truncated' });
            }
          } else {
            const protocol = group[0];
            if (!protocol || protocol.liveSession !== session) return;
            const decoded = this.applyGraphResult(protocol, {
              id: protocol.id,
              decoder: protocol.decoder,
              stats: result.stats,
              result: result.result,
            });
            if (capture.diagnostics && decoded.stats.stages)
              capture.diagnostics.decodeWorker = { ...decoded.stats.stages };
            if (decoded.stats.truncated || decoded.stats.binaryTruncated)
              this.showMessage({ key: 'message.truncated' });
          }
          for (const protocol of group) if (protocol.liveSession === session) protocol.liveSession = undefined;
        } catch (error) {
          for (const protocol of group) {
            if (protocol.liveSession !== session) continue;
            protocol.liveSession = undefined;
            protocol.state = 'error';
            protocol.error = error instanceof UIError ? error : errorLabel(error);
            this.showMessage(`${protocol.name}: ${errorLabel(error)}`, true);
          }
        }
        this.updateDecodeSummary();
      }),
    );
    const failed = pending.some((protocol) => protocol.state === 'error');
    const elapsed = pending.reduce((sum, protocol) => sum + (protocol.result?.stats.elapsedMs ?? 0), 0);
    const samples = pending.reduce((sum, protocol) => sum + (protocol.result?.stats.samples ?? 0n), 0n);
    this.setStatus(failed ? 'error' : 'done', failed ? 'status.stopped' : 'status.done', {
      ms: elapsed.toFixed(0),
      throughput: (elapsed ? Number(samples) / elapsed / 1000 : 0).toFixed(2),
    });
    this.updateDecodeSummary();
    this.renderer.schedule();
    this.showCaptureOutcome();
    return true;
  }
  private async exportCSV(): Promise<void> {
    const capture = this.capture,
      protocol = this.selectedProtocol;
    if (!capture || !protocol || !protocol.frameCount) return;
    const name = 'hakei-' + protocol.decoder + '.csv';
    try {
      const picker = (
        window as Window & {
          showSaveFilePicker?: (options: {
            suggestedName: string;
            types: { description: string; accept: Record<string, string[]> }[];
          }) => Promise<{
            createWritable(): Promise<{
              write(data: string): Promise<void>;
              close(): Promise<void>;
              abort(): Promise<void>;
            }>;
          }>;
        }
      ).showSaveFilePicker;
      const writable = picker
        ? await picker({ suggestedName: name, types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] }).then(
            (file) => file.createWritable(),
          )
        : null;
      const parts: Blob[] = [];
      const pageSize = 20_000;
      try {
        for (let offset = 0; offset < protocol.frameCount; offset += pageSize) {
          const csv = await protocol.client.readCsv(
            offset,
            Math.min(pageSize, protocol.frameCount - offset),
            capture.store.samplerate,
            capture.triggerSample,
            offset === 0,
            protocol.id,
          );
          if (!csv) continue;
          if (writable) await writable.write(csv + '\r\n');
          else parts.push(new Blob([csv + '\r\n']));
        }
        if (writable) await writable.close();
        else downloadBlob(name, new Blob(parts, { type: 'text/csv;charset=utf-8' }));
      } catch (error) {
        await writable?.abort();
        throw error;
      }
    } catch (error) {
      this.showMessage(error instanceof UIError ? error : errorLabel(error), true);
    }
  }
  private cancelDecodeOnly(preserveLive = false): void {
    if (this.decodeTimer) clearTimeout(this.decodeTimer);
    this.decodeTimer = null;
    for (const protocol of this.protocols) {
      if (preserveLive && protocol.liveSession) continue;
      protocol.client.cancel();
      protocol.liveSession = undefined;
      if (protocol.state === 'decoding') protocol.state = 'cancelled';
    }
  }
  private cancelDecodes(target?: ProtocolInstance): void {
    if (this.decodeTimer) clearTimeout(this.decodeTimer);
    this.decodeTimer = null;
    ++this.version;
    for (const protocol of this.protocols) {
      if (protocol !== target && protocol.state !== 'decoding' && !protocol.liveSession) continue;
      protocol.client.cancel();
      protocol.liveSession = undefined;
      if (protocol.state === 'decoding') protocol.state = 'cancelled';
    }
  }
  private async runProtocols(protocols: readonly ProtocolInstance[]): Promise<void> {
    if (!this.capture || this.state === 'loading') return;
    this.cancelDecodes();
    const token = this.version,
      capture = this.capture;
    this.showMessage('');
    const candidates = [
      ...protocols,
      ...this.protocols.filter((p) => !protocols.includes(p) && (p.state === 'ready' || p.state === 'cancelled')),
    ];
    const incomplete = candidates.find((protocol) => !this.hasInput(protocol));
    if (incomplete) {
      this.setStatus('ready', 'status.ready');
      this.updateDecodeSummary();
      this.showMessage(`${incomplete.name}: ${errorLabel(this.missingInputError(incomplete))}`, true);
      return;
    }
    const pending = candidates;
    if (!pending.length) {
      this.setStatus('ready', 'status.ready');
      this.updateDecodeSummary();
      this.showCaptureOutcome();
      return;
    }
    let groups: ProtocolGraphGroup[];
    try {
      groups = this.graphGroups(pending);
    } catch (error) {
      this.setStatus('ready', 'status.ready');
      this.showMessage(errorLabel(error), true);
      return;
    }
    this.setStatus('decoding', 'status.decoding');
    let failed = false;
    let elapsed = 0,
      samples = 0n;
    for (const group of groups) {
      if (token !== this.version) return;
      const protocols = group.protocols;
      const leader = protocols[0]!;
      for (const protocol of protocols) {
        this.bindClient(protocol, leader.ownClient);
        this.clearProtocol(protocol);
        protocol.state = 'decoding';
      }
      this.updateDecodeSummary();
      try {
        const results = await leader.ownClient.runGraph(capture, group.nodes, group.channels, undefined, (progress) =>
          this.applyGraphProgress(protocols, progress),
        );
        if (token !== this.version) return;
        const byId = new Map(results.map((result) => [result.id, result]));
        for (const protocol of protocols) {
          const result = byId.get(protocol.id);
          if (!result) throw new Error('Protocol graph result is missing: ' + protocol.id);
          const decoded = this.applyGraphResult(protocol, result);
          if (decoded.stats.truncated || decoded.stats.binaryTruncated) this.showMessage({ key: 'message.truncated' });
        }
        elapsed += results[0]?.stats.elapsedMs ?? 0;
        samples += results[0]?.stats.samples ?? 0n;
      } catch (error) {
        if (token !== this.version) return;
        for (const protocol of protocols) {
          protocol.state = 'error';
          protocol.error = error instanceof UIError ? error : errorLabel(error);
        }
        failed = true;
        this.showMessage(`${leader.name}: ${errorLabel(error)}`, true);
      }
      this.updateDecodeSummary();
      this.renderer.schedule();
    }
    if (token !== this.version) return;
    this.setStatus(failed ? 'error' : 'done', failed ? 'status.stopped' : 'status.done', {
      ms: elapsed.toFixed(0),
      throughput: (elapsed ? Number(samples) / elapsed / 1000 : 0).toFixed(2),
    });
    this.updateDecodeSummary();
    this.showCaptureOutcome();
  }
  cancelTask(update = true): void {
    const cancellingCapture = !!this.captureAbort;
    ++this.version;
    for (const protocol of this.protocols) {
      protocol.client.cancel();
      protocol.liveSession = undefined;
      if (protocol.state === 'decoding') protocol.state = 'cancelled';
    }
    this.captureAbort?.abort();
    this.captureAbort = null;
    this.captureStop = null;
    this.acquisitionMemory = null;
    this.updateMemoryUsage();
    this.importAbort?.abort();
    this.importAbort = null;
    this.saveAbort?.abort();
    this.saveAbort = null;
    if (cancellingCapture) this.clearCaptureView();
    if (update) this.setStatus('cancelled', 'status.cancelled');
    else if (this.state === 'loading' || this.state === 'decoding') this.state = 'ready';
  }
  private clearProtocol(protocol: ProtocolInstance): void {
    protocol.frameCount = 0;
    protocol.annotationCount = 0;
    protocol.resultBytes = 0;
    protocol.result = null;
    protocol.annotations.clear();
    protocol.progress = 0;
    protocol.state = 'ready';
    protocol.error = null;
    this.renderer.schedule();
    this.updateDecodeSummary();
  }
  workspaceSettings(): WorkspaceSettings {
    this.commitForm();
    const rowOrder = this.renderer.getRowOrder();
    return {
      protocols: this.protocols.map((protocol) => {
        const hiddenRows = hasDecoderDefinition(protocol.decoder)
          ? normalizeHiddenRows(decoderDefinition(protocol.decoder), protocol.hiddenRows)
          : [];
        return {
          id: protocol.id,
          decoder: protocol.decoder,
          name: protocol.name,
          color: protocol.color,
          decimalPlaces: protocol.decimalPlaces,
          ...(hiddenRows.length ? { hiddenRows } : {}),
          ...(protocol.collapsed ? { collapsed: true } : {}),
          options: { ...protocol.options },
          mapping: this.mappingFor(protocol),
        };
      }),
      selectedId: this.selectedId,
      cursor: this.renderer.cursorA,
      cursorA: this.renderer.cursorA,
      cursorB: this.renderer.cursorB,
      viewport: [this.renderer.start, this.renderer.end],
      channels: [...this.renderer.channels],
      rowOrder,
      analogChannels: [...this.renderer.analogChannels],
      analogSettings: this.renderer.analogSettings.map((settings) => ({ ...settings })),
      digitalHeights: [...this.renderer.digitalHeights],
      ...(this.capture
        ? {
            channelNames: {
              digital: this.capture.labels.slice(0, this.capture.logicChannelCount ?? this.capture.store.channelCount),
              analog: (this.capture.analogChannels ?? []).map((channel) => channel.name),
            },
          }
        : {}),
    };
  }
  async saveCapture(): Promise<void> {
    if (!this.capture || this.saveAbort) return;
    const button = element<HTMLButtonElement>('save-capture'),
      capture = this.capture,
      workspace = this.workspaceSettings(),
      abort = new AbortController();
    this.saveAbort = abort;
    button.disabled = true;
    const progress = element<HTMLProgressElement>('save-fraction'),
      percent = element('save-percent');
    progress.value = 0;
    percent.textContent = '0%';
    element('save-progress').hidden = false;
    this.renderStatus();
    try {
      const exporter = capture.store as unknown as {
        exportSR?: (
          workspace: WorkspaceSettings | undefined,
          triggerSample: bigint,
          acquisition: Capture['acquisition'],
          signal?: AbortSignal,
          progress?: (fraction: number) => void,
        ) => Promise<Blob>;
      };
      if (!exporter.exportSR) throw new UIError('error.worker');
      const blob = await exporter.exportSR(
        workspace,
        capture.triggerSample,
        capture.acquisition,
        abort.signal,
        (fraction) => {
          if (this.saveAbort !== abort || abort.signal.aborted) return;
          progress.value = fraction;
          percent.textContent = `${Math.floor(fraction * 100)}%`;
        },
      );
      abort.signal.throwIfAborted();
      downloadBlob('capture.sr', blob);
    } catch (error) {
      if (!abort.signal.aborted) this.showMessage(error instanceof UIError ? error : errorLabel(error), true);
    } finally {
      if (this.saveAbort === abort) this.saveAbort = null;
      element('save-progress').hidden = !this.saveAbort;
      this.renderStatus();
    }
  }
  private async exportBinary(): Promise<void> {
    const protocol = this.selectedProtocol,
      key = element<HTMLSelectElement>('binary-output').value;
    if (!protocol?.result || protocol.result.result.binarySizes[key] === undefined) return;
    try {
      const blob = await protocol.client.readBinary(key, protocol.id);
      if (blob) downloadBlob('hakei-' + protocol.decoder + '-' + key + '.bin', blob);
    } catch (error) {
      this.showMessage(error instanceof UIError ? error : errorLabel(error), true);
    }
  }
  private setStatus(state: AnalyzerApp['state'], key: MessageKey, params: MessageParams = {}): void {
    this.state = state;
    this.statusMessage = { key, params };
    this.renderStatus();
  }
  private syncEmptyState(): void {
    const hasCapture = !!this.capture;
    element('wave-empty').hidden = hasCapture;
    element('time-axis').hidden = !hasCapture;
    element('capture-heading').classList.toggle('is-empty', !hasCapture && !this.captureAbort);
    element('capture-metrics').hidden = !hasCapture;
  }
  private renderStatus(): void {
    const message = t(this.statusMessage.key, this.statusMessage.params);
    element('decode-state').textContent = message;
    const statusText = element('status-text');
    statusText.textContent = message;
    statusText.title = message;
    const run = element<HTMLButtonElement>('run-capture');
    const runKey = this.captureAbort
      ? this.captureStop?.signal.aborted
        ? 'device.stopping'
        : 'device.stop'
      : 'device.run';
    run.dataset.i18n = runKey;
    run.textContent = t(runKey);
    run.formNoValidate = !!this.captureAbort;
    run.disabled = this.captureAbort
      ? !!this.captureStop?.signal.aborted
      : this.state === 'loading' || !this.deviceControls.ready;
    const emptyRun = element<HTMLButtonElement>('empty-run-capture');
    emptyRun.dataset.i18n = runKey;
    emptyRun.textContent = run.textContent;
    emptyRun.disabled = run.disabled;
    this.syncEmptyState();
    this.deviceControls.setBusy(!!this.captureAbort);
    this.signalControls.setBusy(!!this.captureAbort);
    for (const check of element('channel-list').querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      check.disabled = !!this.captureAbort;
    element<HTMLButtonElement>('save-capture').disabled = !this.capture?.store.length || !!this.saveAbort;
    element<HTMLButtonElement>('cancel').disabled =
      this.state !== 'decoding' && this.state !== 'loading' && !this.saveAbort;
  }
  private updateDecodeSummary(): void {
    const protocol = this.selectedProtocol,
      definition = protocol && hasDecoderDefinition(protocol.decoder) ? decoderDefinition(protocol.decoder) : null;
    element('frame-count').textContent = numberLabel(protocol?.frameCount ?? 0);
    element('text-preview').textContent =
      this.result && definition?.ui.summary
        ? definition.ui.summary(this.result.result, protocol?.decimalPlaces ?? 3, (key, fallback) =>
            hasMessage(key) ? t(key) : fallback,
          )
        : '';
    const key = element<HTMLSelectElement>('binary-output').value;
    element<HTMLButtonElement>('export-csv').disabled = !(protocol?.frameCount ?? 0);
    element<HTMLButtonElement>('export-binary').disabled = this.result?.result.binarySizes[key] === undefined;
  }
  showMessage(message: string | UIError | { key: MessageKey; params?: MessageParams }, error = false): void {
    this.displayedMessage = message;
    this.messageIsError = error;
    this.renderMessage();
  }
  private renderMessage(): void {
    const value = this.displayedMessage,
      node = element('message');
    const message =
      typeof value === 'string' ? value : value instanceof UIError ? errorLabel(value) : t(value.key, value.params);
    node.textContent = message;
    node.hidden = !message;
    node.classList.toggle('error', this.messageIsError);
  }
  private capturedDuration(): number {
    const capture = this.capture;
    if (!capture) return 0;
    let seconds = Number(capture.store.length) / capture.store.samplerate;
    for (const channel of capture.analogChannels ?? []) {
      const timing = channel.store.timing;
      const count = channel.store.nativeLength;
      if (timing && count)
        seconds = Math.max(seconds, Number(timing.firstTick + count * timing.periodTicks) / timing.clockHz);
    }
    return capture.acquisition
      ? Math.min(seconds, Number(capture.acquisition.targetSamples) / capture.store.samplerate)
      : seconds;
  }
  private updateCaptureLabels(): void {
    const capture = this.capture;
    if (!capture) return;
    delete element('capture-name').dataset.i18n;
    element('capture-name').textContent = capture.nameKey ? t(capture.nameKey) : capture.name;
    element('duration-label').textContent = formatDuration(this.capturedDuration());
    const streams = [
      ...((capture.logicChannelCount ?? capture.store.channelCount)
        ? [
            {
              name: t('capture.digital'),
              count: capture.store.length,
              rate: capture.store.samplerate,
            },
          ]
        : []),
      ...(capture.analogChannels ?? []).map((channel, index) => {
        const timing = channel.store.timing;
        const physical = capture.deviceChannels?.analog[index];
        const matching = capture.deviceChannels?.driverId === this.deviceControls.device.descriptor.id;
        return {
          name: matching && physical !== undefined ? this.deviceControls.channelName('analog', physical) : channel.name,
          count: channel.store.nativeLength ?? channel.store.length,
          rate: timing
            ? timing.clockHz / Number(timing.periodTicks)
            : channel.store.length
              ? channel.store.samplerate
              : NaN,
        };
      }),
    ];
    const container = element('capture-streams');
    container.replaceChildren();
    for (const stream of streams) {
      const metric = document.createElement('span');
      metric.dataset.captureStream = stream.name;
      const count = document.createElement('b');
      count.textContent = t('capture.sampleCount', { count: formatSampleCount(stream.count) });
      count.title = `${numberLabel(stream.count)} ${t('wave.samples')}`;
      const label = document.createElement('span');
      label.className = 'capture-stream-label';
      label.textContent = t('capture.streamTiming', {
        name: stream.name,
        rate: formatRate(stream.rate),
        duration: formatDuration(Number(stream.count) / stream.rate),
      });
      label.title = label.textContent;
      metric.append(count, label);
      container.append(metric);
    }
    const memoryStatus = element('memory-status');
    memoryStatus.textContent = t('status.memory', {
      memory: (captureMemory(capture).totalBytes / 1048576).toFixed(2),
      ms: capture.loadedMs.toFixed(1),
    });
    memoryStatus.title = memoryStatus.textContent;
    for (const input of element('channel-list').querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      const tag = input.closest('.channel-chip')?.querySelector('strong')?.textContent ?? '';
      input.setAttribute(
        'aria-label',
        t(this.selectingDeviceChannels || capture.deviceChannels ? 'channels.capture' : 'channels.display', {
          channel: tag,
        }),
      );
    }
  }
  private retainedDataBytes(): number {
    return (this.capture ? captureMemory(this.capture).totalBytes : 0) + this.retainedDecodeBytes();
  }
  private retainedDecodeBytes(): number {
    return this.protocols.reduce(
      (sum, protocol) =>
        sum +
        protocol.resultBytes +
        protocol.annotations.reservedBytes +
        (protocol.result
          ? Object.values(protocol.result.result.previews).reduce((bytes, preview) => bytes + preview.byteLength, 0)
          : 0),
      0,
    );
  }
  private updateMemoryUsage(): void {
    const shared = this.capture?.sharedSource;
    const bytes =
      (this.acquisitionMemory
        ? this.acquisitionMemory.usedBytes + this.retainedDecodeBytes()
        : this.retainedDataBytes()) + (shared?.allocatedBytes ?? 0);
    const storedSamples = this.capture?.store.length ?? 0n;
    const samples =
      shared?.publishedSamples && shared.publishedSamples > storedSamples ? shared.publishedSamples : storedSamples;
    const target = this.capture?.acquisition?.targetSamples ?? samples;
    const progress = target > 0n ? Number((samples * 10000n) / target) / 100 : 0;
    const usage = element('capture-memory-usage');
    usage.textContent = t(
      this.captureAbort && this.capture?.acquisition?.mode === 'continuous'
        ? 'capture.continuousMemory'
        : 'capture.memoryUsage',
      {
        used: (bytes / 1048576).toFixed(2),
        duration: formatDuration(
          Math.max(this.capturedDuration(), Number(samples) / (this.capture?.store.samplerate ?? 1)),
        ),
        progress: progress.toFixed(1),
      },
    );
    usage.title = usage.textContent;
  }
  private showCaptureOutcome(): void {
    const outcome = this.capture?.acquisition;
    if (!outcome || outcome.stopReason === 'complete') return;
    const failed = outcome.stopReason !== 'stopped';
    const reason =
      outcome.stopReason === 'error' && outcome.error
        ? { key: 'capture.reason.errorDetail' as const, params: { error: outcome.error } }
        : { key: `capture.reason.${outcome.stopReason}` as const };
    this.showMessage(
      {
        key: 'capture.partial',
        params: {
          actual: formatDuration(this.capturedDuration()),
          target: formatDuration(Number(outcome.targetSamples) / this.capture!.store.samplerate),
          reason,
        },
      },
      failed,
    );
    if (failed && this.state !== 'loading' && this.state !== 'decoding') this.setStatus('error', 'device.captureError');
  }
  private refreshLocale(): void {
    this.populateDecoderSelects();
    this.renderTransferProgress();
    this.updateMemoryUsage();
    this.refreshDecoderUI();
    this.renderProtocolList();
    this.updateDecodeSummary();
    this.updateCaptureLabels();
    this.renderStatus();
    this.renderMessage();
    this.updateViewport();
    this.renderer.schedule();
  }
  private renderTransferProgress(): void {
    const progress = this.transferProgress;
    element('usb-transfer').hidden = !progress;
    if (!progress) return;
    const short = progress.complete && progress.elapsedMs < 200;
    const key = progress.complete
      ? short
        ? 'capture.usbShortAverageRate'
        : 'capture.usbAverageRate'
      : 'capture.usbRate';
    const hint = short ? 'capture.usbShortTransfer' : 'capture.usbRateHint';
    const rate = progress.complete ? progress.averageBytesPerSecond : progress.bytesPerSecond;
    element('usb-transfer').dataset.i18nAttrs = `title:${hint}`;
    element('usb-transfer').title = t(hint);
    element('usb-rate').textContent = `${(rate / 1_000_000).toFixed(2)} MB/s`;
    element('usb-rate-label').dataset.i18n = key;
    element('usb-rate-label').textContent = t(key);
  }
  private updateViewport(): void {
    element('waveform').parentElement!.classList.toggle('cursor-mode', this.renderer.cursorMode);
    element('waveform').style.cursor = this.renderer.cursorMode ? 'crosshair' : '';
    element('cursor-toggle').classList.toggle('active', this.renderer.cursorMode);
    element('cursor-toggle').setAttribute('aria-pressed', String(this.renderer.cursorMode));
    if (!this.capture) {
      element('cursor-measurement').textContent = t('wave.hint');
      return;
    }
    const rate = this.capture.store.samplerate,
      trigger = this.capture.triggerSample,
      resolution = this.renderer.timeResolution();
    element('view-range').textContent =
      `${timeLabel(Number(this.renderer.start - trigger) / rate, resolution)} → ${timeLabel(Number(this.renderer.end - trigger) / rate, resolution)}`;
    const a = this.renderer.cursorA,
      b = this.renderer.cursorB;
    if (a === null && b === null) element('cursor-measurement').textContent = t('wave.hint');
    else if (a !== null && b !== null) {
      const start = minSample(a, b),
        end = maxSample(a, b),
        delta = Number(end - start) / rate;
      element('cursor-measurement').textContent =
        `${t('wave.start')}: ${timeLabel(Number(start - trigger) / rate, resolution)} · ${t('wave.end')}: ${timeLabel(Number(end - trigger) / rate, resolution)} · ${t('wave.delta')}: ${timeLabel(delta)} · ${t('wave.frequency')}: ${frequencyLabel(delta > 0 ? 1 / delta : Infinity)}`;
    } else {
      const sample = a ?? b!;
      element('cursor-measurement').textContent =
        `${t('wave.cursor')}: ${timeLabel(Number(sample - trigger) / rate, resolution)} · ${numberLabel(sample)} ${t('wave.samples')}`;
    }
    const renderStatus = element('render-status');
    renderStatus.textContent = t('wave.draw', { ms: this.renderer.metrics().p95Ms.toFixed(1) });
    renderStatus.title = renderStatus.textContent;
  }
}
