import type { DecoderDefinition, DecoderInputDefinition, ProtocolBinding } from '../decoders/definition.js';
import type { OptionDeclaration, OptionValue } from '../libhakeidecode/types.js';
import { hasMessage, t } from './i18n.js';
import { isDarkColor, normalizeHiddenRows, protocolRowId, protocolTrackColor } from './protocol-tracks.js';
import type { ProtocolMappingValue, ProtocolSettings } from './workspace.js';

export interface DecoderMappingCandidate {
  readonly id: string;
  readonly name: string;
  readonly outputs: readonly string[];
}

export interface DecoderMappingFieldContext {
  readonly input: DecoderInputDefinition;
  readonly count: number;
  readonly labels?: readonly string[];
  readonly selectedLogicChannels: readonly number[];
  readonly protocolId: string;
  readonly downstreamIds: ReadonlySet<string>;
  readonly upstreamCandidates: readonly DecoderMappingCandidate[];
  readonly value: ProtocolMappingValue | undefined;
  readonly idPrefix?: string;
}

interface TrackHandlers {
  readonly protocolId: string;
  readonly decoder: string;
  color: string;
  readonly definition: DecoderDefinition;
  getHiddenRows: () => readonly string[] | undefined;
  onToggleRow: (rowId: string, visible: boolean) => void;
  onSetAll: (visible: boolean) => void;
}

export interface DecoderTracksSectionOptions {
  readonly protocolId: string;
  readonly decoder: string;
  readonly color: string;
  readonly definition: DecoderDefinition;
  readonly hiddenRows: readonly string[] | undefined;
  readonly onToggleRow: (rowId: string, visible: boolean) => void;
  readonly onSetAll: (visible: boolean) => void;
}

export interface OpenProtocolSettingsOptions {
  readonly protocol: ProtocolSettings;
  readonly definition: DecoderDefinition;
  readonly declarations: readonly OptionDeclaration[];
  readonly count: number;
  readonly labels?: readonly string[];
  readonly selectedLogicChannels: readonly number[];
  readonly downstreamIds: ReadonlySet<string>;
  readonly upstreamCandidates: readonly DecoderMappingCandidate[];
  readonly onIdentityChange: (name: string, color: string) => void;
  readonly onMappingChange: (key: string, value: ProtocolMappingValue | undefined) => void;
  readonly onOptionChange: (id: string, value: string) => void;
  readonly onDecimalsChange: (decimals: number) => void;
  readonly onToggleRow: (rowId: string, visible: boolean) => readonly string[] | undefined;
  readonly onSetAllRows: (visible: boolean) => readonly string[] | undefined;
  readonly onRemove: () => void;
}

const trackHandlers = new WeakMap<HTMLElement, TrackHandlers>();

export function buildDecoderOptionField(
  decoderId: string,
  option: OptionDeclaration,
  value: OptionValue,
  idPrefix?: string,
): { readonly label: HTMLLabelElement; readonly control: HTMLInputElement | HTMLSelectElement } {
  const label = document.createElement('label');
  label.className = 'field';
  const caption = document.createElement('span');
  const optionKey = 'decoder.' + decoderId + '.option.' + option.id;
  if (hasMessage(optionKey)) {
    caption.dataset.i18n = optionKey;
    caption.textContent = t(optionKey);
  } else {
    caption.textContent = option.desc ?? option.id;
  }
  label.append(caption);

  let control: HTMLInputElement | HTMLSelectElement;
  if (option.values) {
    control = document.createElement('select');
    for (const choice of option.values) {
      const item = document.createElement('option');
      item.value = String(choice);
      const valueKey = 'decoder.' + decoderId + '.value.' + choice;
      if (hasMessage(valueKey)) {
        item.dataset.i18n = valueKey;
        item.textContent = t(valueKey);
      } else {
        item.textContent = String(choice);
      }
      control.append(item);
    }
  } else {
    control = document.createElement('input');
    control.type = typeof option.default === 'number' ? 'number' : 'text';
    control.step =
      option.step === 'any' ||
      (option.step === undefined && typeof option.default === 'number' && !Number.isInteger(option.default))
        ? 'any'
        : String(option.step ?? 1);
    if (option.min !== undefined) control.min = String(option.min);
    if (option.max !== undefined) control.max = String(option.max);
    control.required = !!option.required;
  }
  if (idPrefix !== undefined) control.id = idPrefix + option.id;
  control.dataset.optionId = option.id;
  control.value = String(value ?? option.default);
  if (hasMessage(optionKey)) {
    control.dataset.i18nAttrs = 'aria-label:' + optionKey;
    control.setAttribute('aria-label', t(optionKey));
  } else {
    control.setAttribute('aria-label', option.desc ?? option.id);
  }
  label.append(control);
  return { label, control };
}

export function buildDecoderMappingField(context: DecoderMappingFieldContext): {
  readonly label: HTMLLabelElement;
  readonly select: HTMLSelectElement;
} {
  const {
    input,
    count,
    labels,
    selectedLogicChannels,
    protocolId,
    downstreamIds,
    upstreamCandidates,
    value,
    idPrefix,
  } = context;
  const label = document.createElement('label');
  label.className = 'field';
  const caption = document.createElement('span');
  if (input.labelKey && hasMessage(input.labelKey)) {
    caption.dataset.i18n = input.labelKey;
    caption.textContent = t(input.labelKey);
  } else {
    caption.textContent = input.label;
  }
  label.append(caption);

  const select = document.createElement('select');
  if (idPrefix !== undefined) select.id = idPrefix + input.key;
  select.dataset.mappingKey = input.key;
  if (input.labelKey && hasMessage(input.labelKey)) {
    select.dataset.i18nAttrs = 'aria-label:' + input.labelKey;
    select.setAttribute('aria-label', t(input.labelKey));
  } else {
    select.setAttribute('aria-label', input.label);
  }

  const none = document.createElement('option');
  none.value = '';
  none.dataset.i18n = 'channels.none';
  none.textContent = t('channels.none');
  select.append(none);

  if (input.kind === 'protocol') {
    for (const upstream of upstreamCandidates) {
      if (upstream.id === protocolId || downstreamIds.has(upstream.id)) continue;
      if (!upstream.outputs.includes(input.key)) continue;
      const item = document.createElement('option');
      item.value = JSON.stringify({ instanceId: upstream.id, protoId: input.key } satisfies ProtocolBinding);
      item.textContent = `${upstream.name} · ${input.key}`;
      select.append(item);
    }
  } else {
    for (let i = 0; i < count; i++) {
      const item = document.createElement('option');
      item.value = String(i);
      item.textContent = labels?.[i] ?? 'D' + selectedLogicChannels[i];
      select.append(item);
    }
  }

  select.value =
    input.kind === 'protocol'
      ? value && typeof value === 'object' && !Array.isArray(value)
        ? JSON.stringify(value)
        : ''
      : typeof value === 'number' && value < count
        ? String(value)
        : '';

  label.append(select);
  return { label, select };
}

function updateTracksDom(container: HTMLElement, state: TrackHandlers): void {
  const rows = state.definition.ui.rows;
  const hiddenSet = new Set(normalizeHiddenRows(state.definition, state.getHiddenRows()));
  const darkTheme = isDarkColor(getComputedStyle(document.documentElement).getPropertyValue('--wave-bg') || '#111720');
  const visibleCount = rows.length - hiddenSet.size;
  const count = container.querySelector('.decoder-tracks-count');
  if (count) count.textContent = t('decoder.tracksCount', { visible: visibleCount, total: rows.length });
  const showAllBtn = container.querySelector<HTMLButtonElement>('[data-action="show-all"]');
  if (showAllBtn) showAllBtn.disabled = hiddenSet.size === 0;
  const hideAllBtn = container.querySelector<HTMLButtonElement>('[data-action="hide-all"]');
  if (hideAllBtn) hideAllBtn.disabled = hiddenSet.size === rows.length;
  rows.forEach((row, index) => {
    const rowId = protocolRowId(row, index);
    const isHidden = hiddenSet.has(rowId);
    const checkbox = container.querySelector<HTMLInputElement>(`input[data-track-id="${CSS.escape(rowId)}"]`);
    if (checkbox) {
      checkbox.checked = !isHidden;
      const item = checkbox.closest('.decoder-track-item');
      item?.classList.toggle('is-hidden', isHidden);
      const swatch = item?.querySelector<HTMLElement>('.decoder-track-swatch');
      if (swatch) {
        const style = protocolTrackColor(state.color, index, 0, darkTheme);
        swatch.style.backgroundColor = style.fill;
        swatch.style.borderColor = style.border;
      }
    }
  });
}

export function renderDecoderTracksSection(container: HTMLElement, options: DecoderTracksSectionOptions): void {
  const { protocolId, decoder, color, definition, hiddenRows, onToggleRow, onSetAll } = options;
  const rows = definition.ui.rows;
  if (!rows.length) {
    delete container.dataset.protocolKey;
    trackHandlers.delete(container);
    container.replaceChildren();
    container.hidden = true;
    return;
  }

  let currentHidden = hiddenRows;
  const state: TrackHandlers = {
    protocolId,
    decoder,
    color,
    definition,
    getHiddenRows: () => currentHidden,
    onToggleRow,
    onSetAll,
  };
  trackHandlers.set(container, state);

  const protocolKey = `${protocolId}:${decoder}`;
  container.hidden = false;
  if (container.dataset.protocolKey === protocolKey) {
    updateTracksDom(container, state);
    return;
  }

  container.dataset.protocolKey = protocolKey;
  const hiddenSet = new Set(normalizeHiddenRows(definition, hiddenRows));
  const darkTheme = isDarkColor(getComputedStyle(document.documentElement).getPropertyValue('--wave-bg') || '#111720');
  const visibleCount = rows.length - hiddenSet.size;

  const header = document.createElement('div');
  header.className = 'decoder-tracks-header';
  const title = document.createElement('strong');
  title.dataset.i18n = 'decoder.tracks';
  title.textContent = t('decoder.tracks');
  const count = document.createElement('span');
  count.className = 'decoder-tracks-count';
  count.textContent = t('decoder.tracksCount', { visible: visibleCount, total: rows.length });

  const showAllBtn = document.createElement('button');
  showAllBtn.type = 'button';
  showAllBtn.className = 'text-button';
  showAllBtn.dataset.action = 'show-all';
  showAllBtn.dataset.i18n = 'decoder.tracksShowAll';
  showAllBtn.textContent = t('decoder.tracksShowAll');
  showAllBtn.disabled = hiddenSet.size === 0;
  showAllBtn.addEventListener('click', () => {
    trackHandlers.get(container)?.onSetAll(true);
  });

  const hideAllBtn = document.createElement('button');
  hideAllBtn.type = 'button';
  hideAllBtn.className = 'text-button';
  hideAllBtn.dataset.action = 'hide-all';
  hideAllBtn.dataset.i18n = 'decoder.tracksHideAll';
  hideAllBtn.textContent = t('decoder.tracksHideAll');
  hideAllBtn.disabled = hiddenSet.size === rows.length;
  hideAllBtn.addEventListener('click', () => {
    trackHandlers.get(container)?.onSetAll(false);
  });

  header.append(title, count, showAllBtn, hideAllBtn);

  const list = document.createElement('div');
  list.className = 'decoder-tracks-list';
  rows.forEach((row, index) => {
    const rowId = protocolRowId(row, index);
    const isHidden = hiddenSet.has(rowId);
    const item = document.createElement('label');
    item.className = 'decoder-track-item' + (isHidden ? ' is-hidden' : '');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !isHidden;
    checkbox.dataset.trackId = rowId;
    checkbox.addEventListener('change', () => {
      trackHandlers.get(container)?.onToggleRow(rowId, checkbox.checked);
    });
    const swatch = document.createElement('span');
    swatch.className = 'decoder-track-swatch';
    const style = protocolTrackColor(color, index, 0, darkTheme);
    swatch.style.backgroundColor = style.fill;
    swatch.style.borderColor = style.border;
    const text = document.createElement('span');
    text.className = 'decoder-track-label';
    if (row.labelKey && hasMessage(row.labelKey)) text.dataset.i18n = row.labelKey;
    text.textContent = row.labelKey && hasMessage(row.labelKey) ? t(row.labelKey) : row.label;
    text.title = text.textContent;
    item.append(checkbox, swatch, text);
    list.append(item);
  });
  container.replaceChildren(header, list);
}

export function openProtocolSettings(options: OpenProtocolSettingsOptions): void {
  document.querySelector('dialog.channel-settings-dialog')?.remove();
  const { protocol, definition, declarations } = options;
  const dialog = document.createElement('dialog');
  const form = document.createElement('form');
  const title = document.createElement('h2');
  const status = document.createElement('p');

  dialog.className = 'channel-settings-dialog protocol-settings-dialog';
  form.method = 'dialog';

  const updateTitle = (name: string) => {
    title.textContent = `${t('decoder.settings')} · ${name}`;
    dialog.setAttribute('aria-label', title.textContent);
  };
  updateTitle(protocol.name);
  form.append(title);

  const descriptionText =
    definition.ui.descriptionKey && hasMessage(definition.ui.descriptionKey)
      ? t(definition.ui.descriptionKey)
      : (definition.ui.description ?? definition.descriptor.desc ?? '');
  if (descriptionText) {
    const description = document.createElement('p');
    description.className = 'hint dialog-description';
    description.textContent = descriptionText;
    form.append(description);
  }

  const nameLabel = document.createElement('label');
  const nameCaption = document.createElement('span');
  nameCaption.textContent = t('decoder.name');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.name = 'name';
  nameInput.maxLength = 80;
  nameInput.required = true;
  nameInput.value = protocol.name;
  nameInput.setAttribute('aria-label', t('decoder.name'));
  nameLabel.append(nameCaption, nameInput);

  const colorLabel = document.createElement('label');
  const colorCaption = document.createElement('span');
  colorCaption.textContent = t('decoder.color');
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.name = 'color';
  colorInput.value = protocol.color;
  colorInput.setAttribute('aria-label', t('decoder.color'));
  colorLabel.append(colorCaption, colorInput);

  form.append(nameLabel, colorLabel);

  for (const input of definition.ui.inputs) {
    const { label, select } = buildDecoderMappingField({
      input,
      count: options.count,
      labels: options.labels,
      selectedLogicChannels: options.selectedLogicChannels,
      protocolId: protocol.id,
      downstreamIds: options.downstreamIds,
      upstreamCandidates: options.upstreamCandidates,
      value: protocol.mapping[input.key],
    });
    select.addEventListener('change', () => {
      if (select.value === '') options.onMappingChange(input.key, undefined);
      else if (input.kind === 'protocol')
        options.onMappingChange(input.key, JSON.parse(select.value) as ProtocolBinding);
      else options.onMappingChange(input.key, Number(select.value));
    });
    form.append(label);
  }

  const primary = new Set(definition.ui.primaryOptions ?? []);
  const advancedDetails = document.createElement('details');
  advancedDetails.className = 'advanced';
  const advancedSummary = document.createElement('summary');
  advancedSummary.textContent = t('decoder.advanced');
  advancedDetails.append(advancedSummary);
  let advancedCount = 0;

  for (const option of declarations) {
    const { label, control } = buildDecoderOptionField(
      protocol.decoder,
      option,
      protocol.options[option.id] ?? option.default,
    );
    control.addEventListener('change', () => {
      if (!control.checkValidity()) {
        status.textContent = t('channels.invalid');
        return;
      }
      status.textContent = '';
      options.onOptionChange(option.id, control.value);
    });
    if (primary.has(option.id)) {
      form.append(label);
    } else {
      advancedDetails.append(label);
      advancedCount++;
    }
  }
  if (advancedCount > 0) form.append(advancedDetails);

  if (definition.ui.decimals) {
    const decLabel = document.createElement('label');
    const decCaption = document.createElement('span');
    decCaption.textContent = t('decoder.decimals');
    const decSelect = document.createElement('select');
    decSelect.setAttribute('aria-label', t('decoder.decimals'));
    for (let i = 0; i <= 9; i++) decSelect.add(new Option(String(i), String(i)));
    decSelect.value = String(protocol.decimalPlaces ?? 3);
    decSelect.addEventListener('change', () => {
      options.onDecimalsChange(Number(decSelect.value));
    });
    decLabel.append(decCaption, decSelect);
    form.append(decLabel);
  }

  let currentHidden: readonly string[] | undefined = protocol.hiddenRows;
  let tracksContainer: HTMLDivElement | null = null;
  const syncTracks = () => {
    if (!tracksContainer || !definition.ui.rows.length) return;
    renderDecoderTracksSection(tracksContainer, {
      protocolId: protocol.id,
      decoder: protocol.decoder,
      color: colorInput.value,
      definition,
      hiddenRows: currentHidden,
      onToggleRow: (rowId, visible) => {
        currentHidden = options.onToggleRow(rowId, visible);
        syncTracks();
      },
      onSetAll: (visible) => {
        currentHidden = options.onSetAllRows(visible);
        syncTracks();
      },
    });
  };
  if (definition.ui.rows.length) {
    tracksContainer = document.createElement('div');
    tracksContainer.className = 'decoder-tracks';
    form.append(tracksContainer);
    syncTracks();
  }

  status.className = 'channel-settings-error';
  status.setAttribute('role', 'alert');
  form.append(status);

  const validateAll = () => {
    if (!form.checkValidity() || !nameInput.value.trim()) {
      status.textContent = t('channels.invalid');
      return false;
    }
    status.textContent = '';
    return true;
  };

  const applyIdentity = () => {
    if (!nameInput.value.trim()) {
      status.textContent = t('channels.invalid');
      return;
    }
    status.textContent = '';
    const trimmed = nameInput.value.trim().slice(0, 80);
    updateTitle(trimmed);
    options.onIdentityChange(trimmed, colorInput.value);
    syncTracks();
  };

  nameInput.addEventListener('input', applyIdentity);
  colorInput.addEventListener('input', applyIdentity);
  form.addEventListener('input', () => {
    if (form.checkValidity() && nameInput.value.trim()) status.textContent = '';
  });

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'button subtle danger';
  removeBtn.textContent = t('decoder.remove');
  removeBtn.addEventListener('click', () => {
    dialog.close();
    options.onRemove();
  });

  const done = document.createElement('button');
  done.type = 'submit';
  done.className = 'button primary';
  done.textContent = t('channels.done');
  actions.append(removeBtn, done);
  form.append(actions);

  form.addEventListener('submit', (event) => {
    if (!validateAll()) {
      event.preventDefault();
      if (advancedCount > 0 && !advancedDetails.open && advancedDetails.querySelector(':invalid')) {
        advancedDetails.open = true;
      }
      return;
    }
    applyIdentity();
  });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
}
