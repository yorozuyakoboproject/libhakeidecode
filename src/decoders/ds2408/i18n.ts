import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ds2408.name': 'DS2408 *',
    'decoder.ds2408.description': '1-Wire 8-channel addressable switch.',
    'decoder.ds2408.row.default': 'Annotations',
    'decoder.ds2408.annotation.0': 'Text',
  },
  'zh-CN': {
    'decoder.ds2408.name': 'DS2408 *',
    'decoder.ds2408.description': '1-Wire 8 通道可寻址开关。',
    'decoder.ds2408.row.default': '注解',
    'decoder.ds2408.annotation.0': '文本',
  },
} as const satisfies ComponentMessages;
