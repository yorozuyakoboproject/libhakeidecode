import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ltc242x.name': 'LTC242x *',
    'decoder.ltc242x.description': 'Linear Technology LTC2421/LTC2422 1-/2-channel 20-bit ADC.',
    'decoder.ltc242x.option.vref': 'Reference voltage (V)',
    'decoder.ltc242x.row.0': 'CH0 voltages',
    'decoder.ltc242x.row.1': 'CH1 voltages',
    'decoder.ltc242x.annotation.0': 'CH0 voltage',
    'decoder.ltc242x.annotation.1': 'CH1 voltage',
  },
  'zh-CN': {
    'decoder.ltc242x.name': 'LTC242x *',
    'decoder.ltc242x.description': 'Linear Technology LTC2421/LTC2422 1/2 通道 20 位 ADC。',
    'decoder.ltc242x.option.vref': '参考电压 (V)',
    'decoder.ltc242x.row.0': 'CH0 电压',
    'decoder.ltc242x.row.1': 'CH1 电压',
    'decoder.ltc242x.annotation.0': 'CH0 电压',
    'decoder.ltc242x.annotation.1': 'CH1 电压',
  },
} as const satisfies ComponentMessages;
