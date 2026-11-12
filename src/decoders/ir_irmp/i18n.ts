import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ir_irmp.name': 'IR IRMP *',
    'decoder.ir_irmp.description': 'IRMP infrared remote control multi protocol.',
    'decoder.ir_irmp.channel.ir': 'IR',
    'decoder.ir_irmp.option.polarity': 'Polarity',
    'decoder.ir_irmp.value.active-low': 'Active Low',
    'decoder.ir_irmp.value.active-high': 'Active High',
    'decoder.ir_irmp.row.0': 'IR Packets',
    'decoder.ir_irmp.annotation.0': 'Packet',
  },
  'zh-CN': {
    'decoder.ir_irmp.name': 'IR IRMP 红外协议 *',
    'decoder.ir_irmp.description': 'IRMP 红外遥控多协议解码器。',
    'decoder.ir_irmp.channel.ir': '红外信号',
    'decoder.ir_irmp.option.polarity': '有效电平',
    'decoder.ir_irmp.value.active-low': '低电平有效',
    'decoder.ir_irmp.value.active-high': '高电平有效',
    'decoder.ir_irmp.row.0': '红外数据包',
    'decoder.ir_irmp.annotation.0': '数据包',
  },
} as const satisfies ComponentMessages;
