import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.max72xx.name': 'MAX72xx *',
    'decoder.max72xx.description': 'Maxim MAX72xx series 8-digit LED display driver',
    'decoder.max72xx.option.numofdrivers': 'Number of daisy-chained chips',
    'decoder.max72xx.row.0': 'Chip number',
    'decoder.max72xx.row.1': 'Commands',
    'decoder.max72xx.row.2': 'Warnings',
    'decoder.max72xx.annotation.0': 'Index of chip in daisy chain',
    'decoder.max72xx.annotation.1': 'Registers written to the device',
    'decoder.max72xx.annotation.2': 'Digits displayed on the device',
    'decoder.max72xx.annotation.3': 'Human-readable warnings',
  },
  'zh-CN': {
    'decoder.max72xx.name': 'MAX72xx 显示驱动 *',
    'decoder.max72xx.description': 'Maxim MAX72xx 系列 8 位 LED 显示驱动器。',
    'decoder.max72xx.option.numofdrivers': '菊花链中的芯片数量',
    'decoder.max72xx.row.0': '芯片编号',
    'decoder.max72xx.row.1': '命令',
    'decoder.max72xx.row.2': '警告',
    'decoder.max72xx.annotation.0': '菊花链中的芯片索引',
    'decoder.max72xx.annotation.1': '写入设备的寄存器',
    'decoder.max72xx.annotation.2': '设备显示的位',
    'decoder.max72xx.annotation.3': '可读警告',
  },
} as const satisfies ComponentMessages;
