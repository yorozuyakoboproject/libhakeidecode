import type { ComponentMessages } from '../../components.js';

const zhAnnotations = Object.fromEntries(
  Array.from({ length: 18 }, (_, index) => [
    `decoder.hdcp.annotation.${index}`,
    `消息 0x${index.toString(16).toUpperCase().padStart(2, '0')}`,
  ]),
);

export const messages = {
  en: {
    'decoder.hdcp.name': 'HDCP *',
    'decoder.hdcp.description': 'HDCP protocol over HDMI.',
    'decoder.hdcp.row.0': 'Messages',
    'decoder.hdcp.row.1': 'Summaries',
    'decoder.hdcp.row.2': 'Warnings',
    'decoder.hdcp.annotation.0': 'Message 0x00',
    'decoder.hdcp.annotation.1': 'Message 0x01',
    'decoder.hdcp.annotation.2': 'Message 0x02',
    'decoder.hdcp.annotation.3': 'Message 0x03',
    'decoder.hdcp.annotation.4': 'Message 0x04',
    'decoder.hdcp.annotation.5': 'Message 0x05',
    'decoder.hdcp.annotation.6': 'Message 0x06',
    'decoder.hdcp.annotation.7': 'Message 0x07',
    'decoder.hdcp.annotation.8': 'Message 0x08',
    'decoder.hdcp.annotation.9': 'Message 0x09',
    'decoder.hdcp.annotation.10': 'Message 0x0A',
    'decoder.hdcp.annotation.11': 'Message 0x0B',
    'decoder.hdcp.annotation.12': 'Message 0x0C',
    'decoder.hdcp.annotation.13': 'Message 0x0D',
    'decoder.hdcp.annotation.14': 'Message 0x0E',
    'decoder.hdcp.annotation.15': 'Message 0x0F',
    'decoder.hdcp.annotation.16': 'Message 0x10',
    'decoder.hdcp.annotation.17': 'Message 0x11',
    'decoder.hdcp.annotation.18': 'Summary',
    'decoder.hdcp.annotation.19': 'Warning',
  },
  'zh-CN': {
    'decoder.hdcp.name': 'HDCP *',
    'decoder.hdcp.description': 'HDMI 上的 HDCP 协议。',
    'decoder.hdcp.row.0': '消息',
    'decoder.hdcp.row.1': '摘要',
    'decoder.hdcp.row.2': '警告',
    ...zhAnnotations,
    'decoder.hdcp.annotation.18': '摘要',
    'decoder.hdcp.annotation.19': '警告',
  },
} as const satisfies ComponentMessages;
