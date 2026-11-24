import type { BuiltinPluginDefinition, HostService, PluginContext, PluginInfo } from '../kernel/types.js';
import { hasMessage, t, translateDOM, type MessageKey } from '../web/i18n.js';
import type { ShellService } from './shell.js';
import { DECODER_PLUGIN_TEMPLATE, DRIVER_PLUGIN_TEMPLATE } from './templates.js';

type FilterKind = 'all' | 'core' | 'decoder' | 'driver' | 'installed';

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
    description: 'Browse, toggle, upload, and configure built-in and custom plugins.',
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
          let activeFilter: FilterKind = 'all';
          let searchQuery = '';
          let statusText = '';
          let statusIsError = false;
          let busy = false;

          container.innerHTML = `
            <div class="plugins-view">
              <div class="plugins-header">
                <div>
                  <h2 data-i18n="plugins.title">插件管理</h2>
                  <p class="hint" data-i18n="plugins.subtitle">管理内置模块，或上传自定义协议解码器与采集驱动插件。</p>
                </div>
                <div class="button-row">
                  <a class="button subtle" href="?pluginRecovery=1" data-i18n="plugins.recovery">恢复模式</a>
                  <button id="plugin-restore-defaults" type="button" class="button" data-i18n="plugins.restoreDefaults">恢复默认</button>
                </div>
              </div>

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
                <div id="plugin-status-message" class="message" role="status" hidden></div>
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
            </div>
          `;

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

          const handleFiles = (files: FileList | null) => {
            const file = files?.[0];
            if (!file) return;
            void runAction(async () => {
              const installed = await host.installFile(file);
              setStatus(t('plugins.installedOk', { name: `${installed.name} (${installed.id})` }));
            });
          };

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

          const matchesFilter = (plugin: PluginInfo, filter: FilterKind): boolean => {
            if (filter === 'all') return true;
            if (filter === 'core') return plugin.kind === 'core' || plugin.kind === 'ui';
            if (filter === 'installed') return plugin.source !== 'builtin';
            return plugin.kind === filter;
          };

          const render = () => {
            const all = host.list();
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
            unsubHost();
            window.removeEventListener('hakei:localechange', onLocale);
          };
        },
      });

      ctx.onCleanup(() => unregister());
    },
  }),
};
