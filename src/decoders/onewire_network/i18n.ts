import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.onewire_network.name': '1-Wire network layer *',
    'decoder.onewire_network.description': 'Bidirectional, half-duplex, asynchronous serial bus.',
    'decoder.onewire_network.row.default': 'Annotations',
    'decoder.onewire_network.annotation.0': 'Text',
  },
  'zh-CN': {
    'decoder.onewire_network.name': '1-Wire 网络层 *',
    'decoder.onewire_network.description': '双向、半双工、异步串行总线。',
    'decoder.onewire_network.row.default': '注解',
    'decoder.onewire_network.annotation.0': '文本',
  },
} as const satisfies ComponentMessages;
