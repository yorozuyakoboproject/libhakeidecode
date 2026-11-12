import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ds243x.name': 'DS243x *',
    'decoder.ds243x.description': 'Maxim DS243x series 1-Wire EEPROM protocol.',
    'decoder.ds243x.row.default': 'Annotations',
    'decoder.ds243x.annotation.0': 'Text',
    'decoder.ds243x.binary.0': 'Data read from memory',
  },
  'zh-CN': {
    'decoder.ds243x.name': 'DS243x *',
    'decoder.ds243x.description': 'Maxim DS243x 系列 1-Wire EEPROM 协议。',
    'decoder.ds243x.row.default': '注解',
    'decoder.ds243x.annotation.0': '文本',
    'decoder.ds243x.binary.0': '从存储器读取的数据',
  },
} as const satisfies ComponentMessages;
