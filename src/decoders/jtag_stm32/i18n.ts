import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.jtag_stm32.name': 'JTAG / STM32 *',
    'decoder.jtag_stm32.description': 'ST STM32-specific JTAG protocol.',
    'decoder.jtag_stm32.row.0': 'Items',
    'decoder.jtag_stm32.row.1': 'Fields',
    'decoder.jtag_stm32.row.2': 'Commands',
    'decoder.jtag_stm32.row.3': 'Warnings',
    'decoder.jtag_stm32.annotation.0': 'Item',
    'decoder.jtag_stm32.annotation.1': 'Field',
    'decoder.jtag_stm32.annotation.2': 'Command',
    'decoder.jtag_stm32.annotation.3': 'Warning',
  },
  'zh-CN': {
    'decoder.jtag_stm32.name': 'JTAG / STM32 *',
    'decoder.jtag_stm32.description': 'ST STM32 专用 JTAG 协议。',
    'decoder.jtag_stm32.row.0': '项目',
    'decoder.jtag_stm32.row.1': '字段',
    'decoder.jtag_stm32.row.2': '命令',
    'decoder.jtag_stm32.row.3': '警告',
    'decoder.jtag_stm32.annotation.0': '项目',
    'decoder.jtag_stm32.annotation.1': '字段',
    'decoder.jtag_stm32.annotation.2': '命令',
    'decoder.jtag_stm32.annotation.3': '警告',
  },
} as const satisfies ComponentMessages;
