import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.adxl345.name': 'ADXL345 *',
    'decoder.adxl345.description': 'Analog Devices ADXL345 3-axis accelerometer.',
    'decoder.adxl345.row.0': 'Registers',
    'decoder.adxl345.row.1': 'Data',
    'decoder.adxl345.annotation.0': 'Read',
    'decoder.adxl345.annotation.1': 'Write',
    'decoder.adxl345.annotation.2': 'Multiple bytes',
    'decoder.adxl345.annotation.3': 'Register address',
    'decoder.adxl345.annotation.4': 'Register data',
    'decoder.adxl345.annotation.5': 'Warning',
  },
  'zh-CN': {
    'decoder.adxl345.name': 'ADXL345 *',
    'decoder.adxl345.description': '亚德诺半导体 ADXL345 三轴加速度计。',
    'decoder.adxl345.row.0': '寄存器',
    'decoder.adxl345.row.1': '数据',
    'decoder.adxl345.annotation.0': '读取',
    'decoder.adxl345.annotation.1': '写入',
    'decoder.adxl345.annotation.2': '多字节',
    'decoder.adxl345.annotation.3': '寄存器地址',
    'decoder.adxl345.annotation.4': '寄存器数据',
    'decoder.adxl345.annotation.5': '警告',
  },
} as const satisfies ComponentMessages;
