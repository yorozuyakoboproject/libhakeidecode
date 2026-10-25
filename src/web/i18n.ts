import { decoderDefinitions } from '../decoders/index.js';
import { driverDefinitions } from '../drivers/index.js';
import { ComponentError, type ComponentLocale } from '../components.js';
import type { DecoderMessageKey } from '../generated/decoders.js';
import type { DriverMessageKey } from '../generated/drivers.js';

export const en = {
  'device.connect': 'Connect USB',
  'device.disconnect': 'Disconnect',
  'device.connecting': 'Connecting…',
  'device.configuring': 'Updating device settings…',
  'device.connected': 'Connected',
  'device.disconnected': 'Connect the device before capture',
  'device.select': 'Capture device',
  'device.settings': 'Device settings',
  'device.run': '▶ Run capture',
  'device.stop': '■ Stop capture',
  'device.stopping': 'Stopping capture…',
  'device.stopped': 'Capture stopped',
  'device.acquiring': 'Acquiring samples…',
  'device.captureError': 'Capture failed',
  'capture.durationPreview': 'Estimated duration {duration}',
  'capture.memoryUsage': 'Allocated {used} MiB · {samples} samples · {progress}%',
  'capture.progress': 'Acquiring {samples} / {target} · actual data and buffers {memory} MiB',
  'capture.partial': 'Kept {actual} / {target} samples · {reason}',
  'capture.reason.stopped': 'stopped by user',
  'capture.reason.budget': 'explicit allocation limit reached; capture stopped',
  'capture.reason.allocation-failed': 'sample allocation failed',
  'capture.reason.store-limit': 'storage index limit reached',
  'capture.reason.error': 'source acquisition error',
  'capture.reason.errorDetail': 'source acquisition error: {error}',
  'capture.reason.complete': 'complete',
  'capture.empty': 'No capture yet',
  'capture.sampleLimit': 'Sample count',
  'capture.importSettings': 'Binary import settings',
  'decoder.add': '＋ Add protocol',
  'decoder.instances': 'Protocol instances',
  'decoder.empty': 'Add a protocol to show decoded annotations',
  'decoder.name': 'Name',
  'decoder.settings': 'Protocol settings',
  'decoder.color': 'Color',
  'decoder.remove': 'Remove protocol',
  'decoder.frames': 'frames',
  'decoder.decimals': 'Decimal places',
  'wave.cursor': 'Cursor',
  'wave.start': 'Start',
  'wave.end': 'End',
  'wave.delta': 'Δt',
  'wave.frequency': 'Frequency',
  'error.sr': 'Invalid or unsupported .sr session: {detail}',
  'error.srLimit': '.sr sessions are limited to 256 MiB of combined digital and analog sample data',
  'message.protocolLimit': 'At most 100 protocol instances can be added',
  'decoder.protocol': 'Protocol',

  'app.title': 'Hakei · Logic Analyzer',
  'nav.workbench': 'Workbench',
  'nav.local': 'Local browser processing',
  'theme.label': 'Appearance',
  'theme.light': 'Day',
  'theme.dark': 'Night',
  'theme.system': 'System',
  'locale.label': 'Language',
  'capture.section': 'Capture data',
  'capture.rate': 'Sample rate',
  'capture.rateAria': 'Binary sample rate',
  'capture.channels': 'Binary channels',
  'capture.open': '↥ Open file',
  'capture.hint': '.sr uses its own sample rate and channel names; BIN uses the binary import settings.',
  'capture.save': '↓ Save .sr',
  'channels.section': 'Channels',
  'channels.digitalSettings': 'Digital channel settings',
  'channels.name': 'Name',
  'channels.divHeight': 'Division height (px)',
  'channels.done': 'Done',
  'channels.invalid': 'Enter a name and a valid integer height.',
  'analog.settings': 'Analog channel settings',
  'analog.color': 'Color',
  'analog.positiveDivs': 'Positive divisions',
  'analog.negativeDivs': 'Negative divisions',
  'analog.resolution': 'Vertical resolution (V/div)',
  'analog.autorange': 'Autoranging',
  'analog.conversion': 'Conversion',
  'analog.thresholds': 'Conversion thresholds',
  'analog.traces': 'Show traces',
  'analog.none': 'None',
  'analog.threshold': 'To logic via threshold',
  'analog.schmitt': 'To logic via Schmitt trigger',
  'analog.average': 'Signal average',
  'analog.averageHysteresis': 'Signal average ± 15%',
  'analog.analog': 'Analog',
  'analog.converted': 'Converted',
  'analog.both': 'Analog + converted',
  'analog.invalid': 'Enter valid settings; at least one division is required.',
  'channels.capture': 'Capture {channel}',
  'channels.display': 'Show {channel}',
  'channels.none': 'Not connected',
  'decoder.section': 'Protocol decoding',
  'decoder.supported': 'Supported',
  'decoder.advanced': 'Advanced options',
  'footer.summary': 'Digital capture · Protocol decode · Offline files',
  'capture.workspace': 'CAPTURE WORKSPACE',
  'wave.overview': 'OVERVIEW',
  'capture.samples': 'Samples',
  'capture.duration': 'Duration',
  'wave.title': 'Digital waveforms',
  'wave.zoomOut': 'Zoom out',
  'wave.zoomIn': 'Zoom in',
  'wave.fit': 'Fit all',
  'wave.clearCursors': 'Clear cursor',
  'wave.aria':
    'Digital waveforms and protocol annotations; wheel to zoom, drag to pan, drag left labels to mix and reorder channels and protocols; click the cursor button before each range measurement',
  'wave.overviewAria': 'Capture overview; drag to pan the viewport',
  'wave.hint': 'Wheel to zoom · Drag anywhere to pan · Cursor button + drag measures a range',
  'wave.samples': 'samples',
  'wave.draw': 'Draw p95 {ms} ms',
  'results.binaryOutput': 'Binary output',
  'status.ready': 'Ready',
  'status.updated': 'Settings updated',
  'status.loading': 'Reading file',
  'status.importError': 'Import failed',
  'status.decoding': 'Decoding',
  'status.done': 'Decoded · {ms} ms · {throughput} MSa/s',
  'status.stopped': 'Decoding stopped',
  'status.cancelled': 'Task cancelled',
  'status.memory': 'Tracked data {memory} MiB · Load {ms} ms',
  'action.cancel': 'Cancel task',
  'message.decodeFirst': 'Decode before exporting binary data',
  'message.truncated':
    'The result limit was reached. Displayed results or binary exports are truncated; the original capture is still available.',
  'error.option': 'Invalid {option}',
  'error.rate': 'Sample rate must be a positive integer in Hz',
  'error.width': 'The UI supports 4, 8, 16 or 32 digital channels',
  'error.mapping': 'Channel mapping is out of range',
  'error.format': 'Expected a .hakei.json file in libhakei.capture/v1 or v2 format',
  'error.json': 'Invalid JSON capture file',
  'error.length': 'Sample count must be a positive exact integer; use BigInt or a decimal string for large counts',
  'error.channelCount': 'Channel count does not match the file declaration',
  'error.channel': 'Invalid level or edge array for D{channel}',
  'error.edges': 'D{channel} edges must be increasing integers within the capture',
  'error.trigger': 'Trigger is outside the capture',
  'error.gapsArray': 'gaps must be an array of missing intervals',
  'error.gaps': 'Invalid missing interval',
  'error.jsonLimit': 'JSON files are limited to 64 MiB; use compact binary data',
  'error.fileType': 'Supported files: .sr, .hakei.json, .bin, .raw and .dat',
  'error.binaryLength': 'Binary size must be a nonzero multiple of {stride} bytes',
  'error.binaryLimit': 'Binary imports are limited to 256 MiB',
  'error.noMapping': 'Map the required input channels',
  'error.worker': 'Could not start the decoder Worker',
  'error.cancelled': 'Decoding cancelled',
  'error.decoder': 'Decoder error: {detail}',
} as const;
export type MessageKey = keyof typeof en | DecoderMessageKey | DriverMessageKey;
export type Locale = ComponentLocale;
export type MessageValue = string | number | { key: MessageKey; params?: MessageParams };
export type MessageParams = Record<string, MessageValue>;
export const zh: Record<keyof typeof en, string> = {
  'device.connect': '连接 USB 设备',
  'device.disconnect': '断开连接',
  'device.connecting': '正在连接…',
  'device.configuring': '正在更新设备配置…',
  'device.connected': '已连接',
  'device.disconnected': '请先连接设备再开始采集',
  'device.select': '采集设备',
  'device.settings': '设备设置',
  'device.run': '▶ 开始采集',
  'device.stop': '■ 结束采集',
  'device.stopping': '正在结束采集…',
  'device.stopped': '采集已结束',
  'device.acquiring': '正在采集…',
  'device.captureError': '采集失败',
  'capture.durationPreview': '预计时长 {duration}',
  'capture.memoryUsage': '实际分配 {used} MiB · 有效数据 {samples} 点 · 进度 {progress}%',
  'capture.progress': '正在采集 {samples} / {target} · 实际内存 {memory} MiB',
  'capture.partial': '已保留 {actual} / {target} 点 · {reason}',
  'capture.reason.stopped': '用户结束采集',
  'capture.reason.budget': '达到调用方提供的分配限制，采集已停止',
  'capture.reason.allocation-failed': '采样内存分配失败',
  'capture.reason.store-limit': '达到存储索引上限',
  'capture.reason.error': '数据源采集错误',
  'capture.reason.errorDetail': '数据源采集错误：{error}',
  'capture.reason.complete': '完整采集',
  'capture.empty': '尚未采集',
  'capture.sampleLimit': '采样点数',
  'capture.importSettings': '二进制导入设置',
  'decoder.add': '＋ 添加协议',
  'decoder.instances': '协议实例',
  'decoder.empty': '添加协议以显示解码标注',
  'decoder.name': '名称',
  'decoder.settings': '协议设置',
  'decoder.color': '颜色',
  'decoder.remove': '删除协议',
  'decoder.frames': '帧',
  'decoder.decimals': '小数位数',
  'wave.cursor': '光标',
  'wave.start': '起始',
  'wave.end': '结束',
  'wave.delta': '间隔',
  'wave.frequency': '频率',
  'error.sr': '.sr 会话无效或不受支持：{detail}',
  'error.srLimit': '.sr 会话的数字与模拟采样数据合计上限为 256 MiB',
  'message.protocolLimit': '最多可添加 100 个协议实例',
  'decoder.protocol': '协议',

  'app.title': 'Hakei · 逻辑分析仪',
  'nav.workbench': '工作台',
  'nav.local': '本地浏览器处理',
  'theme.label': '主题',
  'theme.light': '日间',
  'theme.dark': '夜间',
  'theme.system': '跟随系统',
  'locale.label': '语言',
  'capture.section': '采样数据',
  'capture.rate': '采样率',
  'capture.rateAria': '二进制采样率',
  'capture.channels': '二进制通道数',
  'capture.open': '↥ 打开文件',
  'capture.hint': '.sr 自动读取采样率和通道名称；BIN 使用二进制导入设置。',
  'capture.save': '↓ 保存 .sr',
  'channels.section': '通道',
  'channels.digitalSettings': '数字通道配置',
  'channels.name': '名称',
  'channels.divHeight': '每格高度（像素）',
  'channels.done': '完成',
  'channels.invalid': '请输入名称和有效的整数高度。',
  'analog.settings': '模拟通道配置',
  'analog.color': '颜色',
  'analog.positiveDivs': '正向格数',
  'analog.negativeDivs': '负向格数',
  'analog.resolution': '垂直分辨率（V/div）',
  'analog.autorange': '自动量程',
  'analog.conversion': '转换方式',
  'analog.thresholds': '转换阈值',
  'analog.traces': '显示波形',
  'analog.none': '不转换',
  'analog.threshold': '阈值转数字',
  'analog.schmitt': '施密特触发转数字',
  'analog.average': '信号平均值',
  'analog.averageHysteresis': '信号平均值 ± 15%',
  'analog.analog': '模拟',
  'analog.converted': '转换后数字',
  'analog.both': '模拟 + 数字',
  'analog.invalid': '请输入有效设置，正负格数之和至少为一。',
  'channels.capture': '采集 {channel}',
  'channels.display': '显示 {channel}',
  'channels.none': '未连接',
  'decoder.section': '协议解码',
  'decoder.supported': '已支持',
  'decoder.advanced': '高级选项',
  'footer.summary': '数字采样 · 协议解码 · 离线文件',
  'capture.workspace': '采样工作台',
  'wave.overview': '采样概览',
  'capture.samples': '采样点',
  'capture.duration': '总时长',
  'wave.title': '数字波形',
  'wave.zoomOut': '缩小',
  'wave.zoomIn': '放大',
  'wave.fit': '全览',
  'wave.clearCursors': '清除光标',
  'wave.aria': '数字波形和协议标注；滚轮缩放，拖动平移，拖动左侧标签可交叉排列通道和协议；每次测量区间前点击光标按钮',
  'wave.overviewAria': '采样概览；拖动平移视口',
  'wave.hint': '滚轮缩放 · 任意位置拖动平移 · 点击光标后拖动测量区间',
  'wave.samples': '采样点',
  'wave.draw': '绘制 p95 {ms} ms',
  'results.binaryOutput': '二进制输出',
  'status.ready': '准备就绪',
  'status.updated': '参数已更新',
  'status.loading': '正在读取文件',
  'status.importError': '导入失败',
  'status.decoding': '正在解码',
  'status.done': '解码完成 · {ms} ms · {throughput} MSa/s',
  'status.stopped': '解码已停止',
  'status.cancelled': '任务已取消',
  'status.memory': '可追踪数据 {memory} MiB · 载入 {ms} ms',
  'action.cancel': '取消任务',
  'message.decodeFirst': '解码完成后可导出二进制数据',
  'message.truncated': '结果达到缓存上限，显示或二进制导出已截断；原始采样仍可查看。',
  'error.option': '无效的 {option}',
  'error.rate': '采样率必须是正整数 Hz',
  'error.width': '前端支持 4、8、16 或 32 个数字通道',
  'error.mapping': '通道映射超出范围',
  'error.format': '需要 libhakei.capture/v1 或 v2 格式的 .hakei.json 文件',
  'error.json': 'JSON 采样文件语法无效',
  'error.length': '采样点数须为正整数；超大点数请使用 BigInt 或十进制字符串',
  'error.channelCount': '通道数量与文件声明不符',
  'error.channel': 'D{channel} 的电平或边沿数组无效',
  'error.edges': 'D{channel} 边沿必须是递增且位于采样范围内的整数',
  'error.trigger': '触发位置超出采样范围',
  'error.gapsArray': 'gaps 必须是缺失区间数组',
  'error.gaps': '缺失区间无效',
  'error.jsonLimit': 'JSON 文件上限为 64 MiB，请使用紧凑的二进制文件',
  'error.fileType': '支持 .sr、.hakei.json、.bin、.raw 和 .dat 文件',
  'error.binaryLength': '二进制长度必须是 {stride} 字节的非零整数倍',
  'error.binaryLimit': '当前二进制导入上限为 256 MiB',
  'error.noMapping': '请映射所需的输入通道',
  'error.worker': '解码 Worker 启动失败',
  'error.cancelled': '解码已取消',
  'error.decoder': '解码器错误：{detail}',
};
export const messages = { en: { ...en }, 'zh-CN': { ...zh } } as Record<Locale, Record<MessageKey, string>>;
for (const component of [...decoderDefinitions, ...driverDefinitions]) {
  Object.assign(messages.en, component.messages.en);
  Object.assign(messages['zh-CN'], component.messages.en, component.messages['zh-CN']);
}
let locale: Locale = 'zh-CN';
export function getLocale(): Locale {
  return locale;
}
export function setLocale(value: Locale): void {
  locale = value;
}
export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'zh-CN' || saved === 'en') return saved;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}
export function hasMessage(key: string): key is MessageKey {
  return Object.hasOwn(messages.en, key);
}
export function t(key: MessageKey, params: MessageParams = {}): string {
  return (messages[locale][key] ?? messages.en[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match;
    const value = params[name];
    return typeof value === 'object' ? t(value.key, value.params) : String(value);
  });
}
export function numberLabel(value: number | bigint, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}
export class UIError extends Error {
  constructor(
    readonly key: MessageKey,
    readonly params: MessageParams = {},
  ) {
    super(t(key, params));
    this.name = 'UIError';
  }
}
export function errorLabel(error: unknown): string {
  if (error instanceof UIError) return t(error.key, error.params);
  if (error instanceof ComponentError && hasMessage(error.key)) return t(error.key, error.params);
  return t('error.decoder', { detail: error instanceof Error ? error.message : String(error) });
}
export function translateDOM(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n!;
    if (hasMessage(key)) node.textContent = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-attrs]')) {
    for (const pair of node.dataset.i18nAttrs!.split(';')) {
      const [attribute, key] = pair.split(':');
      if (attribute && key && hasMessage(key)) node.setAttribute(attribute, t(key));
    }
  }
}
