import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.st7735.name': 'ST7735 *',
    'decoder.st7735.description': 'Sitronix ST7735 TFT controller protocol.',
    'decoder.st7735.channel.cs': 'CS#',
    'decoder.st7735.channel.clk': 'CLK',
    'decoder.st7735.channel.mosi': 'MOSI',
    'decoder.st7735.channel.dc': 'DC',
    'decoder.st7735.row.0': 'Bits',
    'decoder.st7735.row.1': 'Fields',
    'decoder.st7735.row.2': 'Descriptions',
    'decoder.st7735.annotation.0': 'Bit',
    'decoder.st7735.annotation.1': 'Command',
    'decoder.st7735.annotation.2': 'Data',
    'decoder.st7735.annotation.3': 'Description',
  },
  'zh-CN': {
    'decoder.st7735.name': 'ST7735 *',
    'decoder.st7735.description': 'Sitronix ST7735 TFT 控制器协议。',
    'decoder.st7735.channel.cs': '片选',
    'decoder.st7735.channel.clk': '时钟',
    'decoder.st7735.channel.mosi': '主输出从输入',
    'decoder.st7735.channel.dc': '数据/命令选择',
    'decoder.st7735.row.0': '位',
    'decoder.st7735.row.1': '字段',
    'decoder.st7735.row.2': '说明',
    'decoder.st7735.annotation.0': '位',
    'decoder.st7735.annotation.1': '命令',
    'decoder.st7735.annotation.2': '数据',
    'decoder.st7735.annotation.3': '说明',
  },
} as const satisfies ComponentMessages;
