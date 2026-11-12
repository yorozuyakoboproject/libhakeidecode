import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ad79x0.name': 'AD79x0 *',
    'decoder.ad79x0.description': 'Analog Devices AD7910/AD7920 12-bit ADC.',
    'decoder.ad79x0.option.vref': 'Reference voltage (V)',
    'decoder.ad79x0.row.0': 'Modes',
    'decoder.ad79x0.row.1': 'Voltages',
    'decoder.ad79x0.row.2': 'Data validation',
    'decoder.ad79x0.annotation.0': 'Mode',
    'decoder.ad79x0.annotation.1': 'Voltage',
    'decoder.ad79x0.annotation.2': 'Validation',
  },
  'zh-CN': {
    'decoder.ad79x0.name': 'AD79x0 模数转换器 *',
    'decoder.ad79x0.description': '亚德诺 AD7910/AD7920 12 位模数转换器。',
    'decoder.ad79x0.option.vref': '参考电压 (V)',
    'decoder.ad79x0.row.0': '模式',
    'decoder.ad79x0.row.1': '电压',
    'decoder.ad79x0.row.2': '数据校验',
    'decoder.ad79x0.annotation.0': '模式',
    'decoder.ad79x0.annotation.1': '电压',
    'decoder.ad79x0.annotation.2': '校验',
  },
} as const satisfies ComponentMessages;
