import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.midi.name': 'MIDI *',
    'decoder.midi.description': 'Musical Instrument Digital Interface (MIDI) protocol.',
    'decoder.midi.row.0': 'Normal',
    'decoder.midi.row.1': 'SysReal',
    'decoder.midi.annotation.0': 'Text (verbose)',
    'decoder.midi.annotation.1': 'SysReal text (verbose)',
    'decoder.midi.annotation.2': 'Error text',
  },
  'zh-CN': {
    'decoder.midi.name': 'MIDI *',
    'decoder.midi.description': '乐器数字接口（MIDI）协议。',
    'decoder.midi.row.0': '常规消息',
    'decoder.midi.row.1': '系统实时消息',
    'decoder.midi.annotation.0': '文本（详细）',
    'decoder.midi.annotation.1': '系统实时文本（详细）',
    'decoder.midi.annotation.2': '错误文本',
  },
} as const satisfies ComponentMessages;
