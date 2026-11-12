import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.rfm12.name': 'RFM12 *',
    'decoder.rfm12.description': 'HopeRF RFM12 wireless transceiver control protocol.',
    'decoder.rfm12.row.0': 'Commands',
    'decoder.rfm12.row.1': 'Returns',
    'decoder.rfm12.row.2': 'Interpretations',
    'decoder.rfm12.annotation.0': 'Command',
    'decoder.rfm12.annotation.1': 'Command parameter',
    'decoder.rfm12.annotation.2': 'Disabled bit',
    'decoder.rfm12.annotation.3': 'Returned value',
    'decoder.rfm12.annotation.4': 'Disabled returned value',
    'decoder.rfm12.annotation.5': 'Interpretation',
  },
  'zh-CN': {
    'decoder.rfm12.name': 'RFM12 *',
    'decoder.rfm12.description': 'HopeRF RFM12 无线收发器控制协议。',
    'decoder.rfm12.row.0': '命令',
    'decoder.rfm12.row.1': '返回值',
    'decoder.rfm12.row.2': '解释',
    'decoder.rfm12.annotation.0': '命令',
    'decoder.rfm12.annotation.1': '命令参数',
    'decoder.rfm12.annotation.2': '禁用位',
    'decoder.rfm12.annotation.3': '返回值',
    'decoder.rfm12.annotation.4': '禁用的返回值',
    'decoder.rfm12.annotation.5': '解释',
  },
} as const satisfies ComponentMessages;
