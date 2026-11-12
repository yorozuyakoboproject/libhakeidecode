import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.adf435x.name': 'ADF435x *',
    'decoder.adf435x.description': 'Wideband synthesizer with integrated VCO.',
    'decoder.adf435x.row.0': 'Register writes',
    'decoder.adf435x.row.1': 'Warnings',
    'decoder.adf435x.annotation.0': 'Register write',
    'decoder.adf435x.annotation.1': 'Warnings',
  },
  'zh-CN': {
    'decoder.adf435x.name': 'ADF435x 频率合成器 *',
    'decoder.adf435x.description': '带集成压控振荡器的宽带频率合成器。',
    'decoder.adf435x.row.0': '寄存器写入',
    'decoder.adf435x.row.1': '警告',
    'decoder.adf435x.annotation.0': '寄存器写入',
    'decoder.adf435x.annotation.1': '警告',
  },
} as const satisfies ComponentMessages;
