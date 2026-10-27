import { minSample, maxSample } from '../libhakei/sample-index.js';
import { scaleSamples } from '../libhakei/sample-index.js';
import { decoderDefinition, decoderDefinitions } from '../decoders/index.js';
import { deviceCapture, importCapture, captureMemory, type Capture, type StageTiming } from './capture.js';
import { MemoryBudgetError, type BudgetSnapshot } from './memory.js';
import { DeviceControls } from './device-controls.js';
import { driverDefinitions } from '../drivers/index.js';
import { DeviceClient } from './device-client.js';
import { DecodeClient, type DecodeResult, type LiveDecodeSession } from './decode-client.js';
import { WaveformRenderer, timeLabel, frequencyLabel } from './renderer.js';
import { openAnalogSettings, openDigitalSettings } from './channel-controls.js';
import type { AnnotationIndex } from './event-index.js';
import { PagedAnnotationIndex } from './paged-annotation-index.js';
import type { DecoderId } from './protocol.js';
import type { ProtocolSettings, WorkspaceSettings } from './workspace.js';
import type { OptionDeclaration, OptionValue } from '../libhakeidecode/types.js';
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
  annotations: AnnotationIndex;
  frameCount: number;
  annotationCount: number;
  resultBytes: number;
  result: DecodeResult | null;
  state: 'ready' | 'decoding' | 'done' | 'cancelled' | 'error';
  progress: number;
  error: string | UIError | null;
  savedOptions: Record<DecoderId, Record<string, OptionValue>>;
  liveSession?: LiveDecodeSession;
}
const colors = ['#70d7a1', '#efbc6b', '#79adff', '#d091eb', '#72c9df', '#ec8291', '#b3ca78', '#aca6eb'];
function addStageTiming(stage: StageTiming, elapsed: number): void {
  stage.calls++;
  stage.totalMs += elapsed;
  stage.maxMs = Math.max(stage.maxMs, elapsed);
}
function declarations(decoder: DecoderId): readonly OptionDeclaration[] {
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
  return hasMessage(key) ? t(key) : (decoderDefinition(decoder).descriptor.name ?? decoder);
}
function binaryBytes(result: DecodeResult): number {
  return Object.values(result.result.binarySizes).reduce((sum, bytes) => sum + bytes, 0);
}
export class AnalyzerApp {
  protocols: ProtocolInstance[] = [];
  selectedId: string | null = null;
  get selectedProtocol(): ProtocolInstance | null {
    return this.protocols.find((p) => p.id === this.selectedId) ?? null;
  }
  get decoder(): DecoderId {
    return this.selectedProtocol?.decoder ?? decoderDefinitions[0]!.descriptor.id;
  }
  get result(): DecodeResult | null {
    return this.selectedProtocol?.result ?? null;
  }
  capture: Capture | null = null;
  state: 'ready' | 'loading' | 'decoding' | 'done' | 'cancelled' | 'error' = 'ready';
  readonly renderer = new WaveformRenderer(element('waveform'), element('overview'), element('time-axis'));
  private version = 0;
  private decodeVersion = 0;
  private nextId = 0;
  private mappingChannels: readonly number[] = [];
  private mappingDevice = '';
  private selectingDeviceChannels = true;
  readonly deviceControls = new DeviceControls(
    element<HTMLFormElement>('device-form'),
    driverDefinitions.map((definition) => new DeviceClient(definition)),
  );
  private captureAbort: AbortController | null = null;
  private captureStop: AbortController | null = null;
  private acquisitionMemory: BudgetSnapshot | null = null;
  private importAbort: AbortController | null = null;
  private saveAbort: AbortController | null = null;
  private decodeTimer: ReturnType<typeof setTimeout> | null = null;
  private statusMessage: { key: MessageKey; params: MessageParams } = { key: 'status.ready', params: {} };
  private displayedMessage: string | UIError | { key: MessageKey; params?: MessageParams } = '';
  private messageIsError = false;
  constructor() {
    this.populateDecoderSelects();
    this.renderer.onChange = () => this.updateViewport();
    this.renderer.onProtocolOrderChange = () => {
      const order = new Map(this.renderer.protocols.map((protocol, index) => [protocol.id, index]));
      this.protocols.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      this.renderProtocolList();
    };
    this.renderer.onAnalogSettings = (channel) => this.configureAnalog(channel);
    this.renderer.onDigitalSettings = (channel) => this.configureDigital(channel);
    this.renderer.onProtocolSettings = (id) => this.selectProtocol(id);
    this.renderer.onAnnotationClick = (id, ss, es) => {
      this.selectProtocol(id);
      if (ss !== this.renderer.start || es !== this.renderer.end) this.renderer.focus(ss, es);
    };
    window.addEventListener('hakei:localechange', () => this.refreshLocale());
    element('add-protocol').addEventListener('click', () =>
      this.addProtocol(element<HTMLSelectElement>('add-decoder-type').value),
    );
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
      this.renderer.schedule();
    });
    element<HTMLInputElement>('protocol-color').addEventListener('input', () => {
      const protocol = this.selectedProtocol;
      if (!protocol) return;
      protocol.color = element<HTMLInputElement>('protocol-color').value;
      this.renderProtocolList();
      this.renderer.schedule();
    });
    element<HTMLFormElement>('decoder-form').addEventListener('submit', (event) => {
      event.preventDefault();
    });
    element('decoder-decimals').addEventListener('change', () => {
      const protocol = this.selectedProtocol;
      if (!protocol) return;
      protocol.decimalPlaces = Number(element<HTMLSelectElement>('decoder-decimals').value);
      this.updateDecodeSummary();
      this.renderer.schedule();
    });
    element('decoder-form').addEventListener('change', (event) => {
      if ((event.target as HTMLElement).id === 'decoder-decimals') return;
      if ((this.state === 'loading' && !this.captureAbort) || !this.selectedProtocol) return;
      const protocol = this.selectedProtocol;
      this.commitForm();
      if (this.captureAbort) this.cancelDecodeOnly();
      else this.cancelDecodes(protocol);
      this.clearProtocol(protocol);
      this.setStatus('ready', 'status.updated');
      this.decodeTimer = setTimeout(() => {
        this.decodeTimer = null;
        if (this.captureAbort) this.scheduleLiveDecode();
        else void this.runProtocols([protocol]);
      }, 180);
    });
    element('open-file').addEventListener('click', () => element<HTMLInputElement>('file-input').click());
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
    this.deviceControls.onConnectionChange = () => this.renderStatus();
    this.deviceControls.onChange = () => {
      this.cancelTask(false);
      this.selectingDeviceChannels = true;
      this.refreshProtocolMappings();
      this.renderChannelControls();
      this.setStatus('ready', 'status.updated');
      this.updateMemoryUsage();
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
    document.addEventListener('keydown', (event) => {
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
    });
    this.selectProtocol(null, false);
    this.refreshProtocolMappings();
    this.renderChannelControls();
  }
  private populateDecoderSelects(): void {
    for (const id of ['add-decoder-type', 'decoder-type']) {
      const select = element<HTMLSelectElement>(id);
      select.replaceChildren();
      for (const definition of decoderDefinitions) {
        const option = document.createElement('option');
        option.value = definition.descriptor.id;
        const key = 'decoder.' + definition.descriptor.id + '.name';
        if (hasMessage(key)) {
          option.dataset.i18n = key;
          option.textContent = t(key);
        } else option.textContent = decoderName(definition.descriptor.id);
        select.append(option);
      }
    }
  }
  addProtocol(decoder: DecoderId, decode = true): ProtocolInstance {
    if (this.protocols.length >= 100) {
      this.showMessage({ key: 'message.protocolLimit' });
      return this.protocols[this.protocols.length - 1];
    }
    const count = this.protocols.filter((p) => p.decoder === decoder).length;
    const protocol = this.createProtocol({
      id: `protocol-${++this.nextId}-${crypto.randomUUID()}`,
      decoder,
      name: decoderName(decoder) + (count ? ` ${count + 1}` : ''),
      color: colors[this.nextId % colors.length],
      options: defaults(decoder),
      mapping: {},
    });
    this.commitForm();
    this.protocols.push(protocol);
    this.syncTraces();
    this.selectProtocol(protocol.id, false);
    if (decode) {
      if (this.captureAbort) this.scheduleLiveDecode();
      else void this.runProtocols([protocol]);
    }
    return protocol;
  }
  private createProtocol(settings: ProtocolSettings): ProtocolInstance {
    const client = new DecodeClient();
    return {
      ...settings,
      decimalPlaces: settings.decimalPlaces ?? 3,
      options: { ...defaults(settings.decoder), ...settings.options },
      mapping: { ...settings.mapping },
      client,
      annotations: new PagedAnnotationIndex(client),
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
    const protocol = this.protocols[index]!;
    if (this.captureAbort) this.cancelDecodeOnly();
    else this.cancelDecodes(protocol);
    this.protocols.splice(index, 1);
    this.syncTraces();
    this.selectProtocol(this.protocols[Math.min(index, this.protocols.length - 1)]?.id ?? null, false);
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
      button.setAttribute('aria-pressed', String(protocol.id === this.selectedId));
      const dot = document.createElement('i');
      dot.style.backgroundColor = protocol.color;
      const name = document.createElement('span');
      name.textContent = protocol.name;
      name.title = protocol.name;
      const kind = document.createElement('small');
      kind.dataset.i18n = 'decoder.' + protocol.decoder + '.name';
      kind.textContent = decoderName(protocol.decoder);
      button.append(dot, name, kind);
      button.addEventListener('click', () => this.selectProtocol(protocol.id));
      list.append(button);
    }
  }
  private createOptions(): void {
    element('decoder-options').replaceChildren();
    element('advanced-options').replaceChildren();
    const protocol = this.selectedProtocol;
    if (!protocol) return;
    const primary = new Set(decoderDefinition(protocol.decoder).ui.primaryOptions ?? []);
    let advanced = 0;
    for (const option of declarations(protocol.decoder)) {
      const label = document.createElement('label');
      label.className = 'field';
      const caption = document.createElement('span');
      if (hasMessage('decoder.' + protocol.decoder + '.option.' + option.id))
        caption.dataset.i18n = 'decoder.' + protocol.decoder + '.option.' + option.id;
      caption.textContent = option.desc ?? option.id;
      label.append(caption);
      let input: HTMLInputElement | HTMLSelectElement;
      if (option.values) {
        input = document.createElement('select');
        for (const value of option.values) {
          const item = document.createElement('option');
          item.value = String(value);
          item.textContent = String(value);
          if (hasMessage('decoder.' + protocol.decoder + '.value.' + value))
            item.dataset.i18n = 'decoder.' + protocol.decoder + '.value.' + value;
          input.append(item);
        }
      } else {
        input = document.createElement('input');
        input.type = typeof option.default === 'number' ? 'number' : 'text';
        input.step = option.step === 'any' ? 'any' : String(option.step ?? 1);
        if (option.min !== undefined) input.min = String(option.min);
        if (option.max !== undefined) input.max = String(option.max);
        input.required = !!option.required;
      }
      input.id = 'option-' + option.id;
      input.value = String(protocol.options[option.id] ?? option.default);
      if (hasMessage('decoder.' + protocol.decoder + '.option.' + option.id))
        input.dataset.i18nAttrs = 'aria-label:decoder.' + protocol.decoder + '.option.' + option.id;
      label.append(input);
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
    if (!protocol) return;
    for (const option of declarations(protocol.decoder)) {
      const input = document.getElementById('option-' + option.id) as HTMLInputElement | HTMLSelectElement | null;
      if (input) protocol.options[option.id] = input.value;
    }
    for (const input of decoderDefinition(protocol.decoder).ui.inputs) {
      const select = document.getElementById('mapping-' + input.key) as HTMLSelectElement | null;
      if (select?.options.length) {
        if (select.value === '') delete protocol.mapping[input.key];
        else protocol.mapping[input.key] = Number(select.value);
      }
    }
  }
  private populateMapping(): void {
    const protocol = this.selectedProtocol,
      capture = this.capture;
    if (!protocol) return;
    const container = element('decoder-mapping');
    container.replaceChildren();
    const count = capture
      ? (capture.logicChannelCount ?? capture.store.channelCount)
      : this.deviceControls.configuration().logicChannels;
    for (const input of decoderDefinition(protocol.decoder).ui.inputs) {
      const label = document.createElement('label');
      label.className = 'field';
      const caption = document.createElement('span');
      if (input.labelKey && hasMessage(input.labelKey)) caption.dataset.i18n = input.labelKey;
      caption.textContent = input.label;
      label.append(caption);
      const select = document.createElement('select');
      select.id = 'mapping-' + input.key;
      if (input.labelKey && hasMessage(input.labelKey)) select.dataset.i18nAttrs = 'aria-label:' + input.labelKey;
      const none = document.createElement('option');
      none.value = '';
      none.dataset.i18n = 'channels.none';
      none.textContent = t('channels.none');
      select.append(none);
      for (let i = 0; i < count; i++) {
        const item = document.createElement('option'),
          labelText = capture?.labels[i] ?? 'D' + this.deviceControls.selectedChannels('logic')[i];
        item.value = String(i);
        item.textContent = labelText;
        select.append(item);
      }
      select.value =
        protocol.mapping[input.key] !== undefined && protocol.mapping[input.key]! < count
          ? String(protocol.mapping[input.key])
          : '';
      label.append(select);
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
      const keys = new Set(decoderDefinition(protocol.decoder).ui.inputs.map((input) => input.key));
      for (const [key, value] of Object.entries(protocol.mapping)) {
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
    if (
      !protocol ||
      !decoderDefinitions.some((definition) => definition.descriptor.id === decoder) ||
      decoder === protocol.decoder
    )
      return;
    this.commitForm();
    if (this.captureAbort) this.cancelDecodeOnly();
    else this.cancelDecodes(protocol);
    protocol.savedOptions[protocol.decoder] = { ...protocol.options };
    protocol.decoder = decoder;
    protocol.options = protocol.savedOptions[decoder] ?? defaults(decoder);
    const previous = protocol.mapping,
      next: Record<string, number> = {},
      inputs = decoderDefinition(decoder).ui.inputs;
    for (const input of inputs) if (previous[input.key] !== undefined) next[input.key] = previous[input.key]!;
    if (!Object.keys(next).length && inputs.length) {
      const first = Object.values(previous)[0];
      if (first !== undefined) next[inputs[0]!.key] = first;
    }
    protocol.mapping = next;
    this.clearProtocol(protocol);
    this.selectProtocol(protocol.id, false);
    void this.startDecode();
  }
  private refreshDecoderUI(): void {
    const definition = decoderDefinition(this.decoder),
      description = element('protocol-description');
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
    translateDOM();
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
  private mappingFor(protocol: ProtocolSettings): Record<string, number> {
    return Object.fromEntries(
      decoderDefinition(protocol.decoder).ui.inputs.flatMap((input) =>
        protocol.mapping[input.key] === undefined ? [] : [[input.key, protocol.mapping[input.key]!]],
      ),
    );
  }
  stopCapture(): void {
    if (!this.captureStop || this.captureStop.signal.aborted) return;
    this.captureStop.abort();
    this.setStatus('loading', 'device.stopping');
  }
  async startCapture(): Promise<void> {
    if (this.captureAbort) {
      this.stopCapture();
      return;
    }
    if (!this.deviceControls.ready) return;
    if (!element<HTMLFormElement>('device-form').reportValidity()) return;
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
        stopSignal: stop.signal,
        onProgress: (samples, memory) => {
          if (token !== this.version) return;
          this.acquisitionMemory = memory;
          this.updateMemoryUsage();
          if (!stop.signal.aborted && this.state !== 'decoding')
            this.setStatus('loading', 'capture.progress', {
              samples: numberLabel(samples),
              target: numberLabel(configuration.sampleCount),
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
      if (capture.store.length && !(await this.finishLiveDecodes(capture))) await this.decodeAll();
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
            : errorLabel(error),
        true,
      );
    }
  }
  setCapture(capture: Capture, cancel = true, live = false, viewport?: readonly [bigint, bigint]): void {
    if (cancel) this.cancelTask(false);
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
    this.updateCaptureLabels();
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
      const count = device ? this.deviceControls.channelCapacity(kind) : capturedCount;
      const selected = this.deviceControls.selectedChannels(kind);
      for (let id = 0; id < count; id++) {
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
        check.disabled = !!this.captureAbort;
        check.setAttribute(
          'aria-label',
          t(device ? 'channels.capture' : 'channels.display', { channel: `${prefix}${id}` }),
        );
        if (check.checked) enabled++;
        const tag = document.createElement('strong');
        tag.textContent = `${prefix}${id}`;
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
        if (chip) {
          chip.style.setProperty('--channel-color', settings.color);
        }
      },
      !this.captureAbort,
    );
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
    this.capture = null;
    this.refreshProtocolMappings();
    this.renderer.clearCapture();
    for (const protocol of this.protocols) this.clearProtocol(protocol);
    element('capture-name').textContent = t('capture.empty');
    element('sample-count').textContent = '—';
    element('rate-label').textContent = '—';
    element('duration-label').textContent = '—';
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
    const definition = decoderDefinition(protocol.decoder),
      mapped = definition.ui.inputs.filter((input) => protocol.mapping[input.key] !== undefined);
    if (!mapped.length) return false;
    if (definition.ui.inputRequirement === 'any') return true;
    return definition.ui.inputs.every((input) => input.optional || protocol.mapping[input.key] !== undefined);
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
    if (this.captureAbort) {
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
    if (!this.captureAbort || !capture || (!capture.store.length && !capture.sharedSource?.publishedSamples)) return;
    let started = false;
    for (const protocol of this.protocols) {
      if (!this.hasInput(protocol)) continue;
      if (!protocol.liveSession) {
        this.clearProtocol(protocol);
        protocol.state = 'decoding';
        try {
          const mapping = this.mappingFor(protocol);
          const session = protocol.client.startLive(
            capture,
            this.readOptions(protocol),
            mapping,
            protocol.decoder,
            capture.sharedSource,
            (progress, frames, annotations, resultBytes) => {
              protocol.progress = progress;
              protocol.frameCount = frames;
              protocol.annotationCount = annotations;
              protocol.resultBytes = resultBytes;
              if (protocol.annotations instanceof PagedAnnotationIndex) protocol.annotations.setTotal(annotations);
              this.updateMemoryUsage();
              this.updateDecodeSummary();
              if (protocol === this.selectedProtocol) {
                this.renderer.schedule();
              }
            },
          );
          protocol.liveSession = session;
          started = true;
        } catch (error) {
          protocol.state = 'error';
          protocol.error = error instanceof UIError ? error : errorLabel(error);
          this.showMessage(`${protocol.name}: ${errorLabel(error)}`, true);
          continue;
        }
      }
      const session = protocol.liveSession;
      if (!session) continue;
      started = true;
      protocol.state = 'decoding';
      void session.advance(capture).catch((error) => {
        if (protocol.liveSession !== session) return;
        protocol.liveSession = undefined;
        protocol.state = 'error';
        protocol.error = error instanceof UIError ? error : errorLabel(error);
        this.showMessage(`${protocol.name}: ${errorLabel(error)}`, true);
        this.updateDecodeSummary();
      });
    }
    if (started && this.state !== 'decoding') this.setStatus('decoding', 'status.decoding');
    else this.updateDecodeSummary();
  }
  private async finishLiveDecodes(capture: Capture): Promise<boolean> {
    const pending = this.protocols.filter((protocol) => protocol.liveSession);
    if (!pending.length) return false;
    this.setStatus('decoding', 'status.decoding');
    await Promise.all(
      pending.map(async (protocol) => {
        const session = protocol.liveSession!;
        try {
          const result = await session.finish(capture);
          if (protocol.liveSession !== session) return;
          if (capture.diagnostics && result.stats.stages) capture.diagnostics.decodeWorker = { ...result.stats.stages };
          protocol.liveSession = undefined;
          protocol.result = result;
          protocol.frameCount = result.stats.frames;
          protocol.annotationCount = result.stats.annotations;
          protocol.resultBytes =
            Math.max(protocol.resultBytes, protocol.annotations.reservedBytes) + binaryBytes(result);
          if (protocol.annotations instanceof PagedAnnotationIndex)
            protocol.annotations.setTotal(protocol.annotationCount);
          protocol.state = 'done';
          protocol.progress = 1;
          if (result.stats.truncated || result.stats.binaryTruncated) this.showMessage({ key: 'message.truncated' });
        } catch (error) {
          if (protocol.liveSession !== session) return;
          protocol.liveSession = undefined;
          protocol.state = 'error';
          protocol.error = error instanceof UIError ? error : errorLabel(error);
          this.showMessage(`${protocol.name}: ${errorLabel(error)}`, true);
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
  private cancelDecodeOnly(): void {
    ++this.decodeVersion;
    for (const protocol of this.protocols) {
      protocol.client.cancel();
      protocol.liveSession = undefined;
      if (protocol.state === 'decoding') protocol.state = 'cancelled';
    }
  }
  private cancelDecodes(target?: ProtocolInstance): void {
    if (this.decodeTimer) {
      clearTimeout(this.decodeTimer);
      this.decodeTimer = null;
    }
    ++this.version;
    for (const protocol of this.protocols) {
      if (protocol !== target && protocol.state !== 'decoding' && !protocol.liveSession) continue;
      protocol.client.cancel();
      protocol.liveSession = undefined;
      if (protocol.state === 'decoding') protocol.state = 'cancelled';
    }
  }
  private async runProtocols(
    protocols: readonly ProtocolInstance[],
    live = false,
    sampleLimit?: bigint,
  ): Promise<void> {
    if (!this.capture || (!live && this.state === 'loading')) return;
    if (live) this.cancelDecodeOnly();
    else this.cancelDecodes();
    const token = live ? ++this.decodeVersion : this.version,
      capture = this.capture;
    this.showMessage('');
    const pending = [
      ...protocols,
      ...this.protocols.filter((p) => !protocols.includes(p) && (p.state === 'ready' || p.state === 'cancelled')),
    ].filter((p) => this.hasInput(p));
    if (!pending.length) {
      this.setStatus('ready', 'status.ready');
      this.updateDecodeSummary();
      this.showCaptureOutcome();
      return;
    }
    this.setStatus('decoding', 'status.decoding');
    let failed = false;
    for (const protocol of pending) {
      if (token !== (live ? this.decodeVersion : this.version)) return;
      this.clearProtocol(protocol);
      protocol.state = 'decoding';
      this.updateDecodeSummary();
      try {
        const mapping = this.mappingFor(protocol);
        const result = await protocol.client.run(
          capture,
          this.readOptions(protocol),
          mapping,
          protocol.decoder,
          live ? sampleLimit : undefined,
          (progress, frames, annotations, resultBytes) => {
            protocol.progress = progress;
            protocol.frameCount = frames;
            protocol.annotationCount = annotations;
            protocol.resultBytes = resultBytes;
            if (protocol.annotations instanceof PagedAnnotationIndex) protocol.annotations.setTotal(annotations);
            this.updateMemoryUsage();
            this.updateDecodeSummary();
            if (protocol === this.selectedProtocol) this.renderer.schedule();
          },
        );
        if (token !== (live ? this.decodeVersion : this.version)) return;
        protocol.result = result;
        protocol.frameCount = result.stats.frames;
        protocol.annotationCount = result.stats.annotations;
        protocol.resultBytes = protocol.annotations.reservedBytes + binaryBytes(result);
        protocol.state = 'done';
        protocol.progress = 1;
        if (result.stats.truncated || result.stats.binaryTruncated) this.showMessage({ key: 'message.truncated' });
      } catch (error) {
        if (token !== (live ? this.decodeVersion : this.version)) return;
        protocol.state = 'error';
        protocol.error = error instanceof UIError ? error : errorLabel(error);
        failed = true;
        this.showMessage(`${protocol.name}: ${errorLabel(error)}`, true);
      }
      this.updateDecodeSummary();
      this.renderer.schedule();
    }
    if (token !== (live ? this.decodeVersion : this.version)) return;
    if (live && this.captureAbort) return;
    const elapsed = pending.reduce((sum, p) => sum + (p.result?.stats.elapsedMs ?? 0), 0),
      samples = pending.reduce((sum, p) => sum + (p.result?.stats.samples ?? 0n), 0n);
    this.setStatus(failed ? 'error' : 'done', failed ? 'status.stopped' : 'status.done', {
      ms: elapsed.toFixed(0),
      throughput: (elapsed ? Number(samples) / elapsed / 1000 : 0).toFixed(2),
    });
    this.updateDecodeSummary();
    this.showCaptureOutcome();
  }
  cancelTask(update = true): void {
    const cancellingCapture = !!this.captureAbort;
    if (this.decodeTimer) {
      clearTimeout(this.decodeTimer);
      this.decodeTimer = null;
    }
    ++this.version;
    ++this.decodeVersion;
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
      protocols: this.protocols.map((protocol) => ({
        id: protocol.id,
        decoder: protocol.decoder,
        name: protocol.name,
        color: protocol.color,
        decimalPlaces: protocol.decimalPlaces,
        options: { ...protocol.options },
        mapping: this.mappingFor(protocol),
      })),
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
      const blob = await protocol.client.readBinary(key);
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
  private renderStatus(): void {
    const message = t(this.statusMessage.key, this.statusMessage.params);
    element('decode-state').textContent = message;
    element('status-text').textContent = message;
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
    this.deviceControls.setBusy(!!this.captureAbort);
    for (const check of element('channel-list').querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      check.disabled = !!this.captureAbort;
    element<HTMLButtonElement>('save-capture').disabled = !this.capture || !!this.saveAbort;
    element<HTMLButtonElement>('cancel').disabled =
      this.state !== 'decoding' && this.state !== 'loading' && !this.saveAbort;
  }
  private updateDecodeSummary(): void {
    const protocol = this.selectedProtocol,
      definition = protocol ? decoderDefinition(protocol.decoder) : null;
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
  private updateCaptureLabels(): void {
    const capture = this.capture;
    if (!capture) return;
    delete element('capture-name').dataset.i18n;
    element('capture-name').textContent = capture.nameKey ? t(capture.nameKey) : capture.name;
    element('sample-count').textContent = numberLabel(capture.store.length);
    element('rate-label').textContent =
      numberLabel(capture.store.samplerate / 1e6, { maximumFractionDigits: 6 }) + ' MHz';
    element('duration-label').textContent = timeLabel(Number(capture.store.length) / capture.store.samplerate);
    element('memory-status').textContent = t('status.memory', {
      memory: (captureMemory(capture).totalBytes / 1048576).toFixed(2),
      ms: capture.loadedMs.toFixed(1),
    });
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
    return (
      (this.capture ? captureMemory(this.capture).totalBytes : 0) +
      this.protocols.reduce(
        (sum, protocol) =>
          sum +
          protocol.resultBytes +
          protocol.annotations.reservedBytes +
          (protocol.result ? binaryBytes(protocol.result) : 0),
        0,
      )
    );
  }
  private updateMemoryUsage(): void {
    const shared = this.capture?.sharedSource;
    const bytes = (this.acquisitionMemory?.usedBytes ?? this.retainedDataBytes()) + (shared?.allocatedBytes ?? 0);
    const storedSamples = this.capture?.store.length ?? 0n;
    const samples =
      shared?.publishedSamples && shared.publishedSamples > storedSamples ? shared.publishedSamples : storedSamples;
    const target = this.capture?.acquisition?.targetSamples ?? samples;
    const progress = target > 0n ? Number((samples * 10000n) / target) / 100 : 0;
    element('capture-memory-usage').textContent = t('capture.memoryUsage', {
      used: (bytes / 1048576).toFixed(2),
      samples: numberLabel(samples),
      progress: progress.toFixed(1),
    });
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
        params: { actual: numberLabel(outcome.actualSamples), target: numberLabel(outcome.targetSamples), reason },
      },
      failed,
    );
    if (failed && this.state !== 'loading' && this.state !== 'decoding') this.setStatus('error', 'device.captureError');
  }
  private refreshLocale(): void {
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
  private updateViewport(): void {
    element('waveform').parentElement!.classList.toggle('cursor-mode', this.renderer.cursorMode);
    element('waveform').style.cursor = this.renderer.cursorMode ? 'crosshair' : '';
    element('cursor-toggle').classList.toggle('active', this.renderer.cursorMode);
    element('cursor-toggle').setAttribute('aria-pressed', String(this.renderer.cursorMode));
    if (!this.capture) return;
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
    element('render-status').textContent = t('wave.draw', { ms: this.renderer.metrics().p95Ms.toFixed(1) });
  }
}
export const app = new AnalyzerApp();
