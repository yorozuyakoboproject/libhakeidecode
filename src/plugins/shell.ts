import type { BuiltinPluginDefinition, PluginContext } from '../kernel/types.js';
import { hasMessage, t, translateDOM } from '../web/i18n.js';
import { bindPreferenceControls } from '../web/preferences.js';

export interface ShellPageSpec {
  readonly id: string;
  readonly route: string;
  readonly label: string;
  readonly labelKey?: string;
  readonly order?: number;
  mount(container: HTMLElement, headerSlot: HTMLElement): (() => void) | void;
  onActivate?(): void;
  onDeactivate?(): void;
}

export interface ShellService {
  registerPage(spec: ShellPageSpec): () => void;
  navigate(route: string): void;
  readonly activeRoute: string;
}

interface MountedPage {
  readonly spec: ShellPageSpec;
  readonly container: HTMLDivElement;
  readonly headerSlot: HTMLDivElement;
  readonly navButton: HTMLButtonElement;
  readonly dispose?: () => void;
}

function parseHashRoute(): string {
  const raw = location.hash.replace(/^#\/?/, '').trim();
  return raw;
}

export const shellPlugin: BuiltinPluginDefinition = {
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'hakei.shell',
    name: 'Application Shell',
    version: '1.0.0',
    kind: 'ui',
    entry: 'shell.js',
    inject: [],
    optional: [],
    provides: ['shell'],
    contracts: { shell: 1 },
    order: 100,
    description: 'Top navigation bar, page host, theme and language controls.',
  },
  load: () => ({
    setup(ctx: PluginContext) {
      const mountRoot = document.getElementById('app') ?? document.body;
      mountRoot.innerHTML = '';
      mountRoot.className = 'workbench shell-root';

      const header = document.createElement('header');
      header.className = 'topbar';
      header.innerHTML = `
        <a class="brand" href="#/">
          <svg viewBox="0 0 28 24" aria-hidden="true"><path d="M1 17h5V5h7v12h7V5h7" /></svg>
          <span>HAKEI<span class="brand-sub">LOGIC ANALYZER</span></span>
        </a>
        <div id="shell-header-slots" class="shell-header-slots"></div>
        <nav id="shell-nav" class="top-nav" aria-label="Primary"></nav>
        <span class="local-badge"><i></i><span data-i18n="nav.local">本地浏览器处理</span></span>
        <div class="preferences">
          <label class="preference-control">
            <span class="sr-only" data-i18n="theme.label">主题</span>
            <select id="theme-mode" data-theme-select data-i18n-attrs="aria-label:theme.label">
              <option value="system" data-i18n="theme.system">跟随系统</option>
              <option value="light" data-i18n="theme.light">日间</option>
              <option value="dark" data-i18n="theme.dark">夜间</option>
            </select>
          </label>
          <label class="preference-control">
            <span class="sr-only" data-i18n="locale.label">语言</span>
            <select id="locale" data-locale-select data-i18n-attrs="aria-label:locale.label">
              <option value="zh-CN" lang="zh-CN">简体中文</option>
              <option value="en" lang="en">English</option>
            </select>
          </label>
        </div>
      `;

      const pagesHost = document.createElement('div');
      pagesHost.id = 'shell-pages';
      pagesHost.className = 'shell-pages';
      mountRoot.append(header, pagesHost);

      const headerSlots = header.querySelector<HTMLElement>('#shell-header-slots')!;
      const nav = header.querySelector<HTMLElement>('#shell-nav')!;
      bindPreferenceControls(header);
      translateDOM(header);

      const pages = new Map<string, MountedPage>();
      let currentRoute = parseHashRoute();
      let activeId: string | null = null;

      const sortedPages = (): MountedPage[] =>
        [...pages.values()].sort(
          (a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100) || a.spec.id.localeCompare(b.spec.id),
        );

      const syncNav = (): void => {
        nav.replaceChildren(...sortedPages().map((page) => page.navButton));
      };

      const activateRoute = (route: string): void => {
        currentRoute = route;
        const list = sortedPages();
        const target = list.find((page) => page.spec.route === route) ?? list[0] ?? null;
        const previous = activeId ? pages.get(activeId) : null;
        if (previous && previous !== target) previous.spec.onDeactivate?.();
        activeId = target?.spec.id ?? null;
        for (const page of list) {
          const isActive = page === target;
          page.container.hidden = !isActive;
          page.headerSlot.hidden = !isActive || !page.headerSlot.childElementCount;
          page.navButton.classList.toggle('nav-active', isActive);
          page.navButton.setAttribute('aria-current', isActive ? 'page' : 'false');
        }
        if (target && target !== previous) target.spec.onActivate?.();
      };

      const onHashChange = () => activateRoute(parseHashRoute());
      window.addEventListener('hashchange', onHashChange);

      const shell: ShellService = {
        get activeRoute() {
          return currentRoute;
        },
        navigate(route: string) {
          const normalized = route.replace(/^\/+/, '');
          const nextHash = normalized ? `#/${normalized}` : '#/';
          if (location.hash !== nextHash) location.hash = nextHash;
          activateRoute(normalized);
        },
        registerPage(spec: ShellPageSpec) {
          if (pages.has(spec.id)) throw new Error(`Duplicate shell page id: ${spec.id}`);
          const container = document.createElement('div');
          container.className = 'shell-page';
          container.dataset.pageId = spec.id;
          container.hidden = true;

          const headerSlot = document.createElement('div');
          headerSlot.className = 'shell-header-slot';
          headerSlot.dataset.pageId = spec.id;
          headerSlot.hidden = true;

          const navButton = document.createElement('button');
          navButton.type = 'button';
          navButton.className = 'nav-tab';
          navButton.dataset.pageRoute = spec.route;
          if (spec.labelKey && hasMessage(spec.labelKey)) {
            navButton.dataset.i18n = spec.labelKey;
            navButton.textContent = t(spec.labelKey);
          } else {
            navButton.textContent = spec.label;
          }
          navButton.addEventListener('click', () => shell.navigate(spec.route));

          headerSlots.append(headerSlot);
          pagesHost.append(container);

          let dispose: (() => void) | undefined;
          try {
            const cleanup = spec.mount(container, headerSlot);
            if (typeof cleanup === 'function') dispose = cleanup;
          } catch (error) {
            headerSlot.remove();
            container.remove();
            throw error;
          }

          pages.set(spec.id, { spec, container, headerSlot, navButton, dispose });
          syncNav();
          activateRoute(currentRoute);

          return () => {
            const existing = pages.get(spec.id);
            if (!existing) return;
            pages.delete(spec.id);
            if (activeId === spec.id) existing.spec.onDeactivate?.();
            try {
              existing.dispose?.();
            } catch {}
            existing.navButton.remove();
            existing.headerSlot.remove();
            existing.container.remove();
            syncNav();
            if (activeId === spec.id) {
              activeId = null;
              activateRoute(currentRoute);
            }
          };
        },
      };

      ctx.onCleanup(() => {
        window.removeEventListener('hashchange', onHashChange);
        for (const page of [...pages.values()]) {
          try {
            page.dispose?.();
          } catch {}
        }
        pages.clear();
        mountRoot.innerHTML = '';
      });

      return { shell };
    },
  }),
};
