import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.aud.name': 'AUD *',
    'decoder.aud.description': 'Renesas/Hitachi Advanced User Debugger (AUD) protocol.',
    'decoder.aud.channel.audck': 'AUDCK',
    'decoder.aud.channel.naudsync': 'nAUDSYNC',
    'decoder.aud.channel.audata3': 'AUDATA3',
    'decoder.aud.channel.audata2': 'AUDATA2',
    'decoder.aud.channel.audata1': 'AUDATA1',
    'decoder.aud.channel.audata0': 'AUDATA0',
    'decoder.aud.row.default': 'Annotations',
    'decoder.aud.annotation.0': 'Destination address',
  },
  'zh-CN': {
    'decoder.aud.name': '高级用户调试器（AUD） *',
    'decoder.aud.description': '瑞萨/日立高级用户调试器（AUD）协议。',
    'decoder.aud.channel.audck': 'AUD 时钟',
    'decoder.aud.channel.naudsync': 'AUD 同步（低有效）',
    'decoder.aud.channel.audata3': 'AUD 数据 3',
    'decoder.aud.channel.audata2': 'AUD 数据 2',
    'decoder.aud.channel.audata1': 'AUD 数据 1',
    'decoder.aud.channel.audata0': 'AUD 数据 0',
    'decoder.aud.row.default': '注解',
    'decoder.aud.annotation.0': '目标地址',
  },
} as const satisfies ComponentMessages;
