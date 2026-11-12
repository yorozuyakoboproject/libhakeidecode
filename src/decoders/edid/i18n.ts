import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.edid.name': 'EDID *',
    'decoder.edid.description': 'Data structure describing display device capabilities.',
    'decoder.edid.row.0': 'Fields',
    'decoder.edid.row.1': 'Sections',
    'decoder.edid.annotation.0': 'Field',
    'decoder.edid.annotation.1': 'Section',
  },
  'zh-CN': {
    'decoder.edid.name': 'EDID *',
    'decoder.edid.description': '描述显示设备能力的数据结构。',
    'decoder.edid.row.0': '字段',
    'decoder.edid.row.1': '区段',
    'decoder.edid.annotation.0': '字段',
    'decoder.edid.annotation.1': '区段',
  },
} as const satisfies ComponentMessages;
