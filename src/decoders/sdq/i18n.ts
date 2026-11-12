import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.sdq.name': 'SDQ *',
    'decoder.sdq.description': 'Texas Instruments SDQ. The SDQ protocol is also used by Apple.',
    'decoder.sdq.channel.sdq': 'SDQ',
    'decoder.sdq.option.bitrate': 'Bit rate',
    'decoder.sdq.row.0': 'Bits',
    'decoder.sdq.row.1': 'Bytes',
    'decoder.sdq.row.2': 'Breaks',
    'decoder.sdq.annotation.0': 'Bit',
    'decoder.sdq.annotation.1': 'Byte',
    'decoder.sdq.annotation.2': 'Break',
  },
  'zh-CN': {
    'decoder.sdq.name': 'SDQ *',
    'decoder.sdq.description': '德州仪器 SDQ 协议，苹果设备也使用该协议。',
    'decoder.sdq.channel.sdq': 'SDQ 数据线',
    'decoder.sdq.option.bitrate': '比特率',
    'decoder.sdq.row.0': '位',
    'decoder.sdq.row.1': '字节',
    'decoder.sdq.row.2': '间隔',
    'decoder.sdq.annotation.0': '位',
    'decoder.sdq.annotation.1': '字节',
    'decoder.sdq.annotation.2': '间隔',
  },
} as const satisfies ComponentMessages;
