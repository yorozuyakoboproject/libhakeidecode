import { defaultDeviceConfiguration, numericChoices, supportsNumericValue,
  type DeviceConfiguration, type NumericCapability, type SampleDevice } from '../libhakei/device.js';
import { hasMessage, numberLabel, t, translateDOM, type MessageKey } from './i18n.js';

const fields = [
  ['sampleRate', 'sample-rate', 'capture.rate'],
  ['sampleCount', 'sample-limit', 'capture.sampleLimit'],
  ['logicChannels', 'device-channel-count', 'device.logicChannels'],
  ['analogChannels', 'device-analog-count', 'device.analogChannels'],
] as const;

export class DeviceControls {
  onChange: (() => void) | null = null;
  onConnectionChange: (() => void) | null = null;
  private busy = false;
  private connecting = false;
  private connectionError = '';
  constructor(readonly form: HTMLFormElement, readonly devices: readonly SampleDevice[]) {
    const select = this.control<HTMLSelectElement>('device-select');
    for (const device of devices) {
      const option = document.createElement('option'); option.value = device.descriptor.id;
      this.caption(option, `device.name.${device.descriptor.id}`, device.descriptor.name); select.append(option);
    }
    for (const device of devices) device.onConnectionChange = () => {
      if (device === this.device) { this.refreshConnection(); this.onConnectionChange?.(); }
    };
    const connect = form.querySelector<HTMLButtonElement>('#connect-device');
    const disconnect = form.querySelector<HTMLButtonElement>('#disconnect-device');
    connect?.addEventListener('click', () => {
      if (this.busy || this.connecting) return;
      this.connecting = true; this.connectionError = ''; this.refreshConnection();
      const device = this.device;
      void device.connect?.().then(() => this.selectDevice()).catch(error => {
        this.connectionError = error instanceof Error ? error.message : String(error);
      }).finally(() => { this.connecting = false; this.refreshConnection(); this.onConnectionChange?.(); });
    });
    disconnect?.addEventListener('click', () => {
      if (this.busy || this.connecting) return;
      void this.device.disconnect?.().finally(() => { this.connectionError = ''; this.refreshConnection(); this.onConnectionChange?.(); });
    });
    this.selectDevice();
    select.addEventListener('change', () => { this.selectDevice(); this.onChange?.(); });
    form.addEventListener('change', event => {
      if (event.target === select) return;
      this.rememberSampling();
      this.refreshCapabilities((event.target as HTMLElement).id); this.onChange?.();
    });
    void this.restoreAuthorizedDevices();
  }
  private control<T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(id: string): T {
    const node = this.form.querySelector<T>(`#${id}`); if (!node) throw new Error(`Missing device control: ${id}`); return node;
  }
  get device(): SampleDevice {
    const device = this.devices.find(item => item.descriptor.id === this.control('device-select').value);
    if (!device) throw new Error('Select an available device'); return device;
  }
  configuration(): DeviceConfiguration {
    const values = Object.fromEntries(fields.map(([key, id]) => [key, key === 'sampleCount' ? BigInt(this.control(id).value) : Number(this.control(id).value)]));
    const options = Object.fromEntries(this.device.descriptor.options.map(option => {
      const value = this.control(`device-option-${option.id}`).value;
      return [option.id, option.kind === 'number' ? Number(value) : value];
    }));
    return { sampleRate: Number(values.sampleRate!), sampleCount: values.sampleCount!, logicChannels: Number(values.logicChannels!), analogChannels: Number(values.analogChannels!), options };
  }
  private caption(node: HTMLElement, key: string, fallback: string): void {
    if (hasMessage(key)) { node.dataset.i18n = key; node.textContent = t(key); } else node.textContent = fallback;
  }
  private selectDevice(): void {
    const configuration = defaultDeviceConfiguration(this.device.descriptor);
    this.renderSampling(configuration);
    const container = this.form.querySelector('#device-options')!; container.replaceChildren();
    for (const option of this.device.descriptor.options) {
      const label = document.createElement('label'); label.className = 'field'; const caption = document.createElement('span');
      this.caption(caption, `device.option.${option.id}`, option.name); label.append(caption);
      let input: HTMLInputElement | HTMLSelectElement;
      if (option.kind === 'choice') {
        input = document.createElement('select');
        for (const value of option.values) {
          const item = document.createElement('option'); item.value = value; this.caption(item, `capture.pattern.${value}`, value); input.append(item);
        }
      } else {
        input = document.createElement('input'); input.type = 'number'; input.required = true;
        input.step = String(option.step ?? 'any');
        if (option.min !== undefined) input.min = String(option.min);
        if (option.max !== undefined) input.max = String(option.max);
      }
      input.id = `device-option-${option.id}`; input.value = String(option.default); label.append(input); container.append(label);
    }
    const details = this.form.querySelector<HTMLElement>('#device-settings')!; details.hidden = !this.device.descriptor.options.length;
    this.connectionError = ''; this.refreshConnection();
    this.refreshCapabilities(); translateDOM();
  }
  setBusy(busy: boolean): void { this.busy = busy; this.refreshConnection(); }
  private refreshConnection(): void {
    const device = this.device, row = this.form.querySelector<HTMLElement>('#device-connection');
    if (!row) return;
    row.hidden = !device.connect;
    this.control<HTMLSelectElement>('device-select').disabled = this.busy || this.connecting;
    const connect = row.querySelector<HTMLButtonElement>('#connect-device')!, disconnect = row.querySelector<HTMLButtonElement>('#disconnect-device')!;
    connect.disabled = this.busy || this.connecting || device.connected === true;
    disconnect.disabled = this.busy || this.connecting || !device.connected;
    const status = row.querySelector<HTMLElement>('#device-connection-status')!;
    status.textContent = this.connectionError || t(this.connecting ? 'device.connecting' : device.connected ? 'device.connected' : 'device.disconnected');
  }
  private async restoreAuthorizedDevices(): Promise<void> {
    const candidates = this.devices.filter(device => !!device.restore);
    if (!candidates.length) return;
    this.connecting = true; this.refreshConnection();
    try {
      for (const device of candidates) {
        try {
          const restored = await device.restore!();
          if (!restored || !device.connected) continue;
          const select = this.control<HTMLSelectElement>('device-select');
          select.value = device.descriptor.id;
          this.selectDevice();
          this.connectionError = '';
          this.onConnectionChange?.();
          break;
        } catch (error) {
          if (device === this.device) this.connectionError = error instanceof Error ? error.message : String(error);
        }
      }
    } finally {
      this.connecting = false; this.refreshConnection(); this.onConnectionChange?.();
    }
  }
  refreshCapabilities(changedId?: string): void {
    this.renderSampling(this.configuration(), changedId); translateDOM();
  }
  private renderSampling(configuration: DeviceConfiguration, changedId?: string): void {
    const capabilities = this.device.getCapabilities(configuration), container = this.form.querySelector('#device-sampling')!;
    container.replaceChildren();
    let previewRate: number | undefined;
    let previewCount: bigint | undefined;
    for (const [key, id, captionKey] of fields) {
      const capability = capabilities[key], value = configuration[key];
      const saved = key === 'sampleRate' || key === 'sampleCount' ? this.savedSampling(key) : undefined;
      const selected = changedId === id ? value : saved !== undefined && supportsNumericValue(capability, saved) ? saved : supportsNumericValue(capability, value) ? value : capability.default;
      if (key === 'sampleRate') previewRate = Number(selected);
      if (key === 'sampleCount') previewCount = BigInt(selected);
      const label = document.createElement('label'); label.className = 'field'; const caption = document.createElement('span');
      this.caption(caption, captionKey, captionKey); label.append(caption);
      this.numericControl(label, id, capability, selected, captionKey); container.append(label);
    }
    const preview = document.createElement('p'); preview.id = 'capture-duration-preview'; preview.className = 'hint';
    preview.textContent = this.durationPreview(previewCount!, previewRate!); container.append(preview);
  }
  private samplingKey(key: 'sampleRate' | 'sampleCount'): string { return `hakei.${this.device.descriptor.id}.${key}`; }
  private savedSampling(key: 'sampleRate' | 'sampleCount'): number | bigint | undefined {
    try {
      const raw = localStorage.getItem(this.samplingKey(key)); if (!raw) return undefined;
      return key === 'sampleCount' ? BigInt(raw) : Number(raw);
    } catch { return undefined; }
  }
  private rememberSampling(): void {
    for (const [key, id] of [['sampleRate', 'sample-rate'], ['sampleCount', 'sample-limit']] as const) {
      const input = this.form.querySelector<HTMLInputElement | HTMLSelectElement>('#' + id); if (!input) continue;
      try { localStorage.setItem(this.samplingKey(key), input.value); } catch {}
    }
  }
  private durationPreview(sampleCount: bigint, sampleRate: number): string {
    const seconds = Number(sampleCount) / sampleRate;
    if (!Number.isFinite(seconds)) return '';
    const value = seconds < 1e-6 ? `${(seconds * 1e9).toFixed(2)} ns` : seconds < 1e-3 ? `${(seconds * 1e6).toFixed(2)} us` : seconds < 1 ? `${(seconds * 1e3).toFixed(2)} ms` : seconds < 60 ? `${seconds.toFixed(3)} s` : `${(seconds / 60).toFixed(2)} min`;
    return t('capture.durationPreview', { duration: value });
  }
  private choiceLabel(value: number | bigint, id: string): string {
    if (id !== 'sample-rate' && id !== 'sample-limit') return numberLabel(value);
    const units = [[1e15, 'P'], [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, '']] as const;
    const [scale, prefix] = units.find(([scale]) => value >= scale) ?? [1, ''];
    const unit = prefix + (id === 'sample-rate' ? 'Hz' : '');
    return numberLabel(Number(value) / scale, { maximumSignificantDigits: 16 }) + (unit ? ` ${unit}` : '');
  }
  private numericControl(label: HTMLElement, id: string, capability: NumericCapability<number | bigint>, value: number | bigint, captionKey: MessageKey): void {
    let input: HTMLInputElement | HTMLSelectElement;
    const choices = numericChoices(capability);
    if (capability.kind === 'list' || id === 'sample-rate' || id === 'sample-limit') {
      input = document.createElement('select'); input.required = true;
      for (const choice of choices) {
        const option = document.createElement('option'); option.value = String(choice);
        option.textContent = this.choiceLabel(choice, id); option.title = numberLabel(choice) + (id === 'sample-rate' ? ' Hz' : ''); input.append(option);
      }
      if (!choices.some(choice => String(choice) === String(value))) value = capability.default;
    } else {
      input = document.createElement('input'); input.type = 'number'; input.required = true;
      input.min = String(capability.min); input.max = String(capability.max); input.step = String(capability.step);
      const list = document.createElement('datalist'); list.id = `${id}-choices`; input.setAttribute('list', list.id);
      for (const choice of choices) { const option = document.createElement('option'); option.value = String(choice); option.label = numberLabel(choice); list.append(option); }
      label.append(list);
    }
    input.id = id; input.value = String(value); input.dataset.i18nAttrs = `aria-label:${captionKey}`; label.append(input);
  }
}
