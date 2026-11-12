import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.ssi32.name': 'SSI32 *',
    'decoder.ssi32.description': 'Synchronous Serial Interface (32bit) protocol.',
    'decoder.ssi32.option.msgsize': 'Message size',
    'decoder.ssi32.row.0': 'TX',
    'decoder.ssi32.row.1': 'RX',
    'decoder.ssi32.annotation.0': 'CTRL TX',
    'decoder.ssi32.annotation.1': 'ACK TX',
    'decoder.ssi32.annotation.2': 'CTRL RX',
    'decoder.ssi32.annotation.3': 'ACK RX',
  },
  'zh-CN': {
    'decoder.ssi32.name': '同步串行接口（32 位） *',
    'decoder.ssi32.description': '同步串行接口（32 位）协议。',
    'decoder.ssi32.option.msgsize': '消息大小',
    'decoder.ssi32.row.0': '发送',
    'decoder.ssi32.row.1': '接收',
    'decoder.ssi32.annotation.0': '发送控制',
    'decoder.ssi32.annotation.1': '发送确认',
    'decoder.ssi32.annotation.2': '接收控制',
    'decoder.ssi32.annotation.3': '接收确认',
  },
} as const satisfies ComponentMessages;
