import type { DecoderDefinition } from '../decoders/definition.js';
import { t } from './i18n.js';

export function decoderSearchText(definition: DecoderDefinition): string {
  const id = definition.descriptor.id;
  const parts = [
    id,
    definition.descriptor.name,
    definition.descriptor.longname,
    definition.descriptor.desc,
    ...(definition.descriptor.tags ?? []),
    definition.messages.en[`decoder.${id}.name`],
    definition.messages['zh-CN']?.[`decoder.${id}.name`],
    definition.messages.en[`decoder.${id}.description`],
    definition.messages['zh-CN']?.[`decoder.${id}.description`],
  ];
  return parts.filter(Boolean).join(' ');
}

interface OptionEntry {
  value: string;
  label: string;
  search: string;
  disabled: boolean;
  score: number;
}

export class SearchSelect {
  readonly wrapper: HTMLDivElement;
  private readonly trigger: HTMLButtonElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly popover: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private open = false;
  private activeIndex = 0;
  private filtered: OptionEntry[] = [];
  private readonly onDocPointerDown: (event: PointerEvent) => void;
  private readonly onViewportChange: () => void;
  private readonly onNativeChange: () => void;

  constructor(
    readonly select: HTMLSelectElement,
    private readonly placeholder = () => t('search.placeholder'),
    private readonly emptyText = () => t('search.empty'),
  ) {
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'search-select';
    select.parentElement?.insertBefore(this.wrapper, select);
    select.classList.add('search-select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    this.wrapper.append(select);

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'search-select-trigger';
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'search-select-label';
    const caret = document.createElement('span');
    caret.className = 'search-select-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    this.trigger.append(this.labelEl, caret);
    this.wrapper.append(this.trigger);

    this.popover = document.createElement('div');
    this.popover.className = 'search-select-popover';
    this.popover.hidden = true;
    this.input = document.createElement('input');
    this.input.type = 'search';
    this.input.className = 'search-select-input';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.list = document.createElement('div');
    this.list.className = 'search-select-list';
    this.list.setAttribute('role', 'listbox');
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'search-select-empty';
    this.emptyEl.hidden = true;
    this.popover.append(this.input, this.list, this.emptyEl);
    this.wrapper.append(this.popover);

    this.trigger.addEventListener('click', (event) => {
      event.preventDefault();
      if (this.select.disabled) return;
      if (this.open) this.close();
      else this.openPopover();
    });
    this.trigger.addEventListener('keydown', (event) => {
      if (this.select.disabled) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.openPopover();
      }
    });
    this.input.addEventListener('input', () => this.renderList());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close(true);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.moveActive(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveActive(-1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const item = this.filtered[this.activeIndex];
        if (item && !item.disabled) this.choose(item.value);
      }
    });

    this.onDocPointerDown = (event) => {
      if (!this.open) return;
      const target = event.target as Node | null;
      if (target && (this.wrapper.contains(target) || this.popover.contains(target))) return;
      this.close();
    };
    this.onViewportChange = () => {
      if (this.open) this.position();
    };
    this.onNativeChange = () => this.refresh();
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('scroll', this.onViewportChange, true);
    select.addEventListener('change', this.onNativeChange);
    this.refresh();
  }

  refresh(): void {
    const selected = this.select.selectedOptions[0] ?? this.select.options[0];
    this.labelEl.textContent = selected?.textContent ?? '';
    this.trigger.title = selected?.textContent ?? '';
    this.trigger.disabled = this.select.disabled;
    const ariaLabel = this.select.getAttribute('aria-label');
    if (ariaLabel) {
      this.trigger.setAttribute('aria-label', ariaLabel);
      this.input.setAttribute('aria-label', ariaLabel);
    }
    this.input.placeholder = this.placeholder();
    this.emptyEl.textContent = this.emptyText();
    if (this.select.disabled && this.open) this.close();
    else if (this.open) this.renderList();
  }

  private openPopover(): void {
    this.open = true;
    this.input.value = '';
    this.input.placeholder = this.placeholder();
    this.emptyEl.textContent = this.emptyText();
    this.popover.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.wrapper.classList.add('open');
    this.renderList(true);
    this.position();
    this.input.focus();
  }

  private close(focusTrigger = false): void {
    if (!this.open) return;
    this.open = false;
    this.popover.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.wrapper.classList.remove('open');
    if (focusTrigger) this.trigger.focus();
  }

  private position(): void {
    const rect = this.trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 220);
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const left = Math.min(Math.max(8, rect.left), maxLeft);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const placeTop = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxListHeight = Math.max(120, Math.min(280, (placeTop ? spaceAbove : spaceBelow) - 52));
    this.popover.style.width = `${width}px`;
    this.popover.style.left = `${left}px`;
    if (placeTop) {
      this.popover.style.top = 'auto';
      this.popover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 4)}px`;
    } else {
      this.popover.style.bottom = 'auto';
      this.popover.style.top = `${rect.bottom + 4}px`;
    }
    this.list.style.maxHeight = `${maxListHeight}px`;
  }

  private collectEntries(): OptionEntry[] {
    const query = this.input.value.trim().toLowerCase();
    const tokens = query ? query.split(/\s+/).filter(Boolean) : [];
    const items: OptionEntry[] = [];
    for (const option of this.select.options) {
      const label = option.textContent ?? '';
      const value = option.value;
      const search = `${label} ${value} ${option.dataset.search ?? ''}`.toLowerCase();
      if (tokens.length && !tokens.every((token) => search.includes(token))) continue;
      let score = 0;
      if (query) {
        const lowerVal = value.toLowerCase();
        const lowerLabel = label.toLowerCase();
        if (lowerVal === query || lowerLabel === query) score = 3;
        else if (lowerVal.startsWith(query) || lowerLabel.startsWith(query)) score = 2;
        else if (lowerVal.includes(query) || lowerLabel.includes(query)) score = 1;
      }
      items.push({ value, label, search, disabled: option.disabled, score });
    }
    if (query) items.sort((a, b) => b.score - a.score);
    return items;
  }

  private renderList(selectCurrent = false): void {
    this.filtered = this.collectEntries();
    this.list.replaceChildren();
    this.emptyEl.hidden = this.filtered.length > 0;
    if (!this.filtered.length) {
      this.activeIndex = -1;
      return;
    }
    const currentIndex = selectCurrent ? this.filtered.findIndex((item) => item.value === this.select.value) : 0;
    this.activeIndex = currentIndex >= 0 ? currentIndex : 0;
    this.filtered.forEach((item, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'search-select-option';
      option.setAttribute('role', 'option');
      option.dataset.value = item.value;
      option.disabled = item.disabled;
      const isSelected = item.value === this.select.value;
      option.setAttribute('aria-selected', String(isSelected));
      if (isSelected) option.classList.add('selected');
      if (index === this.activeIndex) option.classList.add('active');
      const title = document.createElement('span');
      title.className = 'search-select-option-label';
      title.textContent = item.label;
      option.append(title);
      if (item.value && item.value.toLowerCase() !== item.label.toLowerCase()) {
        const code = document.createElement('small');
        code.className = 'search-select-option-id';
        code.textContent = item.value;
        option.append(code);
      }
      option.addEventListener('mouseenter', () => this.setActive(index, false));
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (!item.disabled) this.choose(item.value);
      });
      this.list.append(option);
    });
    const active = this.list.children[this.activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
  }

  private moveActive(delta: number): void {
    if (!this.filtered.length) return;
    let next = this.activeIndex;
    for (let step = 0; step < this.filtered.length; step++) {
      next = (next + delta + this.filtered.length) % this.filtered.length;
      if (!this.filtered[next]!.disabled) {
        this.setActive(next, true);
        return;
      }
    }
  }

  private setActive(index: number, scroll: boolean): void {
    const prev = this.list.children[this.activeIndex] as HTMLElement | undefined;
    prev?.classList.remove('active');
    this.activeIndex = index;
    const next = this.list.children[index] as HTMLElement | undefined;
    next?.classList.add('active');
    if (scroll) next?.scrollIntoView({ block: 'nearest' });
  }

  private choose(value: string): void {
    const changed = this.select.value !== value;
    this.select.value = value;
    this.refresh();
    this.close(true);
    if (changed) this.select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  dispose(): void {
    this.close();
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);
    this.select.removeEventListener('change', this.onNativeChange);
  }
}
