import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.wiegand.name': 'Wiegand *',
    'decoder.wiegand.description': 'Wiegand interface for electronic entry systems.',
    'decoder.wiegand.channel.d0': 'D0',
    'decoder.wiegand.channel.d1': 'D1',
    'decoder.wiegand.option.active': 'Data lines active level',
    'decoder.wiegand.value.low': 'Low',
    'decoder.wiegand.value.high': 'High',
    'decoder.wiegand.option.bitwidth_ms': 'Single bit width in milliseconds',
    'decoder.wiegand.row.0': 'Bits',
    'decoder.wiegand.row.1': 'Stream states',
    'decoder.wiegand.annotation.0': 'Bit',
    'decoder.wiegand.annotation.1': 'State',
  },
  'zh-CN': {
    'decoder.wiegand.name': '维根 *',
    'decoder.wiegand.description': '电子门禁系统使用的维根接口。',
    'decoder.wiegand.channel.d0': '数据 0',
    'decoder.wiegand.channel.d1': '数据 1',
    'decoder.wiegand.option.active': '数据线有效电平',
    'decoder.wiegand.value.low': '低电平',
    'decoder.wiegand.value.high': '高电平',
    'decoder.wiegand.option.bitwidth_ms': '单比特宽度（毫秒）',
    'decoder.wiegand.row.0': '位',
    'decoder.wiegand.row.1': '数据流状态',
    'decoder.wiegand.annotation.0': '位',
    'decoder.wiegand.annotation.1': '状态',
  },
} as const satisfies ComponentMessages;
