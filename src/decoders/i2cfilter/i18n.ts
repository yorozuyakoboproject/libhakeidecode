import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.i2cfilter.name': 'I²C filter *',
    'decoder.i2cfilter.description': 'Filter out addresses/directions in an I²C stream.',
    'decoder.i2cfilter.option.address': 'Slave address to filter (decimal)',
    'decoder.i2cfilter.option.direction': 'Direction to filter',
    'decoder.i2cfilter.value.read': 'Read',
    'decoder.i2cfilter.value.write': 'Write',
    'decoder.i2cfilter.value.both': 'Both',
    'decoder.i2cfilter.row.default': 'Annotations',
  },
  'zh-CN': {
    'decoder.i2cfilter.name': 'I²C filter *',
    'decoder.i2cfilter.description': '按地址和方向筛选 I²C 数据流。',
    'decoder.i2cfilter.option.address': '筛选的从机地址（十进制）',
    'decoder.i2cfilter.option.direction': '筛选方向',
    'decoder.i2cfilter.value.read': '读取',
    'decoder.i2cfilter.value.write': '写入',
    'decoder.i2cfilter.value.both': '双向',
    'decoder.i2cfilter.row.default': '注释',
  },
} as const satisfies ComponentMessages;
