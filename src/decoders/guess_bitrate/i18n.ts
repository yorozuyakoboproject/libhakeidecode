import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.guess_bitrate.name': 'Guess bitrate *',
    'decoder.guess_bitrate.description': 'Guess the bitrate/baudrate of a UART (or other) protocol.',
    'decoder.guess_bitrate.channel.data': 'Data',
    'decoder.guess_bitrate.row.default': 'Annotations',
    'decoder.guess_bitrate.annotation.0': 'Bitrate / baudrate',
  },
  'zh-CN': {
    'decoder.guess_bitrate.name': '猜测比特率 *',
    'decoder.guess_bitrate.description': '猜测 UART（或其他协议）的比特率/波特率。',
    'decoder.guess_bitrate.channel.data': '数据',
    'decoder.guess_bitrate.row.default': '注解',
    'decoder.guess_bitrate.annotation.0': '比特率 / 波特率',
  },
} as const satisfies ComponentMessages;
