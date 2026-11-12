import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ade77xx.name': 'ADE77xx *',
    'decoder.ade77xx.description': 'Poly phase multifunction energy metering IC protocol.',
    'decoder.ade77xx.row.0': 'Reads',
    'decoder.ade77xx.row.1': 'Writes',
    'decoder.ade77xx.row.2': 'Warnings',
    'decoder.ade77xx.annotation.0': 'Register read',
    'decoder.ade77xx.annotation.1': 'Register write',
    'decoder.ade77xx.annotation.2': 'Warning',
  },
  'zh-CN': {
    'decoder.ade77xx.name': 'ADE77xx 电能计量芯片 *',
    'decoder.ade77xx.description': '多相多功能电能计量芯片协议。',
    'decoder.ade77xx.row.0': '读取',
    'decoder.ade77xx.row.1': '写入',
    'decoder.ade77xx.row.2': '警告',
    'decoder.ade77xx.annotation.0': '寄存器读取',
    'decoder.ade77xx.annotation.1': '寄存器写入',
    'decoder.ade77xx.annotation.2': '警告',
  },
} as const satisfies ComponentMessages;
