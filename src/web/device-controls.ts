import {
  defaultDeviceConfiguration,
  numericChoices,
  type DeviceCapabilities,
  type DeviceConfiguration,
  type NumericCapability,
} from '../libhakei/device.js';
import type { DeviceControl } from './device-protocol.js';
import { formatDuration, formatRate, formatSampleCount } from '../libhakei/units.js';
import { numberFraction } from '../libhakei/sample-index.js';
import { errorLabel, hasMessage, numberLabel, t, translateDOM } from './i18n.js';

const SELECTED_DEVICE_KEY = 'hakei.device';
const DEFAULT_DEVICE_ID = 'demo';
export class DeviceControls {
  onChange: (() => void) | null = null;
  onConnectionChange: (() => void) | null = null;
  private busy = false;
  private timebaseOnly = false;
  private digitalRate = 0;
  private durationSeconds?: number;
  private legacySampleCount: number | bigint = 1n;
  private samplingCapabilities?: DeviceCapabilities;
  private logicSelection: number[] = [];
  private analogSelection: number[] = [];
  private connecting = false;
  private configuring = false;
  private configurationSequence = 0;
  private configurationKey = '';
  private optionsKey = '';
  private connectionSequence = 0;
  private configurationError: unknown = null;
  private connectionError: unknown = null;
  private pendingTransport?: string;
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
    const defaultDevice = this.devices.find((device) => device.descriptor.id === DEFAULT_DEVICE_ID);
    if (remembered) select.value = remembered;
    else if (defaultDevice) select.value = defaultDevice.descriptor.id;
    for (const device of devices)
      device.onConnectionChange = () => {
        if (device === this.device) {
          if (!this.busy) this.renderOptions();
          this.reconcileChannelSelection();
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
      if (event.target === select || (event.target as HTMLElement).id === 'device-transport' || this.busy) return;
      if ((event.target as HTMLElement).id.startsWith('device-option-')) this.rememberOptions();
      if ((event.target as HTMLElement).id === 'capture-duration')
        this.durationSeconds = Number(this.control('capture-duration').value);
      void this.refreshCapabilities();
    });
    window.addEventListener('hakei:localechange', () => {
      if (this.samplingCapabilities) this.renderSampling(this.configuration(), this.samplingCapabilities);
      this.refreshConnection();
    });
    void this.restoreAuthorizedDevices();
    setInterval(() => {
      if (!this.busy && !this.connecting && !this.configuring && this.device.descriptor.transport)
        void this.updateTransport();
    }, 3000);
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
    const inputs = kind === 'analog' ? this.device.descriptor.analogInputs : this.device.descriptor.logicInputs;
    if (inputs) return inputs.reduce((maximum, input) => Math.max(maximum, input.index + 1), 0);
    const capability = this.device.descriptor.capabilities[`${kind}Channels`];
    return capability.kind === 'list' ? Math.max(...capability.values) : capability.max;
  }
  channelIndices(kind: 'logic' | 'analog'): readonly number[] {
    const inputs = kind === 'analog' ? this.device.descriptor.analogInputs : this.device.descriptor.logicInputs;
    return (
      inputs?.map((input) => input.index) ?? Array.from({ length: this.channelCapacity(kind) }, (_, index) => index)
    );
  }
  selectedChannels(kind: 'logic' | 'analog'): readonly number[] {
    return kind === 'logic' ? this.logicSelection : this.analogSelection;
  }
  channelAvailable(kind: 'logic' | 'analog', index: number): boolean {
    const inputs = kind === 'analog' ? this.device.descriptor.analogInputs : this.device.descriptor.logicInputs;
    return !inputs || inputs.some((input) => input.index === index);
  }
  channelName(kind: 'logic' | 'analog', index: number): string {
    return (
      (kind === 'analog'
        ? this.device.descriptor.analogInputs?.find((input) => input.index === index)?.name
        : this.device.descriptor.logicInputs?.find((input) => input.index === index)?.name) ??
      `${kind === 'analog' ? 'A' : 'D'}${index}`
    );
  }
  selectChannel(kind: 'logic' | 'analog', channel: number, enabled: boolean): void {
    if (this.busy || !this.channelAvailable(kind, channel)) return;
    const selected = new Set(this.selectedChannels(kind));
    if (enabled) selected.add(channel);
    else selected.delete(channel);
    if (kind === 'logic') {
      const available = this.channelIndices('logic');
      const index = available.indexOf(channel);
      if (enabled && index >= 0) this.logicSelection = [...available.slice(0, index + 1)];
      else this.logicSelection = this.logicPrefix(available.filter((item) => selected.has(item)));
    } else this.analogSelection = [...selected].sort((a, b) => a - b);
    try {
      localStorage.setItem(
        `hakei.${this.device.descriptor.id}.channels`,
        JSON.stringify({ logic: this.logicSelection, analog: this.analogSelection }),
      );
    } catch {}
    void this.refreshCapabilities();
  }
  configuration(): DeviceConfiguration {
    const sampleRate =
      this.logicSelection.length && this.timebaseOnly ? this.digitalRate : Number(this.control('sample-rate').value);
    const analogSampleRate = this.samplingCapabilities?.analogSampleRate
      ? Number(this.control('analog-sample-rate').value)
      : undefined;
    const options = Object.fromEntries(
      this.device.descriptor.options.map((option) => {
        const value = this.control(`device-option-${option.id}`).value;
        return [option.id, option.kind === 'number' ? Number(value) : value];
      }),
    );
    return {
      sampleRate,
      ...(analogSampleRate === undefined ? {} : { analogSampleRate }),
      sampleCount:
        this.durationSeconds === undefined
          ? this.legacySampleCount
          : this.durationSamples(this.durationSeconds, sampleRate, this.samplingCapabilities!.sampleCount),
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
  private restoreChannelSelection(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(`hakei.${this.device.descriptor.id}.channels`) ?? 'null');
      for (const kind of ['logic', 'analog'] as const) {
        const indices: unknown = saved?.[kind];
        if (
          Array.isArray(indices) &&
          indices.every((id) => Number.isInteger(id) && id >= 0) &&
          new Set(indices).size === indices.length
        ) {
          const filtered = indices.filter((id) => this.channelAvailable(kind, id)).sort((a, b) => a - b);
          const next = filtered.length || !indices.length ? filtered : [...this.channelIndices(kind)];
          if (kind === 'logic') {
            const prefix = this.logicPrefix(next);
            this.logicSelection = prefix.length || !next.length ? prefix : [...this.channelIndices(kind)];
          } else this.analogSelection = next;
        } else if (indices === undefined && kind === 'logic') {
          this.logicSelection = [...this.channelIndices(kind)];
        }
      }
    } catch {}
  }
  private reconcileChannelSelection(): void {
    const logic = this.logicPrefix(this.logicSelection.filter((id) => this.channelAvailable('logic', id)));
    const analog = this.analogSelection.filter((id) => this.channelAvailable('analog', id));
    if (logic.length === this.logicSelection.length && analog.length === this.analogSelection.length) return;
    this.logicSelection = logic;
    this.analogSelection = analog;
    this.onChange?.();
  }
  private logicPrefix(selection: readonly number[]): number[] {
    const selected = new Set(selection),
      prefix: number[] = [];
    for (const channel of this.channelIndices('logic')) {
      if (!selected.has(channel)) break;
      prefix.push(channel);
    }
    return prefix;
  }
  private selectDevice(): void {
    const defaults = defaultDeviceConfiguration(this.device.descriptor);
    this.logicSelection =
      this.device.descriptor.logicInputs?.map((input) => input.index) ??
      Array.from({ length: defaults.logicChannels }, (_, i) => i);
    this.analogSelection = Array.from({ length: defaults.analogChannels }, (_, i) => i);
    this.restoreChannelSelection();
    const configuration = {
      ...defaults,
      sampleRate: Number(this.savedSampling('sampleRate') ?? defaults.sampleRate),
      ...(defaults.analogSampleRate === undefined
        ? {}
        : {
            analogSampleRate: Number(this.savedSampling('analogSampleRate') ?? defaults.analogSampleRate),
          }),
      sampleCount: this.savedSampling('sampleCount') ?? defaults.sampleCount,
    };
    this.legacySampleCount = configuration.sampleCount;
    try {
      const saved = Number(localStorage.getItem(`hakei.${this.device.descriptor.id}.durationSeconds`));
      this.durationSeconds = Number.isFinite(saved) && saved > 0 ? saved : undefined;
    } catch {
      this.durationSeconds = undefined;
    }
    this.renderSampling(configuration, this.device.descriptor.capabilities);
    this.renderOptions(true);
    this.connectionError = null;
    this.refreshConnection();
    void this.refreshCapabilities();
    translateDOM();
  }
  private renderOptions(reset = false): void {
    const key = JSON.stringify([this.device.descriptor.id, this.device.descriptor.options]);
    if (!reset && key === this.optionsKey) return;
    const remembered = this.savedOptions();
    const previous = new Map<string, string>();
    if (!reset)
      for (const input of this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        '#device-options input, #device-options select',
      ))
        previous.set(input.id, input.value);
    this.optionsKey = key;
    const container = this.form.querySelector<HTMLElement>('#device-options')!;
    container.replaceChildren();
    for (const option of this.device.descriptor.options) {
      if (option.hidden) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.id = `device-option-${option.id}`;
        input.value = String(previous.get(input.id) ?? remembered[option.id] ?? option.default);
        container.append(input);
        continue;
      }
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
          this.caption(item, `driver.${this.device.descriptor.id}.value.${value}`, option.labels?.[value] ?? value);
          input.append(item);
        }
      } else if (option.kind === 'number') {
        input = document.createElement('input');
        input.type = 'number';
        input.required = true;
        input.step = String(option.step ?? 'any');
        if (option.min !== undefined) input.min = String(option.min);
        if (option.max !== undefined) input.max = String(option.max);
      } else {
        input = document.createElement('input');
        input.type = 'text';
      }
      input.id = `device-option-${option.id}`;
      const saved = previous.get(input.id) ?? remembered[option.id];
      const valid =
        saved !== undefined &&
        (option.kind === 'choice'
          ? option.values.includes(saved)
          : option.kind === 'text'
            ? true
            : Number.isFinite(Number(saved)) &&
              (option.min === undefined || Number(saved) >= option.min) &&
              (option.max === undefined || Number(saved) <= option.max));
      input.value = valid ? saved! : String(option.default);
      label.append(input);
      if (option.description) {
        const hint = document.createElement('small');
        hint.className = 'hint';
        this.caption(hint, `driver.${this.device.descriptor.id}.hint.${option.id}`, option.description);
        label.append(hint);
      }
      container.append(label);
    }
    container.hidden = !this.device.descriptor.options.some((option) => !option.hidden);
  }
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.refreshConnection();
  }
  private refreshConnection(): void {
    const device = this.device,
      row = this.form.querySelector<HTMLElement>('#device-connection');
    if (!row) return;
    let transport = row.querySelector<HTMLSelectElement>('#device-transport');
    let transportStatus = row.querySelector<HTMLElement>('#device-transport-status');
    if (!transport && device.descriptor.transport) {
      const label = document.createElement('label');
      label.className = 'field';
      label.id = 'device-transport-field';
      const name = document.createElement('span');
      this.caption(name, `driver.${device.descriptor.id}.transport.label`, 'USB transport');
      transport = document.createElement('select');
      transport.id = 'device-transport';
      for (const mode of device.descriptor.transport.choices) {
        const option = document.createElement('option');
        option.value = mode;
        this.caption(option, `driver.${device.descriptor.id}.transport.${mode}`, mode);
        transport.append(option);
      }
      transport.addEventListener('change', () => {
        void this.updateTransport(transport!.value);
      });
      transportStatus = document.createElement('strong');
      transportStatus.id = 'device-transport-status';
      transportStatus.role = 'status';
      label.append(name, transport, transportStatus);
      row.prepend(label);
    }
    const transportField = row.querySelector<HTMLElement>('#device-transport-field');
    if (transportField) transportField.hidden = !device.descriptor.transport;
    if (transport && device.descriptor.transport) {
      transport.value = device.descriptor.transport.selected;
      transport.disabled = this.busy || this.connecting || this.configuring;
      this.caption(
        transportStatus!,
        `driver.${device.descriptor.id}.transport.active.${device.descriptor.transport.active ?? 'none'}`,
        'Disconnected',
      );
      transportStatus!.dataset.transport = device.descriptor.transport.active ?? 'none';
    }
    const disconnected = device.connected === false;
    this.form.querySelector<HTMLElement>('#device-sampling')!.hidden = disconnected;
    this.form.querySelector<HTMLElement>('#device-options')!.hidden =
      disconnected || !device.descriptor.options.some((option) => !option.hidden);
    row.hidden = device.connected === undefined && !this.configuring && !this.configurationError;
    this.control<HTMLSelectElement>('device-select').disabled = this.busy || this.connecting;
    const connect = row.querySelector<HTMLButtonElement>('#connect-device')!,
      disconnect = row.querySelector<HTMLButtonElement>('#disconnect-device')!;
    connect.hidden = disconnect.hidden = device.connected === undefined;
    connect.disabled = this.busy || this.connecting || device.connected === true;
    disconnect.disabled = this.busy || this.connecting || !device.connected;
    for (const input of this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      '#device-options input, #device-options select, #device-sampling input, #device-sampling select',
    ))
      input.disabled = this.busy || this.connecting || this.configuring;
    const status = row.querySelector<HTMLElement>('#device-connection-status')!;
    const error = this.connectionError ?? this.configurationError;
    status.textContent = error
      ? errorLabel(error, 'error.capture')
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
  private async updateTransport(mode?: string): Promise<void> {
    if (this.busy || this.configuring) return;
    if (this.connecting) {
      if (mode !== undefined) this.pendingTransport = mode;
      return;
    }
    const device = this.device;
    const settingsKey = () =>
      JSON.stringify(
        [
          device.descriptor.capabilities,
          device.descriptor.logicInputs,
          device.descriptor.analogInputs,
          device.descriptor.options,
        ],
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
    const previousSettings = settingsKey();
    const connected = device.connected;
    this.connecting = true;
    this.refreshConnection();
    this.onConnectionChange?.();
    try {
      await device.setTransport(mode);
      this.connectionError = null;
      if (connected && device.connected && previousSettings === settingsKey()) return;
      if (device === this.device) {
        this.restoreChannelSelection();
        this.reconcileChannelSelection();
        await this.refreshCapabilities();
      }
    } catch (error) {
      if (device === this.device) this.connectionError = error;
    } finally {
      this.connecting = false;
      this.refreshConnection();
      this.onConnectionChange?.();
      const pending = this.pendingTransport;
      this.pendingTransport = undefined;
      if (pending !== undefined) void this.updateTransport(pending);
    }
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
      if (device === this.device && sequence === this.connectionSequence) {
        if (action !== 'disconnect') this.restoreChannelSelection();
        this.reconcileChannelSelection();
        await this.refreshCapabilities();
      }
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
    this.renderOptions();
    this.refreshConnection();
    this.onConnectionChange?.();
    try {
      if (device.connected === false) return;
      if (!this.logicSelection.length && !this.analogSelection.length) {
        this.onChange?.();
        return;
      }
      let settings = await device.configure(this.configuration());
      if (device !== this.device || sequence !== this.configurationSequence) return;
      const rate = settings.configuration.sampleRate;
      const capability = settings.capabilities.sampleCount;
      const counts = capability.kind === 'list' ? capability.values : [capability.min, capability.max];
      const minimum = Math.min(...counts.map(Number)) / rate;
      const maximum = Math.max(...counts.map(Number)) / rate;
      this.durationSeconds = Math.min(
        maximum,
        Math.max(minimum, this.durationSeconds ?? Number(settings.configuration.sampleCount) / rate),
      );
      const count = this.durationSamples(this.durationSeconds, rate, capability);
      if (count !== BigInt(settings.configuration.sampleCount))
        settings = await device.configure({ ...settings.configuration, sampleCount: count });
      if (device !== this.device || sequence !== this.configurationSequence) return;
      this.renderSampling(settings.configuration, settings.capabilities);
      for (const option of device.descriptor.options)
        if (!option.hidden)
          this.control(`device-option-${option.id}`).value = String(settings.configuration.options[option.id]);
      this.rememberOptions();
      this.rememberSampling();
      translateDOM();
      const key = JSON.stringify([
        device.descriptor.id,
        String(settings.configuration.sampleRate),
        String(settings.configuration.analogSampleRate ?? ''),
        String(settings.configuration.sampleCount),
        settings.configuration.logicChannelIndices,
        settings.configuration.analogChannelIndices,
        settings.configuration.options,
      ]);
      if (key !== this.configurationKey) {
        this.configurationKey = key;
        this.onChange?.();
      }
    } catch (error) {
      if (device === this.device && sequence === this.configurationSequence)
        this.configurationError = device.connected === false ? null : error;
    } finally {
      if (device === this.device && sequence === this.configurationSequence) {
        this.configuring = false;
        this.refreshConnection();
        this.onConnectionChange?.();
      }
    }
  }
  private renderSampling(configuration: DeviceConfiguration, capabilities: DeviceCapabilities): void {
    this.samplingCapabilities = capabilities;
    this.timebaseOnly = !!capabilities.timebaseOnly;
    if (!this.timebaseOnly) this.digitalRate = configuration.sampleRate;
    const container = this.form.querySelector('#device-sampling')!;
    container.replaceChildren();
    const label = document.createElement('label');
    label.className = 'field';
    label.hidden = this.timebaseOnly;
    const caption = document.createElement('span');
    this.caption(caption, 'capture.digitalSampleRate', t('capture.digitalSampleRate'));
    label.append(caption);
    this.numericControl(label, capabilities.sampleRate, configuration.sampleRate, 'sample-rate');
    container.append(label);

    if (capabilities.analogSampleRate) {
      const analogLabel = document.createElement('label');
      analogLabel.className = 'field';
      const analogCaption = document.createElement('span');
      this.caption(analogCaption, 'capture.analogSampleRate', t('capture.analogSampleRate'));
      analogLabel.append(analogCaption);
      this.numericControl(
        analogLabel,
        capabilities.analogSampleRate,
        configuration.analogSampleRate ?? capabilities.analogSampleRate.default,
        'analog-sample-rate',
      );
      container.append(analogLabel);
    }

    const seconds = Number(configuration.sampleCount) / configuration.sampleRate;
    const duration = document.createElement('label');
    duration.className = 'field';
    const title = document.createElement('span');
    this.caption(title, 'capture.captureDuration', 'Capture duration');
    duration.append(title);
    const input = document.createElement('select');
    input.id = 'capture-duration';
    input.required = true;
    input.dataset.i18nAttrs = 'aria-label:capture.captureDuration';
    const cap = capabilities.sampleCount;
    const counts = cap.kind === 'list' ? cap.values : [cap.min, cap.max];
    const minimum = Math.min(...counts.map(Number)) / configuration.sampleRate;
    const maximum = Math.max(...counts.map(Number)) / configuration.sampleRate;
    const selected = this.durationSeconds ?? seconds;
    const choices = new Set([minimum, maximum, selected]);
    for (let exponent = -9; exponent <= Math.ceil(Math.log10(maximum)); exponent++)
      for (const multiplier of [1, 2, 5]) {
        const value = Number((multiplier * 10 ** exponent).toPrecision(12));
        if (value >= minimum && value <= maximum) choices.add(value);
      }
    for (const value of [...choices].sort((a, b) => a - b)) {
      const item = document.createElement('option');
      item.value = String(value);
      item.textContent = formatDuration(value);
      input.append(item);
    }
    input.value = String(selected);
    duration.append(input);
    container.append(duration);
    const preview = document.createElement('p');
    preview.id = 'capture-duration-preview';
    preview.className = 'hint';
    preview.textContent = t('capture.durationPreview', { duration: formatDuration(seconds) });
    container.append(preview);
    const streams = [
      ...(configuration.logicChannels
        ? [
            {
              name: t('capture.digital'),
              sampleRate: configuration.sampleRate,
              count: BigInt(configuration.sampleCount),
              bits: undefined,
            },
          ]
        : []),
      ...(
        capabilities.analogTiming ??
        this.analogSelection.map((channel) => ({
          channel,
          sampleRate: capabilities.analogSampleRate
            ? (configuration.analogSampleRate ?? Number(capabilities.analogSampleRate.default))
            : configuration.sampleRate,
          outputBits: undefined,
        }))
      ).map((timing) => ({
        name: this.channelName('analog', timing.channel),
        sampleRate: timing.sampleRate,
        count: BigInt(Math.floor(seconds * timing.sampleRate)),
        bits: timing.outputBits,
      })),
    ];
    for (const stream of streams) {
      const details = document.createElement('p');
      details.className = 'hint';
      details.dataset.streamPreview = stream.name;
      details.textContent = `${stream.name} · ${formatRate(stream.sampleRate)}${stream.bits ? ` · ${stream.bits} bit` : ''} · ${t('capture.expectedSamples', { count: formatSampleCount(stream.count) })}`;
      details.title = numberLabel(stream.count);
      container.append(details);
    }
  }
  private durationSamples(seconds: number, rate: number, capability: DeviceCapabilities['sampleCount']): bigint {
    const [numerator, denominator] = numberFraction(seconds);
    let count = (numerator * BigInt(rate) + denominator / 2n) / denominator;
    if (capability.kind === 'list')
      return capability.values
        .map(BigInt)
        .reduce((best, value) =>
          (value > count ? value - count : count - value) < (best > count ? best - count : count - best) ? value : best,
        );
    const minimum = BigInt(capability.min),
      maximum = BigInt(capability.max),
      step = BigInt(capability.step);
    count = count < minimum ? minimum : count > maximum ? maximum : count;
    return minimum + ((count - minimum) / step) * step;
  }
  private samplingKey(key: 'sampleRate' | 'analogSampleRate' | 'sampleCount'): string {
    return `hakei.${this.device.descriptor.id}.${key}`;
  }
  private savedOptions(): Record<string, string> {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(`hakei.${this.device.descriptor.id}.options`) ?? 'null');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    } catch {
      return {};
    }
  }
  private rememberOptions(): void {
    try {
      localStorage.setItem(
        `hakei.${this.device.descriptor.id}.options`,
        JSON.stringify(
          Object.fromEntries(
            this.device.descriptor.options.map((option) => [
              option.id,
              this.control(`device-option-${option.id}`).value,
            ]),
          ),
        ),
      );
    } catch {}
  }
  private savedSampling(key: 'sampleRate' | 'analogSampleRate' | 'sampleCount'): number | bigint | undefined {
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
    try {
      if (!this.timebaseOnly) localStorage.setItem(this.samplingKey('sampleRate'), this.control('sample-rate').value);
      if (this.samplingCapabilities?.analogSampleRate)
        localStorage.setItem(this.samplingKey('analogSampleRate'), this.control('analog-sample-rate').value);
      localStorage.setItem(`hakei.${this.device.descriptor.id}.durationSeconds`, String(this.durationSeconds));
      localStorage.removeItem(this.samplingKey('sampleCount'));
    } catch {}
  }
  private numericControl(
    label: HTMLElement,
    capability: NumericCapability<number | bigint>,
    value: number | bigint,
    id: 'sample-rate' | 'analog-sample-rate',
  ): void {
    const input = document.createElement('select');
    input.required = true;
    const choices = numericChoices(capability);
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = String(choice);
      option.textContent = formatRate(Number(choice));
      input.append(option);
    }
    if (!choices.some((choice) => String(choice) === String(value))) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = formatRate(Number(value));
      input.append(option);
    }
    input.id = id;
    input.value = String(value);
    input.dataset.i18nAttrs = 'aria-label:capture.rate';
    label.append(input);
  }
}
