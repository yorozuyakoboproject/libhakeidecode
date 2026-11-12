import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.rgb_led_spi.name': 'RGB LED (SPI) *',
    'decoder.rgb_led_spi.description': 'RGB LED string protocol (RGB values clocked over SPI).',
    'decoder.rgb_led_spi.row.default': 'Annotations',
    'decoder.rgb_led_spi.annotation.0': 'RGB value',
  },
  'zh-CN': {
    'decoder.rgb_led_spi.name': 'RGB LED (SPI) *',
    'decoder.rgb_led_spi.description': 'RGB LED 灯串协议（通过 SPI 时钟输入 RGB 值）。',
    'decoder.rgb_led_spi.row.default': '注解',
    'decoder.rgb_led_spi.annotation.0': 'RGB 值',
  },
} as const satisfies ComponentMessages;
