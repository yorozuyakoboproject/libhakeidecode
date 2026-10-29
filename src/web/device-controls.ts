import {
  defaultDeviceConfiguration,
  numericChoices,
  type DeviceCapabilities,
  type DeviceConfiguration,
  type NumericCapability,
} from '../libhakei/device.js';
import type { DeviceControl } from './device-protocol.js';
import { errorLabel, hasMessage, numberLabel, t, translateDOM, type MessageKey } from './i18n.js';

const SELECTED_DEVICE_KEY = 'hakei.device';
const fields = [
  ['sampleRate', 'sample-rate', 'capture.rate'],
  ['sampleCount', 'sample-limit', 'capture.sampleLimit'],
] as const;

export class DeviceControls {
  onChange: (() => void) | null = null;
  onConnectionChange: (() => void) | null = null;
  private busy = false;
  private logicSelection: number[] = [];
  private analogSelection: number[] = [];
  private connecting = false;
  private configuring = false;
  private configurationSequence = 0;
  private configurationKey = '';
  private connectionSequence = 0;
  private configurationError: unknown = null;
  private connectionError: unknown = null;
  constructor(
    readonly form: HTMLFormElement,
    readonly devices: readonly DeviceControl[],
  ) {
    const select = this.control<HTMLSelectElement>('device-select');
    for (const device of devices) {
      const option = document.createElement('option');
      option.value = device.descriptor.id;
      this.caption(option, `driver.${device.descriptor.id}.name`, device.descriptor.name);
      select.append(option);
    }
    const remembered = this.rememberedDevice();
    if (remembered) select.value = remembered;
    for (const device of devices)
      device.onConnectionChange = () => {
        if (device === this.device) {
          this.refreshConnection();
          this.onConnectionChange?.();
        }
      };
    const connect = form.querySelector<HTMLButtonElement>('#connect-device');
    const disconnect = form.querySelector<HTMLButtonElement>('#disconnect-device');
    connect?.addEventListener('click', () => {
      if (this.busy || this.connecting) return;
      void this.updateConnection('connect');
    });
    disconnect?.addEventListener('click', () => {
      if (this.busy || this.connecting) return;
      void this.updateConnection('disconnect');
    });
    this.selectDevice();
    select.addEventListener('change', () => {
      ++this.connectionSequence;
      this.connecting = false;
      this.rememberDevice();
      this.selectDevice();
      void this.restoreAuthorizedDevices();
    });
    form.addEventListener('change', (event) => {
      if (event.target === select) return;
      void this.refreshCapabilities();
    });
    void this.restoreAuthorizedDevices();
  }
  private control<T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(id: string): T {
    const node = this.form.querySelector<T>(`#${id}`);
    if (!node) throw new Error(`Missing device control: ${id}`);
    return node;
  }
  get device(): DeviceControl {
    const device = this.devices.find((item) => item.descriptor.id === this.control('device-select').value);
    if (!device) throw new Error('Select an available device');
    return device;
  }
  get ready(): boolean {
    return (
      this.logicSelection.length + this.analogSelection.length > 0 &&
      !this.connecting &&
      !this.configuring &&
      !this.configurationError &&
      this.device.connected !== false
    );
  }
  channelCapacity(kind: 'logic' | 'analog'): number {
    const capability = this.device.descriptor.capabilities[`${kind}Channels`];
    return capability.kind === 'list' ? Math.max(...capability.values) : capability.max;
  }
  selectedChannels(kind: 'logic' | 'analog'): readonly number[] {
    return kind === 'logic' ? this.logicSelection : this.analogSelection;
  }
  channelAvailable(kind: 'logic' | 'analog', index: number): boolean {
    const inputs = kind === 'analog' ? this.device.descriptor.analogInputs : undefined;
    return !inputs || inputs.some((input) => input.index === index);
  }
  channelName(kind: 'logic' | 'analog', index: number): string {
    return (
      (kind === 'analog'
        ? this.device.descriptor.analogInputs?.find((input) => input.index === index)?.name
        : undefined) ?? `${kind === 'analog' ? 'A' : 'D'}${index}`
    );
  }
  selectChannel(kind: 'logic' | 'analog', channel: number, enabled: boolean): void {
    if (this.busy || !this.channelAvailable(kind, channel)) return;
    const selected = new Set(this.selectedChannels(kind));
    if (enabled) selected.add(channel);
    else selected.delete(channel);
    const indices = [...selected].sort((a, b) => a - b);
    if (kind === 'logic') this.logicSelection = indices;
    else this.analogSelection = indices;
    try {
      localStorage.setItem(
        `hakei.${this.device.descriptor.id}.channels`,
        JSON.stringify({ logic: this.logicSelection, analog: this.analogSelection }),
      );
    } catch {}
    void this.refreshCapabilities();
  }
  configuration(): DeviceConfiguration {
    const values = Object.fromEntries(
      fields.map(([key, id]) => [
        key,
        key === 'sampleCount' ? BigInt(this.control(id).value) : Number(this.control(id).value),
      ]),
    );
    const options = Object.fromEntries(
      this.device.descriptor.options.map((option) => {
        const value = this.control(`device-option-${option.id}`).value;
        return [option.id, option.kind === 'number' ? Number(value) : value];
      }),
    );
    return {
      sampleRate: Number(values.sampleRate!),
      sampleCount: values.sampleCount!,
      logicChannels: this.logicSelection.length,
      analogChannels: this.analogSelection.length,
      logicChannelIndices: [...this.logicSelection],
      analogChannelIndices: [...this.analogSelection],
      options,
    };
  }
  private caption(node: HTMLElement, key: string, fallback: string): void {
    if (hasMessage(key)) {
      node.dataset.i18n = key;
      node.textContent = t(key);
    } else node.textContent = fallback;
  }
  private rememberedDevice(): string | undefined {
    try {
      const id = localStorage.getItem(SELECTED_DEVICE_KEY);
      return this.devices.some((device) => device.descriptor.id === id) ? id! : undefined;
    } catch {
      return undefined;
    }
  }
  private rememberDevice(): void {
    try {
      localStorage.setItem(SELECTED_DEVICE_KEY, this.control<HTMLSelectElement>('device-select').value);
    } catch {}
  }
  private selectDevice(): void {
    const defaults = defaultDeviceConfiguration(this.device.descriptor);
    this.logicSelection = Array.from({ length: defaults.logicChannels }, (_, i) => i);
    this.analogSelection = Array.from({ length: defaults.analogChannels }, (_, i) => i);
    try {
      const saved = JSON.parse(localStorage.getItem(`hakei.${this.device.descriptor.id}.channels`) ?? 'null');
      for (const kind of ['logic', 'analog'] as const) {
        const indices: unknown = saved?.[kind];
        if (
          Array.isArray(indices) &&
          indices.every((id) => Number.isInteger(id) && id >= 0 && id < this.channelCapacity(kind)) &&
          new Set(indices).size === indices.length
        ) {
          if (kind === 'logic') this.logicSelection = [...indices].sort((a, b) => a - b);
          else this.analogSelection = [...indices].sort((a, b) => a - b);
        }
      }
    } catch {}
    const configuration = {
      ...defaults,
      sampleRate: Number(this.savedSampling('sampleRate') ?? defaults.sampleRate),
      sampleCount: this.savedSampling('sampleCount') ?? defaults.sampleCount,
    };
    this.renderSampling(configuration, this.device.descriptor.capabilities);
    const container = this.form.querySelector('#device-options')!;
    container.replaceChildren();
    for (const option of this.device.descriptor.options) {
      const label = document.createElement('label');
      label.className = 'field';
      const caption = document.createElement('span');
      this.caption(caption, `driver.${this.device.descriptor.id}.option.${option.id}`, option.name);
      label.append(caption);
      let input: HTMLInputElement | HTMLSelectElement;
      if (option.kind === 'choice') {
        input = document.createElement('select');
        for (const value of option.values) {
          const item = document.createElement('option');
          item.value = value;
          this.caption(item, `driver.${this.device.descriptor.id}.value.${value}`, value);
          input.append(item);
        }
      } else {
        input = document.createElement('input');
        input.type = 'number';
        input.required = true;
        input.step = String(option.step ?? 'any');
        if (option.min !== undefined) input.min = String(option.min);
        if (option.max !== undefined) input.max = String(option.max);
      }
      input.id = `device-option-${option.id}`;
      input.value = String(option.default);
      label.append(input);
      container.append(label);
    }
    const details = this.form.querySelector<HTMLElement>('#device-settings')!;
    details.hidden = !this.device.descriptor.options.length;
    this.connectionError = null;
    this.refreshConnection();
    void this.refreshCapabilities();
    translateDOM();
  }
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.refreshConnection();
  }
  private refreshConnection(): void {
    const device = this.device,
      row = this.form.querySelector<HTMLElement>('#device-connection');
    if (!row) return;
    row.hidden = device.connected === undefined && !this.configuring && !this.configurationError;
    this.control<HTMLSelectElement>('device-select').disabled = this.busy || this.connecting;
    const connect = row.querySelector<HTMLButtonElement>('#connect-device')!,
      disconnect = row.querySelector<HTMLButtonElement>('#disconnect-device')!;
    connect.hidden = disconnect.hidden = device.connected === undefined;
    connect.disabled = this.busy || this.connecting || device.connected === true;
    disconnect.disabled = this.busy || this.connecting || !device.connected;
    const status = row.querySelector<HTMLElement>('#device-connection-status')!;
    const error = this.connectionError ?? this.configurationError;
    status.textContent = error
      ? errorLabel(error)
      : t(
          this.connecting
            ? 'device.connecting'
            : this.configuring
              ? 'device.configuring'
              : device.connected
                ? 'device.connected'
                : 'device.disconnected',
        );
  }
  private async restoreAuthorizedDevices(): Promise<void> {
    if (this.device.connected !== false) return;
    await this.updateConnection('restore');
  }
  private async updateConnection(action: 'connect' | 'disconnect' | 'restore'): Promise<void> {
    const device = this.device,
      sequence = ++this.connectionSequence;
    this.connecting = true;
    this.connectionError = null;
    this.refreshConnection();
    this.onConnectionChange?.();
    try {
      await device[action]();
      if (device === this.device && sequence === this.connectionSequence) await this.refreshCapabilities();
    } catch (error) {
      if (device === this.device && sequence === this.connectionSequence) this.connectionError = error;
    } finally {
      if (device === this.device && sequence === this.connectionSequence) {
        this.connecting = false;
        this.refreshConnection();
        this.onConnectionChange?.();
      }
    }
  }
  async refreshCapabilities(): Promise<void> {
    const device = this.device,
      sequence = ++this.configurationSequence;
    this.configuring = true;
    this.configurationError = null;
    this.refreshConnection();
    this.onConnectionChange?.();
    try {
      if (!this.logicSelection.length && !this.analogSelection.length) {
        this.onChange?.();
        return;
      }
      const settings = await device.configure(this.configuration());
      if (device !== this.device || sequence !== this.configurationSequence) return;
      this.renderSampling(settings.configuration, settings.capabilities);
      for (const option of device.descriptor.options)
        this.control(`device-option-${option.id}`).value = String(settings.configuration.options[option.id]);
      this.rememberSampling();
      translateDOM();
      const key = JSON.stringify([
        device.descriptor.id,
        ...fields.map(([field]) => String(settings.configuration[field])),
        settings.configuration.logicChannelIndices,
        settings.configuration.analogChannelIndices,
        settings.configuration.options,
      ]);
      if (key !== this.configurationKey) {
        this.configurationKey = key;
        this.onChange?.();
      }
    } catch (error) {
      if (device === this.device && sequence === this.configurationSequence) this.configurationError = error;
    } finally {
      if (device === this.device && sequence === this.configurationSequence) {
        this.configuring = false;
        this.refreshConnection();
        this.onConnectionChange?.();
      }
    }
  }
  private renderSampling(configuration: DeviceConfiguration, capabilities: DeviceCapabilities): void {
    const container = this.form.querySelector('#device-sampling')!;
    container.replaceChildren();
    let previewRate: number | undefined;
    let previewCount: bigint | undefined;
    for (const [key, id, captionKey] of fields) {
      const capability = capabilities[key],
        value = configuration[key];
      const selected = value;
      if (key === 'sampleRate') previewRate = Number(selected);
      if (key === 'sampleCount') previewCount = BigInt(selected);
      const label = document.createElement('label');
      label.className = 'field';
      const caption = document.createElement('span');
      if (key === 'sampleRate' && capabilities.timebaseOnly)
        this.caption(caption, `driver.${this.device.descriptor.id}.timebase`, 'Timebase (Hz)');
      else this.caption(caption, captionKey, captionKey);
      label.append(caption);
      this.numericControl(label, id, capability, selected, captionKey);
      container.append(label);
    }
    const preview = document.createElement('p');
    preview.id = 'capture-duration-preview';
    preview.className = 'hint';
    preview.textContent = this.durationPreview(previewCount!, previewRate!);
    container.append(preview);
  }
  private samplingKey(key: 'sampleRate' | 'sampleCount'): string {
    return `hakei.${this.device.descriptor.id}.${key}`;
  }
  private savedSampling(key: 'sampleRate' | 'sampleCount'): number | bigint | undefined {
    try {
      const raw = localStorage.getItem(this.samplingKey(key));
      if (!raw) return undefined;
      if (key === 'sampleCount') return BigInt(raw);
      const value = Number(raw);
      return Number.isSafeInteger(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  private rememberSampling(): void {
    for (const [key, id] of [
      ['sampleRate', 'sample-rate'],
      ['sampleCount', 'sample-limit'],
    ] as const) {
      const input = this.form.querySelector<HTMLInputElement | HTMLSelectElement>('#' + id);
      if (!input) continue;
      try {
        localStorage.setItem(this.samplingKey(key), input.value);
      } catch {}
    }
  }
  private durationPreview(sampleCount: bigint, sampleRate: number): string {
    const seconds = Number(sampleCount) / sampleRate;
    if (!Number.isFinite(seconds)) return '';
    const value =
      seconds < 1e-6
        ? `${(seconds * 1e9).toFixed(2)} ns`
        : seconds < 1e-3
          ? `${(seconds * 1e6).toFixed(2)} us`
          : seconds < 1
            ? `${(seconds * 1e3).toFixed(2)} ms`
            : seconds < 60
              ? `${seconds.toFixed(3)} s`
              : `${(seconds / 60).toFixed(2)} min`;
    return t('capture.durationPreview', { duration: value });
  }
  private choiceLabel(value: number | bigint, id: string): string {
    if (id !== 'sample-rate' && id !== 'sample-limit') return numberLabel(value);
    const units = [
      [1e15, 'P'],
      [1e12, 'T'],
      [1e9, 'G'],
      [1e6, 'M'],
      [1e3, 'k'],
      [1, ''],
    ] as const;
    const [scale, prefix] = units.find(([scale]) => value >= scale) ?? [1, ''];
    const unit = prefix + (id === 'sample-rate' ? 'Hz' : '');
    return numberLabel(Number(value) / scale, { maximumSignificantDigits: 16 }) + (unit ? ` ${unit}` : '');
  }
  private numericControl(
    label: HTMLElement,
    id: string,
    capability: NumericCapability<number | bigint>,
    value: number | bigint,
    captionKey: MessageKey,
  ): void {
    const input = document.createElement('select');
    input.required = true;
    const choices = numericChoices(capability);
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = String(choice);
      option.textContent = this.choiceLabel(choice, id);
      option.title = numberLabel(choice) + (id === 'sample-rate' ? ' Hz' : '');
      input.append(option);
    }
    if (!choices.some((choice) => String(choice) === String(value))) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = this.choiceLabel(value, id);
      input.append(option);
    }
    input.id = id;
    input.value = String(value);
    input.dataset.i18nAttrs = `aria-label:${captionKey}`;
    label.append(input);
  }
}
