import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.miller.name': 'Miller *',
    'decoder.miller.description': 'Miller encoding protocol.',
    'decoder.miller.channel.data': 'Data',
    'decoder.miller.option.baudrate': 'Baud rate',
    'decoder.miller.option.edge': 'Edge',
    'decoder.miller.value.rising': 'Rising',
    'decoder.miller.value.falling': 'Falling',
    'decoder.miller.value.either': 'Either',
    'decoder.miller.row.0': 'Bits',
    'decoder.miller.row.1': 'Bitstrings',
    'decoder.miller.annotation.0': 'Bit',
    'decoder.miller.annotation.1': 'Bitstring',
    'decoder.miller.binary.0': 'Raw binary',
  },
  'zh-CN': {
    'decoder.miller.name': '米勒编码 *',
    'decoder.miller.description': '米勒编码协议。',
    'decoder.miller.channel.data': '数据',
    'decoder.miller.option.baudrate': '波特率',
    'decoder.miller.option.edge': '边沿',
    'decoder.miller.value.rising': '上升沿',
    'decoder.miller.value.falling': '下降沿',
    'decoder.miller.value.either': '任意边沿',
    'decoder.miller.row.0': '位',
    'decoder.miller.row.1': '位串',
    'decoder.miller.annotation.0': '位',
    'decoder.miller.annotation.1': '位串',
    'decoder.miller.binary.0': '原始二进制',
  },
} as const satisfies ComponentMessages;
