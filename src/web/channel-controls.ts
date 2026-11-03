import {
  analogAxis,
  parseAnalogSettings,
  roundAnalogResolution,
  thresholdPresets,
  schmittPresets,
  type AnalogSettings,
} from './analog-settings.js';
import type { AnalogRange } from './data/analogStore.js';
import { t, type MessageKey } from './i18n.js';

export function openAnalogSettings(
  channel: number,
  name: string,
  settings: AnalogSettings,
  range: AnalogRange | null,
  update: (name: string, settings: AnalogSettings) => void,
  nameEditable = true,
): void {
  document.querySelector('dialog.channel-settings-dialog')?.remove();
  const dialog = document.createElement('dialog'),
    form = document.createElement('form'),
    title = document.createElement('h2'),
    status = document.createElement('p');
  dialog.className = 'channel-settings-dialog';
  form.method = 'dialog';
  title.textContent = `${t('analog.settings')} · A${channel}`;
  dialog.setAttribute('aria-label', title.textContent);
  form.append(title);
  const field = (key: MessageKey, control: HTMLInputElement | HTMLSelectElement) => {
    const label = document.createElement('label'),
      caption = document.createElement('span');
    caption.textContent = t(key);
    label.append(caption, control);
    form.append(label);
    control.setAttribute('aria-label', t(key));
    return control;
  };
  const input = (key: MessageKey, id: string, value: string, type = 'number', min?: number, max?: number) => {
    const control = document.createElement('input');
    control.name = id;
    control.type = type;
    control.value = value;
    if (type === 'number') {
      control.required = true;
      control.step = 'any';
    }
    if (min !== undefined) control.min = String(min);
    if (max !== undefined) control.max = String(max);
    field(key, control);
    return control;
  };
  const select = (key: MessageKey, id: string, options: readonly (readonly [string, string])[], value: string) => {
    const control = document.createElement('select');
    control.name = id;
    for (const [value, label] of options)
      control.add(new Option(label.startsWith('analog.') ? t(label as MessageKey) : label, value));
    control.value = value;
    field(key, control);
    return control;
  };
  const nameInput = input('channels.name', 'name', name, 'text');
  nameInput.maxLength = 80;
  nameInput.disabled = !nameEditable;
  const color = input('analog.color', 'color', settings.color, 'color'),
    positive = input('analog.positiveDivs', 'positiveDivs', String(settings.positiveDivs), 'number', 0, 8),
    negative = input('analog.negativeDivs', 'negativeDivs', String(settings.negativeDivs), 'number', 0, 8),
    height = input('channels.divHeight', 'divHeight', String(settings.divHeight), 'number', 12, 250),
    resolution = input(
      'analog.resolution',
      'resolution',
      String(settings.autorange && range ? analogAxis(range, settings).perDivision : settings.resolution),
      'number',
      0.001,
    ),
    auto = input('analog.autorange', 'autorange', '', 'checkbox');
  positive.step = negative.step = height.step = '1';
  resolution.step = '0.001';
  if (!settings.autorange) resolution.value = String(roundAnalogResolution(settings.resolution));
  auto.checked = settings.autorange;
  const choices = document.createElement('datalist');
  choices.id = `analog-resolution-${channel}`;
  for (let exponent = -3; exponent <= 9; exponent++)
    for (const multiple of [1, 2, 5]) {
      const option = document.createElement('option');
      option.value = String(multiple * 10 ** exponent);
      choices.append(option);
    }
  resolution.setAttribute('list', choices.id);
  form.append(choices);
  const conversion = select(
      'analog.conversion',
      'conversion',
      [
        ['none', 'analog.none'],
        ['threshold', 'analog.threshold'],
        ['schmitt', 'analog.schmitt'],
      ],
      settings.conversion,
    ),
    threshold = select(
      'analog.thresholds',
      'threshold',
      settings.conversion === 'schmitt' ? schmittPresets : thresholdPresets,
      settings.threshold,
    ),
    traces = select(
      'analog.traces',
      'traces',
      [
        ['analog', 'analog.analog'],
        ['converted', 'analog.converted'],
        ['both', 'analog.both'],
      ],
      settings.traces,
    );
  status.className = 'channel-settings-error';
  status.setAttribute('role', 'alert');
  form.append(status);
  const sync = () => {
    resolution.disabled = auto.checked;
    threshold.disabled = traces.disabled = conversion.value === 'none';
  };
  const apply = () => {
    if (auto.checked && range && Number(positive.value) + Number(negative.value) > 0)
      resolution.value = String(
        analogAxis(range, {
          ...settings,
          autorange: true,
          positiveDivs: Number(positive.value),
          negativeDivs: Number(negative.value),
        }).perDivision,
      );
    sync();
    try {
      if (!form.checkValidity() || !nameInput.value.trim()) throw new Error('Invalid settings');
      const next = parseAnalogSettings({
        color: color.value,
        positiveDivs: Number(positive.value),
        negativeDivs: Number(negative.value),
        divHeight: Number(height.value),
        resolution: Number(resolution.value),
        autorange: auto.checked,
        conversion: conversion.value,
        threshold: threshold.value,
        traces: traces.value,
      });
      update(nameInput.value.trim(), next);
      status.textContent = '';
      return true;
    } catch {
      status.textContent = t('analog.invalid');
      return false;
    }
  };
  conversion.addEventListener('change', () => {
    threshold.replaceChildren();
    for (const [value, label] of conversion.value === 'schmitt' ? schmittPresets : thresholdPresets)
      threshold.add(new Option(label.startsWith('analog.') ? t(label as MessageKey) : label, value));
    apply();
  });
  form.addEventListener('input', apply);
  form.addEventListener('change', (event) => {
    const control = event.target;
    if (control instanceof HTMLInputElement && control.value !== '' && Number.isFinite(control.valueAsNumber)) {
      if (control === resolution) control.value = String(roundAnalogResolution(control.valueAsNumber));
      else if (control === positive || control === negative || control === height)
        control.value = String(Math.round(control.valueAsNumber));
    }
    apply();
  });
  const done = document.createElement('button');
  done.type = 'submit';
  done.className = 'button';
  done.textContent = t('channels.done');
  form.append(done);
  form.addEventListener('submit', (event) => {
    if (!apply()) event.preventDefault();
  });
  dialog.addEventListener('close', () => dialog.remove());
  sync();
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
}

export function openDigitalSettings(
  channel: number,
  name: string,
  height: number,
  update: (name: string, height: number) => void,
  nameEditable = true,
): void {
  document.querySelector('dialog.channel-settings-dialog')?.remove();
  const dialog = document.createElement('dialog'),
    form = document.createElement('form'),
    title = document.createElement('h2');
  dialog.className = 'channel-settings-dialog';
  form.method = 'dialog';
  title.textContent = `${t('channels.digitalSettings')} · D${channel}`;
  dialog.setAttribute('aria-label', title.textContent);
  form.append(title);
  const field = (key: MessageKey, input: HTMLInputElement) => {
    const label = document.createElement('label'),
      caption = document.createElement('span');
    caption.textContent = t(key);
    input.setAttribute('aria-label', t(key));
    label.append(caption, input);
    form.append(label);
  };
  const nameInput = document.createElement('input'),
    heightInput = document.createElement('input');
  nameInput.name = 'name';
  nameInput.value = name;
  nameInput.required = true;
  nameInput.maxLength = 80;
  nameInput.disabled = !nameEditable;
  heightInput.name = 'divHeight';
  heightInput.type = 'number';
  heightInput.value = String(height);
  heightInput.required = true;
  heightInput.min = '12';
  heightInput.max = '250';
  heightInput.step = '1';
  field('channels.name', nameInput);
  field('channels.divHeight', heightInput);
  const status = document.createElement('p');
  status.className = 'channel-settings-error';
  status.setAttribute('role', 'alert');
  form.append(status);
  const apply = () => {
    if (!form.checkValidity() || !nameInput.value.trim()) {
      status.textContent = t('channels.invalid');
      return false;
    }
    update(nameInput.value.trim(), heightInput.valueAsNumber);
    status.textContent = '';
    return true;
  };
  form.addEventListener('input', apply);
  form.addEventListener('change', () => {
    if (heightInput.value !== '' && Number.isFinite(heightInput.valueAsNumber))
      heightInput.value = String(Math.round(heightInput.valueAsNumber));
    apply();
  });
  const done = document.createElement('button');
  done.type = 'submit';
  done.className = 'button';
  done.textContent = t('channels.done');
  form.append(done);
  form.addEventListener('submit', (event) => {
    if (!apply()) event.preventDefault();
  });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
}
