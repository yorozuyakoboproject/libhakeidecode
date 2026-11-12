import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ds28ea00.name': 'DS28EA00 *',
    'decoder.ds28ea00.description': '1-Wire digital thermometer with Sequence Detect and PIO.',
    'decoder.ds28ea00.row.default': 'Annotations',
    'decoder.ds28ea00.annotation.0': 'Text',
  },
  'zh-CN': {
    'decoder.ds28ea00.name': 'DS28EA00 *',
    'decoder.ds28ea00.description': '带序列检测和 PIO 的 1-Wire 数字温度计。',
    'decoder.ds28ea00.row.default': '注解',
    'decoder.ds28ea00.annotation.0': '文本',
  },
} as const satisfies ComponentMessages;
