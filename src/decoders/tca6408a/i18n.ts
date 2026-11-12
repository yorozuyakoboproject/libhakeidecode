import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.tca6408a.name': 'TI TCA6408A *',
    'decoder.tca6408a.description': 'Texas Instruments TCA6408A 8-bit I²C I/O expander.',
    'decoder.tca6408a.row.0': 'Registers',
    'decoder.tca6408a.row.1': 'Warnings',
    'decoder.tca6408a.annotation.0': 'Register type',
    'decoder.tca6408a.annotation.1': 'Register value',
    'decoder.tca6408a.annotation.2': 'Warning',
  },
  'zh-CN': {
    'decoder.tca6408a.name': 'TI TCA6408A *',
    'decoder.tca6408a.description': '德州仪器 TCA6408A 8 位 I²C I/O 扩展器。',
    'decoder.tca6408a.row.0': '寄存器',
    'decoder.tca6408a.row.1': '警告',
    'decoder.tca6408a.annotation.0': '寄存器类型',
    'decoder.tca6408a.annotation.1': '寄存器值',
    'decoder.tca6408a.annotation.2': '警告',
  },
} as const satisfies ComponentMessages;
