import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.cfp.name': 'CFP *',
    'decoder.cfp.description': '100 Gigabit C form-factor pluggable (CFP) protocol.',
    'decoder.cfp.row.0': 'Registers',
    'decoder.cfp.row.1': 'Decodes',
    'decoder.cfp.annotation.0': 'Register',
    'decoder.cfp.annotation.1': 'Decode',
  },
  'zh-CN': {
    'decoder.cfp.name': 'CFP 光模块管理协议 *',
    'decoder.cfp.description': '100 Gbit/s C 型可插拔光模块管理协议。',
    'decoder.cfp.row.0': '寄存器',
    'decoder.cfp.row.1': '解析结果',
    'decoder.cfp.annotation.0': '寄存器',
    'decoder.cfp.annotation.1': '解析结果',
  },
} as const satisfies ComponentMessages;
