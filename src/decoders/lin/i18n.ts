import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.lin.name': 'LIN *',
    'decoder.lin.description': 'Local Interconnect Network (LIN) protocol.',
    'decoder.lin.option.version': 'Protocol version',
    'decoder.lin.row.0': 'Data',
    'decoder.lin.row.1': 'Errors',
    'decoder.lin.annotation.0': 'LIN data',
    'decoder.lin.annotation.1': 'Protocol info',
    'decoder.lin.annotation.2': 'Error description',
    'decoder.lin.annotation.3': 'Protocol violation or error',
  },
  'zh-CN': {
    'decoder.lin.name': 'LIN 总线 *',
    'decoder.lin.description': '本地互联网络（LIN）协议。',
    'decoder.lin.option.version': '协议版本',
    'decoder.lin.row.0': '数据',
    'decoder.lin.row.1': '错误',
    'decoder.lin.annotation.0': 'LIN 数据',
    'decoder.lin.annotation.1': '协议信息',
    'decoder.lin.annotation.2': '错误描述',
    'decoder.lin.annotation.3': '协议违例或错误',
  },
} as const satisfies ComponentMessages;
