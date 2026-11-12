import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.mxc6225xu.name': 'MXC6225XU *',
    'decoder.mxc6225xu.description': 'Digital Thermal Orientation Sensor (DTOS) protocol.',
    'decoder.mxc6225xu.row.default': 'Annotations',
    'decoder.mxc6225xu.annotation.0': 'Text',
  },
  'zh-CN': {
    'decoder.mxc6225xu.name': 'MXC6225XU *',
    'decoder.mxc6225xu.description': '数字热感方向传感器（DTOS）协议。',
    'decoder.mxc6225xu.row.default': '标注',
    'decoder.mxc6225xu.annotation.0': '文本',
  },
} as const satisfies ComponentMessages;
