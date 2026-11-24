import type { HostService } from './types.js';

export function hideStartup(): void {
  const el = document.getElementById('startup');
  if (el) el.remove();
}

export function showStartupError(title: string, detail: string): void {
  const root = document.getElementById('startup') ?? document.getElementById('app') ?? document.body;
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'recovery-shell';
  const heading = document.createElement('h1');
  heading.textContent = title;
  const message = document.createElement('p');
  message.className = 'recovery-error';
  message.textContent = detail;
  const link = document.createElement('a');
  link.className = 'button primary';
  link.href = '?pluginRecovery=1';
  link.textContent = 'Open Plugin Recovery';
  box.append(heading, message, link);
  root.append(box);
}

export function mountRecoveryUI(host: HostService, reason?: string): void {
  hideStartup();
  const root = document.getElementById('app') ?? document.body;
  const render = () => {
    root.innerHTML = '';
    const shell = document.createElement('div');
    shell.className = 'recovery-shell';

    const header = document.createElement('div');
    header.className = 'recovery-header';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h1');
    title.textContent = 'Hakei · Plugin Recovery';
    const sub = document.createElement('p');
    sub.className = 'hint';
    sub.textContent =
      reason ?? 'Independent recovery panel. Disable, uninstall, or restore built-in plugins if the UI fails to boot.';
    titleWrap.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'button-row';
    const exitBtn = document.createElement('a');
    exitBtn.className = 'button primary';
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('pluginRecovery');
    exitBtn.href = cleanUrl.href;
    exitBtn.textContent = 'Exit Recovery';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'button';
    resetBtn.textContent = 'Restore Defaults';
    resetBtn.addEventListener('click', () => {
      void host.restoreDefaults().then(() => render());
    });
    actions.append(exitBtn, resetBtn);
    header.append(titleWrap, actions);
    shell.append(header);

    const services = host.services();
    if (services.length) {
      const srvSection = document.createElement('section');
      srvSection.className = 'recovery-section';
      const h2 = document.createElement('h2');
      h2.textContent = 'Service Providers';
      srvSection.append(h2);
      for (const item of services) {
        const row = document.createElement('div');
        row.className = 'recovery-row';
        const label = document.createElement('strong');
        label.textContent = item.service;
        const select = document.createElement('select');
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = `Auto (${item.activeProvider ?? 'none'})`;
        select.append(auto);
        for (const provider of item.providers) {
          const opt = document.createElement('option');
          opt.value = provider;
          opt.textContent = provider;
          select.append(opt);
        }
        select.value = item.preferredProvider ?? '';
        select.addEventListener('change', () => {
          void host.selectProvider(item.service, select.value || null).then(() => render());
        });
        row.append(label, select);
        srvSection.append(row);
      }
      shell.append(srvSection);
    }

    const listSection = document.createElement('section');
    listSection.className = 'recovery-section';
    const h2 = document.createElement('h2');
    h2.textContent = 'Plugins';
    listSection.append(h2);
    const plugins = host
      .list()
      .filter(
        (plugin) =>
          plugin.source !== 'builtin' ||
          plugin.status === 'failed' ||
          !plugin.enabled ||
          plugin.kind === 'core' ||
          plugin.kind === 'ui',
      );
    for (const plugin of plugins) {
      const row = document.createElement('div');
      row.className = 'recovery-row';
      const info = document.createElement('div');
      info.className = 'recovery-info';
      const name = document.createElement('strong');
      name.textContent = `${plugin.name} (${plugin.id})`;
      const meta = document.createElement('small');
      meta.textContent = `${plugin.kind} · ${plugin.source} · ${plugin.status}${plugin.error ? ' · ' + plugin.error : ''}`;
      info.append(name, meta);

      const controls = document.createElement('div');
      controls.className = 'button-row';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'button compact';
      toggle.textContent = plugin.enabled ? 'Disable' : 'Enable';
      toggle.addEventListener('click', () => {
        void (plugin.enabled ? host.disable(plugin.id) : host.enable(plugin.id)).then(() => render());
      });
      controls.append(toggle);
      if (plugin.source !== 'builtin') {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'button compact subtle';
        remove.textContent = plugin.hasBuiltin ? 'Restore Built-in' : 'Uninstall';
        remove.addEventListener('click', () => {
          void host.uninstall(plugin.id).then(() => render());
        });
        controls.append(remove);
      }
      row.append(info, controls);
      listSection.append(row);
    }
    shell.append(listSection);
    root.append(shell);
  };
  render();
}
