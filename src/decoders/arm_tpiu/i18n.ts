import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.arm_tpiu.name': 'ARM TPIU *',
    'decoder.arm_tpiu.description': 'Filter TPIU formatted trace data into separate streams.',
    'decoder.arm_tpiu.option.stream': 'Stream index',
    'decoder.arm_tpiu.option.sync_offset': 'Initial sync offset',
    'decoder.arm_tpiu.row.0': 'Current streams',
    'decoder.arm_tpiu.row.1': 'Stream data',
    'decoder.arm_tpiu.annotation.0': 'Current stream',
    'decoder.arm_tpiu.annotation.1': 'Stream data',
  },
  'zh-CN': {
    'decoder.arm_tpiu.name': 'ARM TPIU *',
    'decoder.arm_tpiu.description': '将 TPIU 格式的跟踪数据过滤为独立数据流。',
    'decoder.arm_tpiu.option.stream': '数据流索引',
    'decoder.arm_tpiu.option.sync_offset': '初始同步偏移',
    'decoder.arm_tpiu.row.0': '当前数据流',
    'decoder.arm_tpiu.row.1': '数据流数据',
    'decoder.arm_tpiu.annotation.0': '当前数据流',
    'decoder.arm_tpiu.annotation.1': '数据流数据',
  },
} as const satisfies ComponentMessages;
