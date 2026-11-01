import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.rf433.description': 'Pulse-coded 433 MHz remote control',
    'decoder.rf433.data': 'Data channel',
    'decoder.rf433.option.encoding': 'Encoding',
    'decoder.rf433.value.ev1527': 'EV1527',
    'decoder.rf433.value.pt2262': 'PT2262 / SC52x2 / HX22x2',
    'decoder.rf433.annotation.frame': 'Frame',
    'decoder.rf433.annotation.invalid-frame': 'Invalid RF packet',
    'decoder.rf433.annotation.warning': 'Warning',
    'decoder.rf433.warning.resync': 'Incomplete RF packet discarded during resynchronization',
    'decoder.rf433.warning.invalid-pulse': 'Invalid RF pulse rejected',
    'decoder.rf433.warning.incomplete': 'Incomplete RF packet discarded at end of capture',
    'decoder.rf433.name': 'RF 433',
  },
  'zh-CN': {
    'decoder.rf433.description': '脉宽编码的 433 MHz 遥控数据',
    'decoder.rf433.data': '数据通道',
    'decoder.rf433.option.encoding': '编码',
    'decoder.rf433.value.ev1527': 'EV1527',
    'decoder.rf433.value.pt2262': 'PT2262 / SC52x2 / HX22x2',
    'decoder.rf433.annotation.frame': '数据帧',
    'decoder.rf433.annotation.invalid-frame': '无效 RF 数据帧',
    'decoder.rf433.annotation.warning': '警告',
    'decoder.rf433.warning.resync': '重新同步时丢弃了不完整 RF 数据帧',
    'decoder.rf433.warning.invalid-pulse': '拒绝了无效 RF 脉冲',
    'decoder.rf433.warning.incomplete': '采集结束时丢弃了不完整 RF 数据帧',
    'decoder.rf433.name': 'RF 433',
  },
} as const satisfies ComponentMessages;
