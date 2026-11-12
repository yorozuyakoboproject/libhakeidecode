import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.lm75.name': 'LM75 *',
    'decoder.lm75.description': 'National LM75 (and compatibles) temperature sensor.',
    'decoder.lm75.option.sensor': 'Sensor type',
    'decoder.lm75.value.lm75': 'Lm75',
    'decoder.lm75.option.resolution': 'Resolution (bits)',
    'decoder.lm75.row.default': 'Annotations',
    'decoder.lm75.annotation.0': 'Temperature / °C',
    'decoder.lm75.annotation.1': 'Temperature / Kelvin',
    'decoder.lm75.annotation.2': 'Text (verbose)',
    'decoder.lm75.annotation.3': 'Text',
    'decoder.lm75.annotation.4': 'Warning',
  },
  'zh-CN': {
    'decoder.lm75.name': 'LM75 *',
    'decoder.lm75.description': 'National LM75 及兼容温度传感器。',
    'decoder.lm75.option.sensor': '传感器类型',
    'decoder.lm75.value.lm75': 'LM75',
    'decoder.lm75.option.resolution': '分辨率（位）',
    'decoder.lm75.row.default': '注释',
    'decoder.lm75.annotation.0': '温度 / °C',
    'decoder.lm75.annotation.1': '温度 / K',
    'decoder.lm75.annotation.2': '详细文本',
    'decoder.lm75.annotation.3': '文本',
    'decoder.lm75.annotation.4': '警告',
  },
} as const satisfies ComponentMessages;
