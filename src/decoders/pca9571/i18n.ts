import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.pca9571.name': 'PCA9571 *',
    'decoder.pca9571.description': 'NXP PCA9571 8-bit I²C output expander.',
    'decoder.pca9571.row.0': 'Registers',
    'decoder.pca9571.row.1': 'Warnings',
    'decoder.pca9571.annotation.0': 'Register type',
    'decoder.pca9571.annotation.1': 'Register value',
    'decoder.pca9571.annotation.2': 'Warning',
  },
  'zh-CN': {
    'decoder.pca9571.name': 'PCA9571 *',
    'decoder.pca9571.description': 'NXP PCA9571 8 位 I²C 输出扩展器。',
    'decoder.pca9571.row.0': '寄存器',
    'decoder.pca9571.row.1': '警告',
    'decoder.pca9571.annotation.0': '寄存器类型',
    'decoder.pca9571.annotation.1': '寄存器值',
    'decoder.pca9571.annotation.2': '警告',
  },
} as const satisfies ComponentMessages;
