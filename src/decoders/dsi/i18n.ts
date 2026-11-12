import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.dsi.name': 'DSI *',
    'decoder.dsi.description': 'Digital Serial Interface (DSI) lighting protocol.',
    'decoder.dsi.channel.dsi': 'DSI',
    'decoder.dsi.option.polarity': 'Polarity',
    'decoder.dsi.value.active-low': 'Active Low',
    'decoder.dsi.value.active-high': 'Active High',
    'decoder.dsi.row.0': 'Bits',
    'decoder.dsi.row.1': 'Raw data',
    'decoder.dsi.row.2': 'Fields',
    'decoder.dsi.annotation.0': 'Bit',
    'decoder.dsi.annotation.1': 'Start bit',
    'decoder.dsi.annotation.2': 'Dimmer level',
    'decoder.dsi.annotation.3': 'Raw data',
  },
  'zh-CN': {
    'decoder.dsi.name': 'DSI *',
    'decoder.dsi.description': '数字串行接口 (DSI) 照明协议。',
    'decoder.dsi.channel.dsi': 'DSI 数据线',
    'decoder.dsi.option.polarity': '极性',
    'decoder.dsi.value.active-low': '低电平有效',
    'decoder.dsi.value.active-high': '高电平有效',
    'decoder.dsi.row.0': '位',
    'decoder.dsi.row.1': '原始数据',
    'decoder.dsi.row.2': '字段',
    'decoder.dsi.annotation.0': '位',
    'decoder.dsi.annotation.1': '起始位',
    'decoder.dsi.annotation.2': '调光等级',
    'decoder.dsi.annotation.3': '原始数据',
  },
} as const satisfies ComponentMessages;
