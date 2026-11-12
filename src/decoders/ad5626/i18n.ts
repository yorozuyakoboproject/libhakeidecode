import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ad5626.name': 'AD5626 *',
    'decoder.ad5626.description': 'Analog Devices AD5626 12-bit nanoDAC.',
    'decoder.ad5626.row.default': 'Annotations',
    'decoder.ad5626.annotation.0': 'Voltage',
  },
  'zh-CN': {
    'decoder.ad5626.name': 'AD5626 数模转换器 *',
    'decoder.ad5626.description': '亚德诺 AD5626 12 位数模转换器。',
    'decoder.ad5626.row.default': '注释',
    'decoder.ad5626.annotation.0': '电压',
  },
} as const satisfies ComponentMessages;
