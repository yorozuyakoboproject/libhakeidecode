import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.adns5020.name': 'ADNS-5020 *',
    'decoder.adns5020.description': 'Bidirectional optical mouse sensor protocol.',
    'decoder.adns5020.row.0': 'Reads',
    'decoder.adns5020.row.1': 'Writes',
    'decoder.adns5020.row.2': 'Warnings',
    'decoder.adns5020.annotation.0': 'Register read',
    'decoder.adns5020.annotation.1': 'Register write',
    'decoder.adns5020.annotation.2': 'Warning',
  },
  'zh-CN': {
    'decoder.adns5020.name': 'ADNS-5020 *',
    'decoder.adns5020.description': 'Avago ADNS-5020 双向光学鼠标传感器协议。',
    'decoder.adns5020.row.0': '读取',
    'decoder.adns5020.row.1': '写入',
    'decoder.adns5020.row.2': '警告',
    'decoder.adns5020.annotation.0': '寄存器读取',
    'decoder.adns5020.annotation.1': '寄存器写入',
    'decoder.adns5020.annotation.2': '警告',
  },
} as const satisfies ComponentMessages;
