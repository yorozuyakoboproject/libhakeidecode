import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.x2444m.name': 'X2444M/P *',
    'decoder.x2444m.description': 'Xicor X2444M/P nonvolatile static RAM protocol.',
    'decoder.x2444m.row.default': 'Annotations',
    'decoder.x2444m.annotation.0': 'Write disable',
    'decoder.x2444m.annotation.1': 'Store RAM data in EEPROM',
    'decoder.x2444m.annotation.2': 'Enter sleep mode',
    'decoder.x2444m.annotation.3': 'Write data into RAM',
    'decoder.x2444m.annotation.4': 'Write enable',
    'decoder.x2444m.annotation.5': 'Recall EEPROM data into RAM',
    'decoder.x2444m.annotation.6': 'Data read from RAM',
  },
  'zh-CN': {
    'decoder.x2444m.name': 'X2444M/P 非易失 SRAM *',
    'decoder.x2444m.description': 'Xicor X2444M/P 非易失静态 RAM 协议。',
    'decoder.x2444m.row.default': '注解',
    'decoder.x2444m.annotation.0': '禁止写入',
    'decoder.x2444m.annotation.1': '将 RAM 数据存入 EEPROM',
    'decoder.x2444m.annotation.2': '进入睡眠模式',
    'decoder.x2444m.annotation.3': '向 RAM 写入数据',
    'decoder.x2444m.annotation.4': '允许写入',
    'decoder.x2444m.annotation.5': '将 EEPROM 数据召回 RAM',
    'decoder.x2444m.annotation.6': '从 RAM 读取数据',
  },
} as const satisfies ComponentMessages;
