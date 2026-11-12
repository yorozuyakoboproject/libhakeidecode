import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.sipi.name': 'SIPI (Zipwire) *',
    'decoder.sipi.description': 'Serial Inter-Processor Interface (SIPI), also known as Zipwire or HSSL.',
    'decoder.sipi.row.0': 'Fields',
    'decoder.sipi.row.1': 'Warnings',
    'decoder.sipi.annotation.0': 'Transaction Tag',
    'decoder.sipi.annotation.1': 'Command Code',
    'decoder.sipi.annotation.2': 'Channel',
    'decoder.sipi.annotation.3': 'Address',
    'decoder.sipi.annotation.4': 'Data',
    'decoder.sipi.annotation.5': 'CRC',
    'decoder.sipi.annotation.6': 'Warning',
    'decoder.sipi.binary.0': 'LFAST payload bytes',
  },
  'zh-CN': {
    'decoder.sipi.name': 'SIPI（Zipwire） *',
    'decoder.sipi.description': '串行处理器间接口（SIPI），也称 Zipwire 或 HSSL。',
    'decoder.sipi.row.0': '字段',
    'decoder.sipi.row.1': '警告',
    'decoder.sipi.annotation.0': '事务标记',
    'decoder.sipi.annotation.1': '命令码',
    'decoder.sipi.annotation.2': '通道',
    'decoder.sipi.annotation.3': '地址',
    'decoder.sipi.annotation.4': '数据',
    'decoder.sipi.annotation.5': 'CRC 校验',
    'decoder.sipi.annotation.6': '警告',
    'decoder.sipi.binary.0': 'LFAST 载荷字节',
  },
} as const satisfies ComponentMessages;
