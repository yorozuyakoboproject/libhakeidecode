import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ps2.name': 'PS/2 *',
    'decoder.ps2.description': 'PS/2 keyboard/mouse interface.',
    'decoder.ps2.channel.clk': 'Clock',
    'decoder.ps2.channel.data': 'Data',
    'decoder.ps2.row.0': 'Bits',
    'decoder.ps2.row.1': 'Fields',
    'decoder.ps2.annotation.0': 'Bit',
    'decoder.ps2.annotation.1': 'Start bit',
    'decoder.ps2.annotation.2': 'Stop bit',
    'decoder.ps2.annotation.3': 'Parity OK bit',
    'decoder.ps2.annotation.4': 'Parity error bit',
    'decoder.ps2.annotation.5': 'Data bit',
    'decoder.ps2.annotation.6': 'Word',
  },
  'zh-CN': {
    'decoder.ps2.name': 'PS/2 键盘鼠标 *',
    'decoder.ps2.description': 'PS/2 键盘和鼠标接口。',
    'decoder.ps2.channel.clk': '时钟',
    'decoder.ps2.channel.data': '数据',
    'decoder.ps2.row.0': '位',
    'decoder.ps2.row.1': '字段',
    'decoder.ps2.annotation.0': '位',
    'decoder.ps2.annotation.1': '起始位',
    'decoder.ps2.annotation.2': '停止位',
    'decoder.ps2.annotation.3': '校验正确位',
    'decoder.ps2.annotation.4': '校验错误位',
    'decoder.ps2.annotation.5': '数据位',
    'decoder.ps2.annotation.6': '字节',
  },
} as const satisfies ComponentMessages;
