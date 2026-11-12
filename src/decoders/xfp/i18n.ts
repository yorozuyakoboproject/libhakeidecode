import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.xfp.name': 'XFP *',
    'decoder.xfp.description': 'XFP I²C management interface structures/protocol',
    'decoder.xfp.row.0': 'Field names and values',
    'decoder.xfp.row.1': 'Field values',
    'decoder.xfp.annotation.0': 'Field name and value',
    'decoder.xfp.annotation.1': 'Field value',
  },
  'zh-CN': {
    'decoder.xfp.name': 'XFP *',
    'decoder.xfp.description': 'XFP I²C 管理接口结构/协议',
    'decoder.xfp.row.0': '字段名和值',
    'decoder.xfp.row.1': '字段值',
    'decoder.xfp.annotation.0': '字段名和值',
    'decoder.xfp.annotation.1': '字段值',
  },
} as const satisfies ComponentMessages;
