import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'driver.ch32h417.name': 'CH32H417 Logic Analyzer',
    'driver.ch32h417.error.browser': 'WebUSB requires Google Chrome on HTTPS or localhost',
    'driver.ch32h417.error.identity': 'A uniquely identified H417 device is required',
    'driver.ch32h417.error.unavailable': 'No authorized H417 device is connected',
    'driver.ch32h417.error.ambiguous': 'Multiple authorized H417 devices found; select one explicitly',
    'driver.ch32h417.error.disconnected': 'Connect CH32H417 before capture',
    'driver.ch32h417.error.protocol':
      'H417 protocol mismatch: device v{actual}, analyzer requires v{expected}. Update the analyzer and firmware to matching versions.',
  },
  'zh-CN': {
    'driver.ch32h417.name': 'CH32H417 逻辑分析仪',
    'driver.ch32h417.error.browser': 'WebUSB 需要在 HTTPS 或 localhost 下使用谷歌浏览器',
    'driver.ch32h417.error.identity': '需要具有唯一序列号的 H417 设备',
    'driver.ch32h417.error.unavailable': '未找到已授权并连接的 H417 设备',
    'driver.ch32h417.error.ambiguous': '发现多个已授权 H417 设备，请明确选择一个',
    'driver.ch32h417.error.disconnected': '请先连接 CH32H417 再开始采集',
    'driver.ch32h417.error.protocol': 'H417 协议版本不匹配：设备 v{actual}，分析仪要求 v{expected}。请更新到匹配版本。',
  },
} as const satisfies ComponentMessages;
