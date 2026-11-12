import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.nrf24l01.name': 'nRF24L01(+) *',
    'decoder.nrf24l01.description': '2.4GHz RF transceiver chip.',
    'decoder.nrf24l01.option.chip': 'Chip type',
    'decoder.nrf24l01.value.nrf24l01': 'Nrf24l01',
    'decoder.nrf24l01.value.xn297': 'Xn297',
    'decoder.nrf24l01.row.0': 'Commands',
    'decoder.nrf24l01.row.1': 'Responses',
    'decoder.nrf24l01.row.2': 'Warnings',
    'decoder.nrf24l01.annotation.0': 'Command',
    'decoder.nrf24l01.annotation.1': 'Payload',
    'decoder.nrf24l01.annotation.2': 'Register read',
    'decoder.nrf24l01.annotation.3': 'Payload read',
    'decoder.nrf24l01.annotation.4': 'Warning',
  },
  'zh-CN': {
    'decoder.nrf24l01.name': 'nRF24L01(+) *',
    'decoder.nrf24l01.description': '2.4GHz 射频收发器芯片。',
    'decoder.nrf24l01.option.chip': '芯片类型',
    'decoder.nrf24l01.value.nrf24l01': 'nRF24L01(+)',
    'decoder.nrf24l01.value.xn297': 'XN297 兼容芯片',
    'decoder.nrf24l01.row.0': '命令',
    'decoder.nrf24l01.row.1': '响应',
    'decoder.nrf24l01.row.2': '警告',
    'decoder.nrf24l01.annotation.0': '命令',
    'decoder.nrf24l01.annotation.1': '负载',
    'decoder.nrf24l01.annotation.2': '寄存器读取',
    'decoder.nrf24l01.annotation.3': '负载读取',
    'decoder.nrf24l01.annotation.4': '警告',
  },
} as const satisfies ComponentMessages;
