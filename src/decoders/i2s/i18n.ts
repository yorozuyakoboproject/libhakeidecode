import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.i2s.name': 'I²S *',
    'decoder.i2s.description': 'Serial bus for connecting digital audio devices.',
    'decoder.i2s.channel.sck': 'SCK',
    'decoder.i2s.channel.ws': 'WS',
    'decoder.i2s.channel.sd': 'SD',
    'decoder.i2s.row.default': 'Annotations',
    'decoder.i2s.annotation.0': 'Left channel',
    'decoder.i2s.annotation.1': 'Right channel',
    'decoder.i2s.annotation.2': 'Warnings',
    'decoder.i2s.binary.0': 'WAV file',
  },
  'zh-CN': {
    'decoder.i2s.name': 'I²S 音频总线 *',
    'decoder.i2s.description': '连接数字音频设备的串行总线。',
    'decoder.i2s.channel.sck': '位时钟',
    'decoder.i2s.channel.ws': '声道选择',
    'decoder.i2s.channel.sd': '串行数据',
    'decoder.i2s.row.default': '注解',
    'decoder.i2s.annotation.0': '左声道',
    'decoder.i2s.annotation.1': '右声道',
    'decoder.i2s.annotation.2': '警告',
    'decoder.i2s.binary.0': 'WAV 音频文件',
  },
} as const satisfies ComponentMessages;
