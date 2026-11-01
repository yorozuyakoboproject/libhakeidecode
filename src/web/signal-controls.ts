import { encoderIds, loadSignalEncoderPresets } from '../generated/encoders.js';
import type { SignalEncoderPreset } from '../decoders/signal.js';
import { decoderDefinition } from '../decoders/index.js';
import type { DecoderId } from './protocol.js';
import type { DeviceControls } from './device-controls.js';
import type { OptionDeclaration, OptionValue } from '../libhakeidecode/types.js';
import {
  DEMO_ANALOG_PATTERNS,
  DEFAULT_DEMO_SIGNALS,
  parseDemoSignals,
  type DemoAnalogSignal,
  type DemoEncoderSignal,
  type DemoSignal,
} from '../drivers/demo/signal.js';
import { hasMessage, t } from './i18n.js';

const STORAGE_KEY = 'hakei.demo.signals';

function declarations(decoder: DecoderId): readonly OptionDeclaration[] {
  const options = decoderDefinition(decoder).descriptor.options;
  if (!options) return [];
  return Array.isArray(options)
    ? (options as readonly OptionDeclaration[])
    : Object.entries(options).map(([id, value]) => ({ id, default: value }));
}

function decoderName(decoder: string): string {
  const key = `decoder.${decoder}.name`;
  return hasMessage(key) ? t(key) : (decoderDefinition(decoder).descriptor.name ?? decoder);
}

function channelRange(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function input(element: HTMLElement, id: string): HTMLInputElement {
  return element.querySelector<HTMLInputElement>(`#${id}`)!;
}

function select(element: HTMLElement, id: string): HTMLSelectElement {
  return element.querySelector<HTMLSelectElement>(`#${id}`)!;
}

function optionValue(declaration: OptionDeclaration, value: string): OptionValue {
  if (typeof declaration.default === 'number') return Number(value);
  if (typeof declaration.default === 'boolean') return value === 'true';
  return value;
}

export class SignalControls {
  onChange: (() => void) | null = null;
  private signals: DemoSignal[] = [];
  private selectedId: string | null = null;
  private busy = false;
  private readonly presets = new Map<string, readonly SignalEncoderPreset[]>();
  private readonly pendingPresets = new Map<string, Promise<readonly SignalEncoderPreset[]>>();
  private readonly section = document.getElementById('signal-section') as HTMLElement | null;
  constructor(private readonly devices: DeviceControls) {
    if (!this.section) throw new Error('Missing signal generator UI');
    this.populateAddTypes();
    this.signals = this.restore();
    this.selectedId = this.signals[0]?.id ?? null;
    this.bindControls();
    this.refresh();
    void this.initialize();
    window.addEventListener('hakei:localechange', () => this.render());
  }
  private restore(): DemoSignal[] {
    let raw = DEFAULT_DEMO_SIGNALS;
    try {
      raw = localStorage.getItem(STORAGE_KEY) ?? raw;
    } catch {}
    try {
      return parseDemoSignals(raw, channelRange(32), channelRange(4), encoderIds);
    } catch {
      return parseDemoSignals(DEFAULT_DEMO_SIGNALS, channelRange(32), channelRange(4), encoderIds);
    }
  }
  private async initialize(): Promise<void> {
    await Promise.all(
      this.signals.flatMap((signal) => (signal.kind === 'encoder' ? [this.ensurePresets(signal.decoder)] : [])),
    );
    for (const signal of this.signals) this.normalizeCase(signal);
    this.sync();
    this.render();
  }
  private populateAddTypes(): void {
    const select = document.getElementById('add-signal-type') as HTMLSelectElement | null;
    if (!select) return;
    select.replaceChildren();
    for (const decoder of encoderIds) {
      const option = document.createElement('option');
      option.value = decoder;
      option.textContent = decoderName(decoder);
      select.append(option);
    }
    const analog = document.createElement('option');
    analog.value = 'analog';
    analog.dataset.i18n = 'signal.analog';
    analog.textContent = t('signal.analog');
    select.append(analog);
    if (encoderIds.includes('pwm')) select.value = 'pwm';
  }
  private bindControls(): void {
    const section = this.section!;
    this.devices.form.querySelector('#device-select')?.addEventListener('change', () => this.refresh());
    section.querySelector('#add-signal')!.addEventListener('click', () => void this.addSignal());
    section.querySelector('#remove-signal')!.addEventListener('click', () => this.removeSelected());
    input(section, 'signal-name').addEventListener('change', () => {
      const signal = this.selected;
      if (!signal) return;
      signal.name = input(section, 'signal-name').value.trim().slice(0, 80) || this.defaultName(signal);
      input(section, 'signal-name').value = signal.name;
      this.commit();
    });
    select(section, 'signal-decoder').addEventListener('change', () => void this.changeDecoder());
    select(section, 'signal-case').addEventListener('change', () => this.changeCase());
    for (const id of [
      'signal-pattern',
      'signal-channel',
      'signal-frequency',
      'signal-amplitude',
      'signal-offset',
      'signal-seed',
    ])
      section.querySelector(`#${id}`)!.addEventListener('change', () => this.changeAnalog());
  }
  private get selected(): DemoSignal | undefined {
    return this.signals.find((signal) => signal.id === this.selectedId);
  }
  private defaultName(signal: DemoSignal): string {
    return signal.kind === 'encoder' ? decoderName(signal.decoder) : t('signal.analog');
  }
  setBusy(busy: boolean): void {
    this.busy = busy;
    for (const control of this.section!.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      'button, input, select',
    ))
      control.disabled = busy;
  }
  refresh(): void {
    const visible = this.devices.device.descriptor.id === 'demo';
    this.section!.hidden = !visible;
    if (visible) this.reconcile();
    this.sync();
    this.render();
  }
  validate(): string | null {
    try {
      parseDemoSignals(
        JSON.stringify(this.signals),
        this.devices.selectedChannels('logic'),
        this.devices.selectedChannels('analog'),
        encoderIds,
      );
      for (const signal of this.signals) {
        if (signal.kind !== 'encoder') continue;
        const presets = this.presets.get(signal.decoder);
        if (presets && !presets.some((preset) => preset.name === signal.caseName))
          throw new Error('Unknown encoder case');
      }
      this.setError('');
      return null;
    } catch {
      const message = t('signal.invalid');
      this.setError(message);
      return message;
    }
  }
  sync(): void {
    const raw = JSON.stringify(this.signals);
    const hidden = document.getElementById('device-option-signals');
    if (hidden instanceof HTMLInputElement) hidden.value = raw;
    try {
      localStorage.setItem(STORAGE_KEY, raw);
    } catch {}
    this.validate();
  }
  private setError(message: string): void {
    const node = document.getElementById('signal-error');
    if (node) node.textContent = message;
  }
  private commit(refresh = true): void {
    this.sync();
    this.render();
    if (refresh) void this.devices.refreshCapabilities();
    this.onChange?.();
  }
  private reconcile(): void {
    const logic = this.devices.selectedChannels('logic'),
      analog = this.devices.selectedChannels('analog'),
      usedLogic = new Set<number>(),
      usedAnalog = new Set<number>();
    for (const signal of this.signals) {
      if (signal.kind === 'encoder') {
        const keys = new Set(decoderDefinition(signal.decoder).ui.inputs.map((item) => item.key));
        signal.mapping = Object.fromEntries(
          Object.entries(signal.mapping).filter(([key, channel]) => {
            if (!keys.has(key) || !logic.includes(channel) || usedLogic.has(channel)) return false;
            usedLogic.add(channel);
            return true;
          }),
        );
        for (const key of keys) {
          if (signal.mapping[key] !== undefined) continue;
          if (decoderDefinition(signal.decoder).ui.inputs.find((input) => input.key === key)?.optional) continue;
          const channel = logic.find((value) => !usedLogic.has(value));
          if (channel === undefined) continue;
          signal.mapping[key] = channel;
          usedLogic.add(channel);
        }
      } else {
        let channel = analog.includes(signal.channel) && !usedAnalog.has(signal.channel) ? signal.channel : undefined;
        channel ??= analog.find((value) => !usedAnalog.has(value));
        if (channel !== undefined) {
          signal.channel = channel;
          usedAnalog.add(channel);
        }
      }
    }
  }
  private render(): void {
    const list = document.getElementById('signal-list')!;
    list.replaceChildren();
    for (const signal of this.signals) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'protocol-item' + (signal.id === this.selectedId ? ' selected' : '');
      button.dataset.signalId = signal.id;
      button.setAttribute('aria-pressed', String(signal.id === this.selectedId));
      const dot = document.createElement('i');
      dot.style.backgroundColor = signal.kind === 'encoder' ? 'var(--accent)' : 'var(--info, #79adff)';
      const name = document.createElement('span');
      name.textContent = signal.name;
      const kind = document.createElement('small');
      kind.textContent = signal.kind === 'encoder' ? decoderName(signal.decoder) : t('signal.analog');
      button.append(dot, name, kind);
      button.addEventListener('click', () => {
        if (this.busy) return;
        this.selectedId = signal.id;
        this.render();
      });
      list.append(button);
    }
    document.getElementById('signal-badge')!.textContent = String(this.signals.length);
    document.getElementById('signal-empty')!.hidden = this.signals.length > 0;
    const editor = document.getElementById('signal-editor') as HTMLElement;
    editor.hidden = !this.selected;
    if (this.selected) this.renderEditor(this.selected);
    this.setBusy(this.busy);
    this.setError(this.validate() ?? '');
  }
  private renderEditor(signal: DemoSignal): void {
    input(this.section!, 'signal-name').value = signal.name;
    const encoder = document.getElementById('signal-encoder-fields') as HTMLElement,
      analog = document.getElementById('signal-analog-fields') as HTMLElement;
    encoder.hidden = signal.kind !== 'encoder';
    analog.hidden = signal.kind !== 'analog';
    if (signal.kind === 'encoder') this.renderEncoder(signal);
    else this.renderAnalog(signal);
  }
  private renderEncoder(signal: DemoEncoderSignal): void {
    const decoder = select(this.section!, 'signal-decoder');
    decoder.replaceChildren();
    for (const id of encoderIds) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = decoderName(id);
      decoder.append(option);
    }
    decoder.value = signal.decoder;
    const presets = this.presets.get(signal.decoder),
      cases = select(this.section!, 'signal-case');
    cases.replaceChildren();
    if (presets) {
      for (const preset of presets) {
        const option = document.createElement('option');
        option.value = preset.name;
        option.textContent = preset.name;
        cases.append(option);
      }
      cases.value = signal.caseName;
    } else {
      const option = document.createElement('option');
      option.textContent = t('signal.loading');
      cases.append(option);
      cases.disabled = true;
    }
    const mapping = document.getElementById('signal-mapping')!;
    mapping.replaceChildren();
    const used = this.usedChannels(signal.id, 'logic');
    for (const item of decoderDefinition(signal.decoder).ui.inputs) {
      const label = document.createElement('label');
      label.className = 'field';
      const caption = document.createElement('span');
      if (item.labelKey && hasMessage(item.labelKey)) caption.dataset.i18n = item.labelKey;
      caption.textContent = item.label;
      const select = document.createElement('select');
      select.id = `signal-map-${item.key}`;
      const none = document.createElement('option');
      none.value = '';
      none.textContent = t('channels.none');
      select.append(none);
      for (const channel of this.devices.selectedChannels('logic')) {
        const option = document.createElement('option');
        option.value = String(channel);
        option.textContent = this.devices.channelName('logic', channel);
        option.disabled = used.has(channel) && signal.mapping[item.key] !== channel;
        select.append(option);
      }
      select.value = signal.mapping[item.key] === undefined ? '' : String(signal.mapping[item.key]);
      select.addEventListener('change', () => {
        const channel = select.value === '' ? undefined : Number(select.value);
        if (channel === undefined) delete signal.mapping[item.key];
        else signal.mapping[item.key] = channel;
        this.commit();
      });
      label.append(caption, select);
      mapping.append(label);
    }
    const options = document.getElementById('signal-options')!;
    options.replaceChildren();
    for (const declaration of declarations(decoderDefinition(signal.decoder).descriptor.id as DecoderId)) {
      const label = document.createElement('label');
      label.className = 'field';
      const caption = document.createElement('span');
      const key = `decoder.${signal.decoder}.option.${declaration.id}`;
      if (hasMessage(key)) caption.dataset.i18n = key;
      caption.textContent = declaration.desc ?? declaration.id;
      let control: HTMLInputElement | HTMLSelectElement;
      if (declaration.values) {
        control = document.createElement('select');
        for (const value of declaration.values) {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = String(value);
          const valueKey = `decoder.${signal.decoder}.value.${value}`;
          if (hasMessage(valueKey)) option.dataset.i18n = valueKey;
          control.append(option);
        }
      } else {
        control = document.createElement('input');
        control.type = typeof declaration.default === 'number' ? 'number' : 'text';
        control.step = declaration.step === 'any' ? 'any' : String(declaration.step ?? 1);
        if (declaration.min !== undefined) control.min = String(declaration.min);
        if (declaration.max !== undefined) control.max = String(declaration.max);
      }
      control.id = `signal-option-${declaration.id}`;
      control.value = String(signal.options[declaration.id] ?? declaration.default);
      control.addEventListener('change', () => {
        signal.options[declaration.id] = optionValue(declaration, control.value);
        this.commit(false);
      });
      label.append(caption, control);
      options.append(label);
    }
    this.setBusy(this.busy);
  }
  private renderAnalog(signal: DemoAnalogSignal): void {
    const pattern = select(this.section!, 'signal-pattern');
    pattern.replaceChildren();
    for (const value of DEMO_ANALOG_PATTERNS) {
      const option = document.createElement('option');
      option.value = value;
      const key = `driver.demo.value.${value}`;
      if (hasMessage(key)) option.dataset.i18n = key;
      option.textContent = value;
      pattern.append(option);
    }
    pattern.value = signal.pattern;
    const channel = select(this.section!, 'signal-channel'),
      used = this.usedChannels(signal.id, 'analog');
    channel.replaceChildren();
    for (const value of this.devices.selectedChannels('analog')) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = this.devices.channelName('analog', value);
      option.disabled = used.has(value);
      channel.append(option);
    }
    channel.value = String(signal.channel);
    input(this.section!, 'signal-frequency').value = String(signal.frequencyHz);
    input(this.section!, 'signal-amplitude').value = String(signal.amplitude);
    input(this.section!, 'signal-offset').value = String(signal.offset);
    input(this.section!, 'signal-seed').value = String(signal.seed);
    this.setBusy(this.busy);
  }
  private usedChannels(exceptId: string, kind: 'logic' | 'analog'): Set<number> {
    const values = new Set<number>();
    for (const signal of this.signals) {
      if (signal.id === exceptId) continue;
      if (kind === 'logic') {
        if (signal.kind === 'encoder') for (const channel of Object.values(signal.mapping)) values.add(channel);
      } else if (signal.kind === 'analog') values.add(signal.channel);
    }
    return values;
  }
  private freeAnalogChannel(): number | undefined {
    const used = this.usedChannels('', 'analog');
    return this.devices.selectedChannels('analog').find((channel) => !used.has(channel));
  }
  private async addSignal(): Promise<void> {
    if (this.busy || this.signals.length >= 100) return;
    const type = (document.getElementById('add-signal-type') as HTMLSelectElement).value;
    if (type === 'analog') {
      const channel = this.freeAnalogChannel();
      if (channel === undefined) {
        this.setError(t('signal.no-channel'));
        return;
      }
      const signal: DemoAnalogSignal = {
        id: `signal-${crypto.randomUUID()}`,
        name: `${t('signal.analog')} A${channel}`,
        kind: 'analog',
        channel,
        pattern: 'sine',
        frequencyHz: 1_000,
        amplitude: 1,
        offset: 0,
        seed: 1,
      };
      this.signals.push(signal);
      this.selectedId = signal.id;
      this.commit();
      return;
    }
    const presets = await this.ensurePresets(type);
    const preset = presets[0];
    if (!preset) {
      this.setError(t('signal.invalid'));
      return;
    }
    const count = this.signals.filter((signal) => signal.kind === 'encoder' && signal.decoder === type).length;
    const mapping: Record<string, number> = {},
      used = this.usedChannels('', 'logic'),
      available = this.devices.selectedChannels('logic').filter((channel) => !used.has(channel));
    for (const item of decoderDefinition(type as DecoderId).ui.inputs) {
      const channel = available.shift();
      if (channel === undefined) continue;
      mapping[item.key] = channel;
    }
    if (!Object.keys(mapping).length) {
      this.setError(t('signal.no-channel'));
      return;
    }
    const signal: DemoEncoderSignal = {
      id: `signal-${crypto.randomUUID()}`,
      name: decoderName(type) + (count ? ` ${count + 1}` : ''),
      kind: 'encoder',
      decoder: type,
      caseName: preset.name,
      options: { ...preset.options },
      mapping,
    };
    this.signals.push(signal);
    this.selectedId = signal.id;
    this.commit();
  }
  private removeSelected(): void {
    if (this.busy || !this.selectedId) return;
    const index = this.signals.findIndex((signal) => signal.id === this.selectedId);
    if (index < 0) return;
    this.signals.splice(index, 1);
    this.selectedId = this.signals[Math.min(index, this.signals.length - 1)]?.id ?? null;
    this.commit();
  }
  private async changeDecoder(): Promise<void> {
    const signal = this.selected;
    if (signal?.kind !== 'encoder' || this.busy) return;
    const decoder = select(this.section!, 'signal-decoder').value;
    if (!encoderIds.includes(decoder)) return;
    const presets = await this.ensurePresets(decoder),
      preset = presets[0];
    if (!preset) return;
    signal.decoder = decoder;
    signal.caseName = preset.name;
    signal.options = { ...preset.options };
    const keys = new Set(decoderDefinition(decoder as DecoderId).ui.inputs.map((item) => item.key));
    signal.mapping = Object.fromEntries(Object.entries(signal.mapping).filter(([key]) => keys.has(key)));
    this.reconcile();
    this.commit();
  }
  private changeCase(): void {
    const signal = this.selected;
    if (signal?.kind !== 'encoder' || this.busy) return;
    const name = select(this.section!, 'signal-case').value;
    const preset = this.presets.get(signal.decoder)?.find((item) => item.name === name);
    if (!preset) return;
    signal.caseName = preset.name;
    signal.options = { ...preset.options };
    this.commit(false);
  }
  private changeAnalog(): void {
    const signal = this.selected;
    if (signal?.kind !== 'analog' || this.busy) return;
    const section = this.section!,
      frequency = Number(input(section, 'signal-frequency').value),
      amplitude = Number(input(section, 'signal-amplitude').value),
      offset = Number(input(section, 'signal-offset').value),
      seed = Number(input(section, 'signal-seed').value);
    signal.pattern = select(section, 'signal-pattern').value as DemoAnalogSignal['pattern'];
    signal.channel = Number(select(section, 'signal-channel').value);
    signal.frequencyHz = frequency;
    signal.amplitude = amplitude;
    signal.offset = offset;
    signal.seed = seed;
    this.commit(false);
  }
  private ensurePresets(decoder: string): Promise<readonly SignalEncoderPreset[]> {
    const cached = this.presets.get(decoder);
    if (cached) return Promise.resolve(cached);
    const pending = this.pendingPresets.get(decoder);
    if (pending) return pending;
    const request = loadSignalEncoderPresets(decoder)
      .catch((): readonly SignalEncoderPreset[] => [])
      .then((presets) => {
        this.presets.set(decoder, presets);
        this.pendingPresets.delete(decoder);
        return presets;
      });
    this.pendingPresets.set(decoder, request);
    return request;
  }
  private normalizeCase(signal: DemoSignal): void {
    if (signal.kind !== 'encoder') return;
    const presets = this.presets.get(signal.decoder);
    if (!presets?.length || presets.some((preset) => preset.name === signal.caseName)) return;
    signal.caseName = presets[0]!.name;
    signal.options = { ...presets[0]!.options, ...signal.options };
  }
}
