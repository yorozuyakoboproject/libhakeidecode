import type { ComponentMessages } from '../../components.js';
import { TEXT_ORDERS, WIRE_ORDERS } from './orders.js';

const valueMessages = Object.fromEntries(
  [...new Set([...WIRE_ORDERS, ...TEXT_ORDERS])].map((value) => ['decoder.ws2812.value.' + value, value]),
);

export const messages = {
  en: {
    'decoder.ws2812.description': 'Pulse-width encoded addressable LED stream',
    'decoder.ws2812.din': 'Data channel',
    'decoder.ws2812.option.wireorder': 'Wire color order',
    'decoder.ws2812.option.textorder': 'Display color order',
    'decoder.ws2812.annotation.pixel': 'Pixel',
    'decoder.ws2812.annotation.warning': 'Warning',
    'decoder.ws2812.annotation.incomplete': 'Incomplete pixel ({bits} bits)',
    'decoder.ws2812.name': 'WS2812',
    ...valueMessages,
  },
  'zh-CN': {
    'decoder.ws2812.description': '脉宽编码的可寻址 LED 数据流',
    'decoder.ws2812.din': '数据通道',
    'decoder.ws2812.option.wireorder': '线路颜色顺序',
    'decoder.ws2812.option.textorder': '显示颜色顺序',
    'decoder.ws2812.annotation.pixel': '像素',
    'decoder.ws2812.annotation.warning': '警告',
    'decoder.ws2812.annotation.incomplete': '不完整像素（{bits} 位）',
    'decoder.ws2812.name': 'WS2812',
    ...valueMessages,
  },
} as const satisfies ComponentMessages;
