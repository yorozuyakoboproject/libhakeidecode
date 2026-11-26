import type { BuiltinPluginDefinition, PluginContext } from '../kernel/types.js';
import { setActiveApp } from '../web/active-app.js';
import { translateDOM } from '../web/i18n.js';
import { AnalyzerApp } from '../web/workbench-app.js';
import type { ComponentRegistryService } from './registry.js';
import type { ShellService } from './shell.js';

const HEADER_HTML = `
  <div id="capture-heading" class="capture-heading is-empty">
    <div>
      <div class="eyebrow" data-i18n="capture.workspace">采样工作台</div>
      <h1 id="capture-name" data-i18n="capture.empty">尚未采集</h1>
    </div>
    <div id="capture-metrics" class="capture-metrics" hidden>
      <span><b id="duration-label">—</b><span data-i18n="capture.duration">实际时长</span></span>
      <div id="capture-streams"></div>
      <span id="usb-transfer" hidden data-i18n-attrs="title:capture.usbRateHint"
        ><b id="usb-rate">—</b><span id="usb-rate-label" data-i18n="capture.usbRate">USB 实时速率</span></span
      >
    </div>
  </div>
`;

const WORKBENCH_HTML = `
  <div class="app-layout">
    <aside class="sidebar">
      <section class="side-section">
        <div class="section-title">
          <span data-i18n="capture.section">采样数据</span><span class="section-number">01</span>
        </div>
        <form id="device-form">
          <label class="field"
            ><span data-i18n="device.select">采集设备</span
            ><select id="device-select" data-i18n-attrs="aria-label:device.select"></select
          ></label>
          <label class="field"
            ><span data-i18n="capture.mode">采样模式</span
            ><select id="capture-mode" data-i18n-attrs="aria-label:capture.mode">
              <option value="single" selected data-i18n="capture.mode.single">单次采样</option>
              <option value="continuous" data-i18n="capture.mode.continuous">连续采样</option>
            </select></label
          >
          <div id="device-connection" hidden>
            <div class="button-row">
              <button id="connect-device" type="button" class="button" data-i18n="device.connect">Connect USB</button
              ><button id="disconnect-device" type="button" class="button subtle" data-i18n="device.disconnect">
                Disconnect
              </button>
            </div>
            <p id="device-connection-status" class="hint" role="status"></p>
          </div>
          <div id="device-sampling"></div>
          <div id="device-options"></div>
          <button id="run-capture" type="submit" class="button primary full" data-i18n="device.run">
            ▶ 开始采集
          </button>
        </form>
        <button id="open-file" class="button full" data-i18n="capture.open">↥ 打开文件</button>
        <input id="file-input" type="file" accept=".sr,.json,.bin,.raw,.dat" hidden />
        <button id="save-capture" class="button full" disabled data-i18n="capture.save">↓ 保存 .sr 文件</button>
        <div id="save-progress" hidden>
          <span data-i18n="capture.saving">正在保存 .sr</span> <output id="save-percent">0%</output>
          <progress id="save-fraction" max="1" value="0" data-i18n-attrs="aria-label:capture.saving"></progress>
        </div>
      </section>
      <section id="signal-section" class="side-section signal-section" hidden>
        <div class="section-title">
          <span data-i18n="signal.section">信号发生器</span><span id="signal-badge" class="section-number">0</span>
        </div>
        <div class="protocol-add">
          <select id="add-signal-type" data-i18n-attrs="aria-label:signal.type"></select
          ><button id="add-signal" class="button" data-i18n="signal.add">＋ 添加信号</button>
        </div>
        <div id="signal-list" class="protocol-list" data-i18n-attrs="aria-label:signal.instances"></div>
        <p id="signal-empty" class="hint" data-i18n="signal.empty">添加编码器或模拟信号</p>
        <div id="signal-editor" hidden>
          <div class="signal-identity">
            <label class="field"
              ><span data-i18n="signal.name">名称</span
              ><input id="signal-name" maxlength="80" data-i18n-attrs="aria-label:signal.name"
            /></label>
            <button
              id="remove-signal"
              class="icon-button"
              data-i18n-attrs="title:signal.remove;aria-label:signal.remove"
            >
              ×
            </button>
          </div>
          <div id="signal-encoder-fields">
            <label class="field"
              ><span data-i18n="signal.encoder">协议编码器</span
              ><select id="signal-decoder" data-i18n-attrs="aria-label:signal.encoder"></select
            ></label>
            <label class="field"
              ><span data-i18n="signal.case">边界用例</span
              ><select id="signal-case" data-i18n-attrs="aria-label:signal.case"></select
            ></label>
            <div id="signal-mapping" class="two-fields"></div>
            <div id="signal-options"></div>
          </div>
          <div id="signal-analog-fields">
            <label class="field"
              ><span data-i18n="signal.pattern">波形</span
              ><select id="signal-pattern" data-i18n-attrs="aria-label:signal.pattern"></select
            ></label>
            <label class="field"
              ><span data-i18n="signal.channel">模拟通道</span
              ><select id="signal-channel" data-i18n-attrs="aria-label:signal.channel"></select
            ></label>
            <div class="two-fields">
              <label class="field"
                ><span data-i18n="signal.frequency">频率 (Hz)</span
                ><input
                  id="signal-frequency"
                  type="number"
                  min="0.000001"
                  step="any"
                  data-i18n-attrs="aria-label:signal.frequency" /></label
              ><label class="field"
                ><span data-i18n="signal.amplitude">幅度 (V)</span
                ><input id="signal-amplitude" type="number" step="any" data-i18n-attrs="aria-label:signal.amplitude"
              /></label>
            </div>
            <div class="two-fields">
              <label class="field"
                ><span data-i18n="signal.offset">偏置 (V)</span
                ><input
                  id="signal-offset"
                  type="number"
                  step="any"
                  data-i18n-attrs="aria-label:signal.offset" /></label
              ><label class="field"
                ><span data-i18n="signal.seed">随机种子</span
                ><input id="signal-seed" type="number" step="1" data-i18n-attrs="aria-label:signal.seed"
              /></label>
            </div>
          </div>
          <p id="signal-error" class="hint signal-error" role="alert"></p>
        </div>
      </section>
      <section class="side-section">
        <div class="section-title">
          <span data-i18n="channels.section">数字通道</span><span id="channel-badge" class="section-number">0</span>
        </div>
        <div id="channel-list" class="channel-list"></div>
      </section>
      <section class="side-section decoder-section">
        <div class="section-title">
          <span data-i18n="decoder.section">协议解码</span><span class="section-number">02</span>
        </div>
        <div class="protocol-add">
          <select id="add-decoder-type" data-i18n-attrs="aria-label:decoder.protocol"></select
          ><button id="add-protocol" class="button" data-i18n="decoder.add">＋ 添加协议</button>
        </div>
        <div id="protocol-list" class="protocol-list" data-i18n-attrs="aria-label:decoder.instances"></div>
        <p id="protocol-empty" class="hint" data-i18n="decoder.empty">添加协议以显示解码标注</p>
        <div id="protocol-editor" hidden>
          <div class="protocol-identity">
            <label class="field"
              ><span data-i18n="decoder.name">名称</span
              ><input id="protocol-name" maxlength="80" data-i18n-attrs="aria-label:decoder.name" /></label
            ><label class="field"
              ><span data-i18n="decoder.color">颜色</span
              ><input
                id="protocol-color"
                type="color"
                value="#70d7a1"
                data-i18n-attrs="aria-label:decoder.color" /></label
            ><button
              id="remove-protocol"
              class="icon-button"
              data-i18n-attrs="title:decoder.remove;aria-label:decoder.remove"
            >
              ×
            </button>
          </div>
          <label class="field"
            ><span data-i18n="decoder.protocol">协议</span
            ><select id="decoder-type" data-i18n-attrs="aria-label:decoder.protocol"></select
          ></label>
          <p id="protocol-description" class="hint"></p>
          <div id="decoder-tracks" class="decoder-tracks" hidden></div>
          <form id="decoder-form">
            <div id="decoder-mapping" class="two-fields"></div>
            <div id="decoder-options"></div>
            <div id="decoder-display-options" hidden>
              <label class="field"
                ><span data-i18n="decoder.decimals">小数位数</span
                ><select id="decoder-decimals" data-i18n-attrs="aria-label:decoder.decimals">
                  <option>0</option>
                  <option>1</option>
                  <option>2</option>
                  <option selected>3</option>
                  <option>4</option>
                  <option>5</option>
                  <option>6</option>
                  <option>7</option>
                  <option>8</option>
                  <option>9</option>
                </select></label
              >
            </div>
            <details id="decoder-advanced" class="advanced">
              <summary data-i18n="decoder.advanced">高级选项</summary>
              <div id="advanced-options"></div>
            </details>
          </form>
          <div class="protocol-exports">
            <span id="frame-count">0</span><span data-i18n="decoder.frames">帧</span
            ><button id="export-csv" class="button compact">↓ CSV</button
            ><select id="binary-output" data-i18n-attrs="aria-label:results.binaryOutput"></select
            ><button id="export-binary" class="button compact">↓ BIN</button>
          </div>
          <div id="text-preview" class="protocol-preview"></div>
        </div>
      </section>
      <footer class="sidebar-footer">
        libhakeidecode <span>0.3.0</span><br /><span data-i18n="footer.summary">数字采样 · 协议解码 · 离线文件</span>
      </footer>
    </aside>
    <main>
      <div id="message" class="message" role="status" hidden></div>
      <section id="wave-panel" class="wave-panel">
        <div class="panel-toolbar">
          <span class="panel-title"><i class="green-dot"></i><span data-i18n="wave.title">数字波形</span></span>
          <div class="toolbar-controls">
            <button id="zoom-out" class="icon-button" data-i18n-attrs="title:wave.zoomOut;aria-label:wave.zoomOut">
              −</button
            ><button id="zoom-in" class="icon-button" data-i18n-attrs="title:wave.zoomIn;aria-label:wave.zoomIn">
              ＋</button
            ><button id="fit" class="button compact" data-i18n="wave.fit">全览</button><span class="divider"></span
            ><button id="cursor-toggle" class="button compact" aria-pressed="false" data-i18n="wave.cursor">
              光标</button
            ><button
              id="cursor-clear"
              class="icon-button"
              data-i18n-attrs="title:wave.clearCursors;aria-label:wave.clearCursors"
            >
              ×
            </button>
          </div>
        </div>
        <div class="wave-scroll">
          <canvas id="time-axis" aria-hidden="true"></canvas
          ><canvas id="waveform" data-i18n-attrs="aria-label:wave.aria"></canvas>
          <div id="wave-empty" class="wave-empty">
            <div class="wave-empty-card">
              <svg class="wave-empty-icon" viewBox="0 0 48 26" aria-hidden="true">
                <path d="M2 20h7V6h10v14h10V6h10v14h7" />
              </svg>
              <strong data-i18n="wave.emptyTitle">尚未采集波形数据</strong>
              <p class="hint" data-i18n="wave.emptyHint">点击开始采集，或将 .sr / .hakei.json 等采样文件拖放到此处打开</p>
              <div class="wave-empty-actions">
                <button id="empty-run-capture" type="button" class="button primary" data-i18n="device.run">
                  ▶ 开始采集
                </button>
                <button id="empty-open-file" type="button" class="button" data-i18n="capture.open">
                  ↥ 打开文件
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="overview-wrap">
          <canvas id="overview" data-i18n-attrs="aria-label:wave.overviewAria"></canvas>
        </div>
        <div class="wave-footer">
          <span id="view-range">—</span
          ><span id="cursor-measurement">滚轮缩放 · 任意位置拖动平移 · 点击光标后拖动测量区间</span>
        </div>
      </section>
      <footer class="statusbar">
        <span id="status-text">准备就绪</span
        ><span id="decode-state" class="sr-only" aria-live="polite">准备就绪</span><span id="memory-status">—</span
        ><span id="capture-memory-usage">—</span><span id="render-status">—</span
        ><button id="cancel" class="text-button" disabled data-i18n="action.cancel">取消任务</button>
      </footer>
    </main>
  </div>
`;

export interface WorkbenchService {
  readonly app: AnalyzerApp;
}

export const workbenchPlugin: BuiltinPluginDefinition = {
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'hakei.workbench',
    name: 'Capture Workbench',
    version: '1.0.0',
    kind: 'ui',
    entry: 'workbench.js',
    inject: ['shell', 'componentRegistry'],
    optional: [],
    provides: ['workbench'],
    contracts: { shell: 1, componentRegistry: 1, workbench: 1 },
    order: 200,
    description: 'Waveform viewer, device capture controls, signal generator, and protocol decoder workspace.',
  },
  load: () => ({
    setup(ctx: PluginContext) {
      const shell = ctx.services.shell as ShellService;
      const registry = ctx.services.componentRegistry as ComponentRegistryService;
      let instance!: AnalyzerApp;
      let unsubRegistry: (() => void) | null = null;

      const unregisterPage = shell.registerPage({
        id: 'workbench',
        route: '',
        labelKey: 'nav.workbench',
        label: 'Workbench',
        order: 10,
        mount(container, headerSlot) {
          headerSlot.innerHTML = HEADER_HTML;
          container.innerHTML = WORKBENCH_HTML;
          translateDOM(headerSlot);
          translateDOM(container);
          instance = new AnalyzerApp();
          setActiveApp(instance);
          unsubRegistry = registry.subscribe(() => {
            instance.refreshComponents(registry.drivers);
          });
          return () => {
            unsubRegistry?.();
            unsubRegistry = null;
            instance.dispose();
            setActiveApp(null);
          };
        },
        onActivate() {
          instance?.renderer.schedule();
        },
      });

      ctx.onCleanup(() => {
        unregisterPage();
      });

      const service: WorkbenchService = {
        get app() {
          return instance;
        },
      };
      return { workbench: service };
    },
  }),
};
