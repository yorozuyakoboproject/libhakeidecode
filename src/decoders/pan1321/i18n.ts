import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.pan1321.name': 'PAN1321 *',
    'decoder.pan1321.description': 'Bluetooth RF module with Serial Port Profile (SPP).',
    'decoder.pan1321.row.default': 'Annotations',
    'decoder.pan1321.annotation.0': 'Text (verbose)',
    'decoder.pan1321.annotation.1': 'Text',
    'decoder.pan1321.annotation.2': 'Warning',
  },
  'zh-CN': {
    'decoder.pan1321.name': 'PAN1321 *',
    'decoder.pan1321.description': '支持串行端口配置文件（SPP）的蓝牙射频模块。',
    'decoder.pan1321.row.default': '注解',
    'decoder.pan1321.annotation.0': '文本（详细）',
    'decoder.pan1321.annotation.1': '文本',
    'decoder.pan1321.annotation.2': '警告',
  },
} as const satisfies ComponentMessages;
