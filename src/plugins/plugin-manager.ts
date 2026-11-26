import type { BuiltinPluginDefinition, HostService, PluginContext, PluginInfo, PluginKind } from '../kernel/types.js';
import { hasMessage, t, translateDOM, type MessageKey } from '../web/i18n.js';
import {
  compareVersions,
  defaultRegistrySources,
  fetchRegistrySource,
  installMarketplacePlugin,
  loadRegistrySources,
  resolveLocalizedText,
  saveRegistrySources,
  validateRegistryUrl,
  type RegistryPluginEntry,
  type RegistrySource,
  type RegistryTier,
  type SourceFetchResult,
} from './marketplace.js';
import type { ShellService } from './shell.js';
import { DECODER_PLUGIN_TEMPLATE, DRIVER_PLUGIN_TEMPLATE } from './templates.js';

type ManagerTab = 'installed' | 'discover';
type FilterKind = 'all' | 'core' | 'decoder' | 'driver' | 'installed';
type MarketKindFilter = 'all' | PluginKind;
type MarketTierFilter = 'all' | RegistryTier;

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function localizedPluginName(plugin: PluginInfo): string {
  if (plugin.kind === 'decoder' && plugin.id.startsWith('decoder.')) {
    const key = `${plugin.id}.name`;
    if (hasMessage(key)) return t(key);
  }
  if (plugin.kind === 'driver' && plugin.id.startsWith('driver.')) {
    const key = `${plugin.id}.name`;
    if (hasMessage(key)) return t(key);
  }
  return plugin.name;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export const pluginManagerPlugin: BuiltinPluginDefinition = {
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'hakei.plugins-ui',
    name: 'Plugin Manager',
    version: '1.0.0',
    kind: 'ui',
    entry: 'plugin-manager.js',
    inject: ['shell', 'host'],
    optional: [],
    provides: [],
    contracts: { shell: 1, host: 1 },
    order: 210,
    description: 'Browse, discover, toggle, upload, and configure built-in and community plugins.',
  },
  load: () => ({
    setup(ctx: PluginContext) {
      const shell = ctx.services.shell as ShellService;
      const host = ctx.services.host as HostService;

      const unregister = shell.registerPage({
        id: 'plugins',
        route: 'plugins',
        labelKey: 'nav.plugins',
        label: 'Plugins',
        order: 20,
        mount(container) {
          let activeTab: ManagerTab = 'installed';
          let activeFilter: FilterKind = 'all';
          let searchQuery = '';
          let statusText = '';
          let statusIsError = false;
          let busy = false;

          let marketInitialized = false;
          let marketLoading = false;
          let marketSearch = '';
          let marketKind: MarketKindFilter = 'all';
          let marketTier: MarketTierFilter = 'all';
          let sources: RegistrySource[] = defaultRegistrySources();
          let sourceResults = new Map<string, SourceFetchResult>();
          let fetchController: AbortController | null = null;
          let disposed = false;

          container.innerHTML = `
            <div class="plugins-view">
              <div class="plugins-header">
                <div>
                  <h2 data-i18n="plugins.title">插件管理</h2>
                  <p class="hint" data-i18n="plugins.subtitle">管理内置模块，或上传自定义协议解码器与采集驱动插件。</p>
                </div>
                <div class="button-row">
                  <div class="plugins-tabs" role="tablist">
                    <button id="plugin-tab-installed" type="button" class="plugin-tab-btn active" role="tab" aria-selected="true"></button>
                    <button id="plugin-tab-discover" type="button" class="plugin-tab-btn" role="tab" aria-selected="false"></button>
                  </div>
                  <a class="button subtle" href="?pluginRecovery=1" data-i18n="plugins.recovery">恢复模式</a>
                  <button id="plugin-restore-defaults" type="button" class="button" data-i18n="plugins.restoreDefaults">恢复默认</button>
                </div>
              </div>

              <div id="plugin-status-message" class="message" role="status" hidden></div>

              <section id="plugin-installed-pane" class="plugins-pane">
                <section class="plugins-upload-card">
                  <div id="plugin-dropzone" class="plugin-dropzone" role="button" tabindex="0">
                    <input id="plugin-file-input" type="file" accept=".zip,.js,.mjs" hidden />
                    <strong data-i18n="plugins.upload">上传插件（.zip / .js）</strong>
                    <span data-i18n="plugins.uploadHint">将 .zip 插件包或单文件 .js/.mjs 解码器/驱动插件拖到此处，或点击选择</span>
                  </div>
                  <div class="plugin-upload-tools">
                    <form id="plugin-url-form" class="plugin-url-form">
                      <input id="plugin-url-input" type="url" data-i18n-attrs="placeholder:plugins.urlPlaceholder" placeholder="输入插件 URL（.zip / manifest.json / .js）" />
                      <button id="plugin-url-install" type="submit" class="button" data-i18n="plugins.installUrl">从 URL 安装</button>
                    </form>
                    <div class="plugin-templates">
                      <span data-i18n="plugins.templates">开发模板</span>
                      <button id="download-decoder-template" type="button" class="button compact" data-i18n="plugins.templateDecoder">下载解码器模板 (.js)</button>
                      <button id="download-driver-template" type="button" class="button compact" data-i18n="plugins.templateDriver">下载驱动模板 (.js)</button>
                    </div>
                  </div>
                </section>

                <div class="plugins-toolbar">
                  <input id="plugin-search" type="search" class="plugin-search" data-i18n-attrs="placeholder:plugins.search" placeholder="按名称、ID 或描述搜索插件…" />
                  <div id="plugin-filters" class="plugin-filters" role="tablist"></div>
                  <span id="plugin-count" class="hint plugin-count"></span>
                </div>

                <div id="plugin-cards" class="plugin-cards"></div>
                <p id="plugin-empty" class="hint" hidden data-i18n="plugins.empty">没有符合条件的插件。</p>

                <details class="plugin-services-section">
                  <summary data-i18n="plugins.services">服务提供者绑定</summary>
                  <div id="plugin-services-list" class="plugin-services-list"></div>
                </details>
              </section>

              <section id="plugin-discover-pane" class="plugins-pane" hidden>
                <details id="market-sources-panel" class="plugin-sources-panel">
                  <summary id="market-sources-summary"></summary>
                  <div class="plugin-sources-body">
                    <div id="market-sources-list" class="plugin-sources-list"></div>
                    <form id="market-source-form" class="plugin-source-form">
                      <input id="market-source-label" type="text" data-i18n-attrs="placeholder:plugins.market.sourceLabelPlaceholder" placeholder="源名称（可选）" />
                      <input id="market-source-url" type="url" data-i18n-attrs="placeholder:plugins.market.sourceUrlPlaceholder" placeholder="输入插件源 URL (https://.../registry.json)" />
                      <button type="submit" class="button compact primary" data-i18n="plugins.market.addSource">添加源</button>
                      <button id="market-reset-sources" type="button" class="button compact subtle" data-i18n="plugins.market.resetSources">恢复默认源</button>
                    </form>
                  </div>
                </details>

                <div class="plugins-toolbar">
                  <input id="market-search" type="search" class="plugin-search" data-i18n-attrs="placeholder:plugins.market.search" placeholder="按名称、ID、作者或标签搜索市场插件…" />
                  <div id="market-kind-filters" class="plugin-filters" role="tablist"></div>
                  <select id="market-tier-select" class="market-tier-select"></select>
                  <button id="market-refresh" type="button" class="button compact" data-i18n="plugins.market.refresh">刷新</button>
                  <span id="market-count" class="hint plugin-count"></span>
                </div>

                <p id="market-loading" class="hint" hidden data-i18n="plugins.market.loading">正在获取插件市场列表…</p>
                <div id="market-cards" class="plugin-cards"></div>
                <p id="market-empty" class="hint" hidden data-i18n="plugins.market.empty">没有符合条件的市场插件。</p>
              </section>
            </div>
          `;

          const tabInstalledBtn = container.querySelector<HTMLButtonElement>('#plugin-tab-installed')!;
          const tabDiscoverBtn = container.querySelector<HTMLButtonElement>('#plugin-tab-discover')!;
          const installedPane = container.querySelector<HTMLElement>('#plugin-installed-pane')!;
          const discoverPane = container.querySelector<HTMLElement>('#plugin-discover-pane')!;

          const dropzone = container.querySelector<HTMLElement>('#plugin-dropzone')!;
          const fileInput = container.querySelector<HTMLInputElement>('#plugin-file-input')!;
          const urlForm = container.querySelector<HTMLFormElement>('#plugin-url-form')!;
          const urlInput = container.querySelector<HTMLInputElement>('#plugin-url-input')!;
          const statusEl = container.querySelector<HTMLElement>('#plugin-status-message')!;
          const searchInput = container.querySelector<HTMLInputElement>('#plugin-search')!;
          const filtersEl = container.querySelector<HTMLElement>('#plugin-filters')!;
          const countEl = container.querySelector<HTMLElement>('#plugin-count')!;
          const cardsEl = container.querySelector<HTMLElement>('#plugin-cards')!;
          const emptyEl = container.querySelector<HTMLElement>('#plugin-empty')!;
          const servicesEl = container.querySelector<HTMLElement>('#plugin-services-list')!;
          const restoreBtn = container.querySelector<HTMLButtonElement>('#plugin-restore-defaults')!;

          const marketSourcesSummary = container.querySelector<HTMLElement>('#market-sources-summary')!;
          const marketSourcesList = container.querySelector<HTMLElement>('#market-sources-list')!;
          const marketSourceForm = container.querySelector<HTMLFormElement>('#market-source-form')!;
          const marketSourceLabel = container.querySelector<HTMLInputElement>('#market-source-label')!;
          const marketSourceUrl = container.querySelector<HTMLInputElement>('#market-source-url')!;
          const marketResetSourcesBtn = container.querySelector<HTMLButtonElement>('#market-reset-sources')!;
          const marketSearchInput = container.querySelector<HTMLInputElement>('#market-search')!;
          const marketKindFiltersEl = container.querySelector<HTMLElement>('#market-kind-filters')!;
          const marketTierSelect = container.querySelector<HTMLSelectElement>('#market-tier-select')!;
          const marketRefreshBtn = container.querySelector<HTMLButtonElement>('#market-refresh')!;
          const marketLoadingEl = container.querySelector<HTMLElement>('#market-loading')!;
          const marketCardsEl = container.querySelector<HTMLElement>('#market-cards')!;
          const marketEmptyEl = container.querySelector<HTMLElement>('#market-empty')!;
          const marketCountEl = container.querySelector<HTMLElement>('#market-count')!;

          const setStatus = (message: string, isError = false) => {
            statusText = message;
            statusIsError = isError;
            statusEl.textContent = message;
            statusEl.hidden = !message;
            statusEl.classList.toggle('error', isError);
          };

          const runAction = async (task: () => Promise<void>) => {
            if (busy) return;
            busy = true;
            render();
            try {
              await task();
            } catch (error) {
              setStatus(error instanceof Error ? error.message : String(error), true);
            } finally {
              busy = false;
              render();
            }
          };

          const collectMarketEntries = (): RegistryPluginEntry[] => {
            const seen = new Map<string, RegistryPluginEntry>();
            for (const source of sources) {
              if (!source.enabled) continue;
              const result = sourceResults.get(source.id);
              if (!result) continue;
              for (const entry of result.entries) {
                const existing = seen.get(entry.id);
                if (!existing || compareVersions(entry.version, existing.version) > 0) {
                  seen.set(entry.id, entry);
                }
              }
            }
            return [...seen.values()];
          };

          const refreshMarketplace = async () => {
            fetchController?.abort();
            fetchController = new AbortController();
            const signal = fetchController.signal;
            marketLoading = true;
            render();
            try {
              const enabledSources = sources.filter((source) => source.enabled);
              const results = await Promise.all(enabledSources.map((source) => fetchRegistrySource(source, signal)));
              if (disposed || signal.aborted) return;
              const nextMap = new Map<string, SourceFetchResult>();
              for (const result of results) {
                nextMap.set(result.source.id, result);
              }
              sourceResults = nextMap;
            } finally {
              if (!disposed && !signal.aborted) {
                marketLoading = false;
                render();
              }
            }
          };

          const ensureMarketLoaded = async () => {
            if (marketInitialized) return;
            marketInitialized = true;
            sources = await loadRegistrySources(ctx.data);
            if (!disposed) await refreshMarketplace();
          };

          const handleFiles = (files: FileList | null) => {
            const file = files?.[0];
            if (!file) return;
            void runAction(async () => {
              const installed = await host.installFile(file);
              setStatus(t('plugins.installedOk', { name: `${installed.name} (${installed.id})` }));
            });
          };

          tabInstalledBtn.addEventListener('click', () => {
            activeTab = 'installed';
            render();
          });
          tabDiscoverBtn.addEventListener('click', () => {
            activeTab = 'discover';
            render();
            void ensureMarketLoaded();
          });

          dropzone.addEventListener('click', () => {
            if (!busy) fileInput.click();
          });
          dropzone.addEventListener('keydown', (event) => {
            if ((event.key === 'Enter' || event.key === ' ') && !busy) {
              event.preventDefault();
              fileInput.click();
            }
          });
          dropzone.addEventListener('dragover', (event) => {
            event.preventDefault();
            dropzone.classList.add('dragover');
          });
          dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
          dropzone.addEventListener('drop', (event) => {
            event.preventDefault();
            dropzone.classList.remove('dragover');
            handleFiles(event.dataTransfer?.files ?? null);
          });
          fileInput.addEventListener('change', () => {
            handleFiles(fileInput.files);
            fileInput.value = '';
          });

          urlForm.addEventListener('submit', (event) => {
            event.preventDefault();
            const value = urlInput.value.trim();
            if (!value) return;
            void runAction(async () => {
              const installed = await host.installUrl(value);
              urlInput.value = '';
              setStatus(t('plugins.installedOk', { name: `${installed.name} (${installed.id})` }));
            });
          });

          container.querySelector('#download-decoder-template')!.addEventListener('click', () => {
            downloadText('pulse-counter-decoder.js', DECODER_PLUGIN_TEMPLATE);
          });
          container.querySelector('#download-driver-template')!.addEventListener('click', () => {
            downloadText('square-wave-driver.js', DRIVER_PLUGIN_TEMPLATE);
          });
          restoreBtn.addEventListener('click', () => {
            void runAction(async () => {
              await host.restoreDefaults();
              setStatus(t('plugins.restoredOk'));
            });
          });
          searchInput.addEventListener('input', () => {
            searchQuery = searchInput.value.trim().toLowerCase();
            render();
          });

          marketSearchInput.addEventListener('input', () => {
            marketSearch = marketSearchInput.value.trim().toLowerCase();
            render();
          });
          marketTierSelect.addEventListener('change', () => {
            marketTier = marketTierSelect.value as MarketTierFilter;
            render();
          });
          marketRefreshBtn.addEventListener('click', () => {
            void refreshMarketplace();
          });
          marketSourceForm.addEventListener('submit', (event) => {
            event.preventDefault();
            void runAction(async () => {
              const url = validateRegistryUrl(marketSourceUrl.value);
              if (sources.some((item) => item.url === url)) {
                throw new Error(t('plugins.market.duplicateSource'));
              }
              const rawLabel = marketSourceLabel.value.trim();
              const label = rawLabel || new URL(url).host;
              const next: RegistrySource = {
                id: `custom-${Date.now().toString(36)}`,
                label,
                url,
                enabled: true,
              };
              sources = [...sources, next];
              await saveRegistrySources(ctx.data, sources);
              marketSourceLabel.value = '';
              marketSourceUrl.value = '';
              setStatus('');
              await refreshMarketplace();
            });
          });
          marketResetSourcesBtn.addEventListener('click', () => {
            void runAction(async () => {
              sources = defaultRegistrySources();
              await saveRegistrySources(ctx.data, sources);
              setStatus('');
              await refreshMarketplace();
            });
          });

          const matchesFilter = (plugin: PluginInfo, filter: FilterKind): boolean => {
            if (filter === 'all') return true;
            if (filter === 'core') return plugin.kind === 'core' || plugin.kind === 'ui';
            if (filter === 'installed') return plugin.source !== 'builtin';
            return plugin.kind === filter;
          };

          const renderInstalled = (all: readonly PluginInfo[]) => {
            const filterSpecs: Array<{ id: FilterKind; key: MessageKey }> = [
              { id: 'all', key: 'plugins.filter.all' },
              { id: 'core', key: 'plugins.filter.core' },
              { id: 'driver', key: 'plugins.filter.driver' },
              { id: 'decoder', key: 'plugins.filter.decoder' },
              { id: 'installed', key: 'plugins.filter.installed' },
            ];
            filtersEl.replaceChildren();
            for (const item of filterSpecs) {
              const count = all.filter((plugin) => matchesFilter(plugin, item.id)).length;
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'plugin-filter-pill' + (activeFilter === item.id ? ' active' : '');
              btn.dataset.filter = item.id;
              btn.textContent = `${t(item.key)} (${count})`;
              btn.addEventListener('click', () => {
                activeFilter = item.id;
                render();
              });
              filtersEl.append(btn);
            }

            const tokens = searchQuery ? searchQuery.split(/\s+/).filter(Boolean) : [];
            const filtered = all.filter((plugin) => {
              if (!matchesFilter(plugin, activeFilter)) return false;
              if (!tokens.length) return true;
              const display = localizedPluginName(plugin);
              const hay =
                `${display} ${plugin.name} ${plugin.id} ${plugin.description} ${plugin.kind} ${plugin.source}`.toLowerCase();
              return tokens.every((token) => hay.includes(token));
            });

            countEl.textContent = t('plugins.count', { shown: filtered.length, total: all.length });
            emptyEl.hidden = filtered.length > 0;
            cardsEl.replaceChildren();

            for (const plugin of filtered) {
              const card = document.createElement('article');
              card.className = `plugin-card status-${plugin.status}`;
              card.dataset.pluginId = plugin.id;

              const main = document.createElement('div');
              main.className = 'plugin-card-main';
              const top = document.createElement('div');
              top.className = 'plugin-card-title';
              const name = document.createElement('strong');
              name.textContent = localizedPluginName(plugin);
              const idBadge = document.createElement('code');
              idBadge.textContent = plugin.id;
              const version = document.createElement('small');
              version.textContent = `v${plugin.version}`;
              top.append(name, idBadge, version);

              const badges = document.createElement('div');
              badges.className = 'plugin-badges';
              const kindBadge = document.createElement('span');
              kindBadge.className = `plugin-badge kind-${plugin.kind}`;
              kindBadge.textContent = t(`plugins.kind.${plugin.kind}` as MessageKey);
              const sourceBadge = document.createElement('span');
              sourceBadge.className = `plugin-badge source-${plugin.source}`;
              sourceBadge.textContent = t(`plugins.source.${plugin.source}` as MessageKey);
              const statusBadge = document.createElement('span');
              statusBadge.className = `plugin-badge status-${plugin.status}`;
              statusBadge.textContent = t(`plugins.status.${plugin.status}` as MessageKey);
              badges.append(kindBadge, sourceBadge, statusBadge);

              main.append(top, badges);
              if (plugin.description) {
                const desc = document.createElement('p');
                desc.className = 'plugin-card-desc';
                desc.textContent = plugin.description;
                main.append(desc);
              }
              if (plugin.error) {
                const err = document.createElement('p');
                err.className = 'plugin-card-error';
                err.textContent = plugin.error;
                main.append(err);
              }

              const actions = document.createElement('div');
              actions.className = 'plugin-card-actions';
              const toggle = document.createElement('button');
              toggle.type = 'button';
              toggle.className = plugin.enabled ? 'button compact' : 'button compact primary';
              toggle.disabled = busy;
              toggle.textContent = t(plugin.enabled ? 'plugins.disable' : 'plugins.enable');
              toggle.addEventListener('click', () => {
                void runAction(() => (plugin.enabled ? host.disable(plugin.id) : host.enable(plugin.id)));
              });
              actions.append(toggle);

              if (plugin.status === 'failed') {
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'button compact';
                retry.disabled = busy;
                retry.textContent = t('plugins.retry');
                retry.addEventListener('click', () => {
                  void runAction(() => host.retry(plugin.id));
                });
                actions.append(retry);
              }

              if (plugin.source !== 'builtin') {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'button compact subtle';
                remove.disabled = busy;
                remove.textContent = t(plugin.hasBuiltin ? 'plugins.restoreBuiltin' : 'plugins.uninstall');
                remove.addEventListener('click', () => {
                  void runAction(async () => {
                    await host.uninstall(plugin.id);
                    setStatus(t('plugins.uninstalledOk', { id: plugin.id }));
                  });
                });
                actions.append(remove);
              }

              card.append(main, actions);
              cardsEl.append(card);
            }

            servicesEl.replaceChildren();
            for (const binding of host.services()) {
              const row = document.createElement('div');
              row.className = 'plugin-service-row';
              const label = document.createElement('strong');
              label.textContent = binding.service;
              const select = document.createElement('select');
              select.disabled = busy || binding.providers.length <= 1;
              const auto = document.createElement('option');
              auto.value = '';
              auto.textContent = `Auto (${binding.activeProvider ?? '—'})`;
              select.append(auto);
              for (const provider of binding.providers) {
                const opt = document.createElement('option');
                opt.value = provider;
                opt.textContent = provider;
                select.append(opt);
              }
              select.value = binding.preferredProvider ?? '';
              select.addEventListener('change', () => {
                void runAction(() => host.selectProvider(binding.service, select.value || null));
              });
              row.append(label, select);
              servicesEl.append(row);
            }
          };

          const renderDiscover = (installedPlugins: readonly PluginInfo[]) => {
            const installedById = new Map(installedPlugins.map((item) => [item.id, item]));
            const enabledCount = sources.filter((item) => item.enabled).length;
            marketSourcesSummary.textContent = t('plugins.market.sources', {
              active: enabledCount,
              total: sources.length,
            });

            marketSourcesList.replaceChildren();
            for (const source of sources) {
              const row = document.createElement('div');
              row.className = 'plugin-source-row';
              const toggleLabel = document.createElement('label');
              toggleLabel.className = 'plugin-source-main';
              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.checked = source.enabled;
              checkbox.disabled = busy || marketLoading;
              checkbox.addEventListener('change', () => {
                void runAction(async () => {
                  sources = sources.map((item) =>
                    item.id === source.id ? { ...item, enabled: checkbox.checked } : item,
                  );
                  await saveRegistrySources(ctx.data, sources);
                  await refreshMarketplace();
                });
              });
              const textWrap = document.createElement('span');
              textWrap.className = 'plugin-source-text';
              const title = document.createElement('strong');
              title.textContent = source.builtin ? t('plugins.market.defaultSource') : source.label;
              const urlCode = document.createElement('code');
              urlCode.textContent = source.url;
              textWrap.append(title, urlCode);
              toggleLabel.append(checkbox, textWrap);

              const right = document.createElement('div');
              right.className = 'plugin-source-actions';
              const statusBadge = document.createElement('span');
              const result = sourceResults.get(source.id);
              if (!source.enabled) {
                statusBadge.className = 'plugin-badge';
                statusBadge.textContent = t('plugins.market.sourceDisabled');
              } else if (result?.error) {
                statusBadge.className = 'plugin-badge status-failed';
                statusBadge.textContent = t('plugins.market.sourceError', { error: result.error });
              } else {
                statusBadge.className = 'plugin-badge status-active';
                statusBadge.textContent = t('plugins.market.sourceCount', { count: result?.entries.length ?? 0 });
              }
              right.append(statusBadge);

              if (!source.builtin) {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'button compact subtle';
                removeBtn.disabled = busy;
                removeBtn.textContent = t('plugins.market.removeSource');
                removeBtn.addEventListener('click', () => {
                  void runAction(async () => {
                    sources = sources.filter((item) => item.id !== source.id);
                    await saveRegistrySources(ctx.data, sources);
                    await refreshMarketplace();
                  });
                });
                right.append(removeBtn);
              }
              row.append(toggleLabel, right);
              marketSourcesList.append(row);
            }

            const allEntries = collectMarketEntries();
            const kindSpecs: Array<{ id: MarketKindFilter; key: MessageKey }> = [
              { id: 'all', key: 'plugins.filter.all' },
              { id: 'driver', key: 'plugins.filter.driver' },
              { id: 'decoder', key: 'plugins.filter.decoder' },
              { id: 'ui', key: 'plugins.kind.ui' },
              { id: 'core', key: 'plugins.kind.core' },
            ];
            marketKindFiltersEl.replaceChildren();
            for (const spec of kindSpecs) {
              const count =
                spec.id === 'all' ? allEntries.length : allEntries.filter((entry) => entry.kind === spec.id).length;
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'plugin-filter-pill' + (marketKind === spec.id ? ' active' : '');
              btn.textContent = `${t(spec.key)} (${count})`;
              btn.addEventListener('click', () => {
                marketKind = spec.id;
                render();
              });
              marketKindFiltersEl.append(btn);
            }

            const tierSpecs: Array<{ id: MarketTierFilter; key: MessageKey }> = [
              { id: 'all', key: 'plugins.market.tier.all' },
              { id: 'official', key: 'plugins.market.tier.official' },
              { id: 'community', key: 'plugins.market.tier.community' },
              { id: 'custom', key: 'plugins.market.tier.custom' },
            ];
            marketTierSelect.replaceChildren();
            for (const spec of tierSpecs) {
              const opt = document.createElement('option');
              opt.value = spec.id;
              opt.textContent = t(spec.key);
              marketTierSelect.append(opt);
            }
            marketTierSelect.value = marketTier;

            const tokens = marketSearch ? marketSearch.split(/\s+/).filter(Boolean) : [];
            const filtered = allEntries.filter((entry) => {
              if (marketKind !== 'all' && entry.kind !== marketKind) return false;
              if (marketTier !== 'all' && entry.tier !== marketTier) return false;
              if (!tokens.length) return true;
              const title = resolveLocalizedText(entry.name);
              const summary = resolveLocalizedText(entry.summary);
              const hay =
                `${title} ${summary} ${entry.id} ${entry.slug} ${entry.author} ${entry.tags.join(' ')}`.toLowerCase();
              return tokens.every((token) => hay.includes(token));
            });

            marketRefreshBtn.disabled = busy || marketLoading;
            marketLoadingEl.hidden = !marketLoading;
            marketCountEl.textContent = t('plugins.count', { shown: filtered.length, total: allEntries.length });
            marketEmptyEl.hidden = marketLoading || filtered.length > 0;
            marketCardsEl.replaceChildren();

            for (const entry of filtered) {
              const installed = installedById.get(entry.id);
              const hasUpdate = !!installed && compareVersions(entry.version, installed.version) > 0;

              const card = document.createElement('article');
              card.className = 'plugin-card';
              card.dataset.marketPluginId = entry.id;

              const main = document.createElement('div');
              main.className = 'plugin-card-main';
              const top = document.createElement('div');
              top.className = 'plugin-card-title';
              const nameEl = document.createElement('strong');
              nameEl.textContent = resolveLocalizedText(entry.name, undefined, entry.id);
              const idBadge = document.createElement('code');
              idBadge.textContent = entry.id;
              const versionEl = document.createElement('small');
              versionEl.textContent = `v${entry.version}`;
              top.append(nameEl, idBadge, versionEl);

              const badges = document.createElement('div');
              badges.className = 'plugin-badges';
              const tierBadge = document.createElement('span');
              tierBadge.className = `plugin-badge tier-${entry.tier}`;
              tierBadge.textContent = t(`plugins.market.tier.${entry.tier}` as MessageKey);
              const kindBadge = document.createElement('span');
              kindBadge.className = `plugin-badge kind-${entry.kind}`;
              kindBadge.textContent = t(`plugins.kind.${entry.kind}` as MessageKey);
              badges.append(tierBadge, kindBadge);

              if (entry.sha256) {
                const verifiedBadge = document.createElement('span');
                verifiedBadge.className = 'plugin-badge status-active';
                verifiedBadge.textContent = t('plugins.market.verified');
                badges.append(verifiedBadge);
              }
              if (installed) {
                const stateBadge = document.createElement('span');
                stateBadge.className = `plugin-badge ${installed.hasBuiltin && installed.source === 'builtin' ? 'source-override' : 'status-active'}`;
                stateBadge.textContent = t(
                  installed.hasBuiltin && installed.source === 'builtin'
                    ? 'plugins.market.override'
                    : 'plugins.market.installed',
                );
                badges.append(stateBadge);
              }

              main.append(top, badges);
              const descText = resolveLocalizedText(entry.summary);
              if (descText) {
                const desc = document.createElement('p');
                desc.className = 'plugin-card-desc';
                desc.textContent = descText;
                main.append(desc);
              }

              const metaParts = [
                entry.author,
                entry.license,
                entry.size ? formatByteSize(entry.size) : undefined,
                ...entry.tags.map((tag) => `#${tag}`),
              ].filter(Boolean);
              if (metaParts.length || entry.homepage) {
                const metaRow = document.createElement('div');
                metaRow.className = 'plugin-market-meta';
                if (metaParts.length) {
                  const metaText = document.createElement('span');
                  metaText.textContent = metaParts.join(' · ');
                  metaRow.append(metaText);
                }
                if (entry.homepage) {
                  const link = document.createElement('a');
                  link.href = entry.homepage;
                  link.target = '_blank';
                  link.rel = 'noopener noreferrer';
                  link.textContent = t('plugins.market.homepage');
                  metaRow.append(link);
                }
                main.append(metaRow);
              }

              const actions = document.createElement('div');
              actions.className = 'plugin-card-actions';
              const installBtn = document.createElement('button');
              installBtn.type = 'button';
              if (!installed || (installed.hasBuiltin && installed.source === 'builtin')) {
                installBtn.className = 'button compact primary';
                installBtn.disabled = busy;
                installBtn.textContent = t('plugins.market.install');
              } else if (hasUpdate) {
                installBtn.className = 'button compact primary';
                installBtn.disabled = busy;
                installBtn.textContent = t('plugins.market.update', { version: `v${entry.version}` });
              } else {
                installBtn.className = 'button compact';
                installBtn.disabled = true;
                installBtn.textContent = t('plugins.market.installed');
              }
              installBtn.addEventListener('click', () => {
                void runAction(async () => {
                  const result = await installMarketplacePlugin(host, entry);
                  setStatus(t('plugins.installedOk', { name: `${result.name} (${result.id})` }));
                });
              });
              actions.append(installBtn);

              if (installed && installed.source !== 'builtin') {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'button compact subtle';
                removeBtn.disabled = busy;
                removeBtn.textContent = t(installed.hasBuiltin ? 'plugins.restoreBuiltin' : 'plugins.uninstall');
                removeBtn.addEventListener('click', () => {
                  void runAction(async () => {
                    await host.uninstall(installed.id);
                    setStatus(t('plugins.uninstalledOk', { id: installed.id }));
                  });
                });
                actions.append(removeBtn);
              }

              card.append(main, actions);
              marketCardsEl.append(card);
            }
          };

          const render = () => {
            const all = host.list();
            const marketEntries = collectMarketEntries();
            tabInstalledBtn.textContent = `${t('plugins.tab.installed')} (${all.length})`;
            tabDiscoverBtn.textContent = marketInitialized
              ? `${t('plugins.tab.discover')} (${marketEntries.length})`
              : t('plugins.tab.discover');

            const isInstalled = activeTab === 'installed';
            tabInstalledBtn.classList.toggle('active', isInstalled);
            tabInstalledBtn.setAttribute('aria-selected', isInstalled ? 'true' : 'false');
            tabDiscoverBtn.classList.toggle('active', !isInstalled);
            tabDiscoverBtn.setAttribute('aria-selected', !isInstalled ? 'true' : 'false');
            installedPane.hidden = !isInstalled;
            discoverPane.hidden = isInstalled;

            if (isInstalled) renderInstalled(all);
            else renderDiscover(all);

            statusEl.textContent = statusText;
            statusEl.hidden = !statusText;
            statusEl.classList.toggle('error', statusIsError);
            restoreBtn.disabled = busy;
            translateDOM(container);
          };

          const unsubHost = host.subscribe(render);
          const onLocale = () => render();
          window.addEventListener('hakei:localechange', onLocale);
          render();

          return () => {
            disposed = true;
            fetchController?.abort();
            unsubHost();
            window.removeEventListener('hakei:localechange', onLocale);
          };
        },
      });

      ctx.onCleanup(() => unregister());
    },
  }),
};
