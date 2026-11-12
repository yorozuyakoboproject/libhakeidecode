import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.i2cdemux.name': 'I²C demux *',
    'decoder.i2cdemux.description': 'Demux I²C packets into per-slave-address streams.',
    'decoder.i2cdemux.row.default': 'Annotations',
  },
  'zh-CN': {
    'decoder.i2cdemux.name': 'I²C demux *',
    'decoder.i2cdemux.description': '按从机地址将 I²C 数据包分流到不同数据流。',
    'decoder.i2cdemux.row.default': '注释',
  },
} as const satisfies ComponentMessages;
