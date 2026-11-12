import type { ComponentMessages } from '../../components.js';

const channels = {
  clk: ['CLK', '时钟'],
  ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`d${index}`, [`D${index}`, `数据 ${index}`]])),
  rst: ['RST', '复位'],
} as const;

const channelEn = Object.fromEntries(
  Object.entries(channels).map(([id, [name]]) => [`decoder.parallel.channel.${id}`, name]),
);
const channelZh = Object.fromEntries(
  Object.entries(channels).map(([id, [, name]]) => [`decoder.parallel.channel.${id}`, name]),
);

export const messages = {
  en: {
    'decoder.parallel.name': 'Parallel *',
    'decoder.parallel.description': 'Generic parallel synchronous bus.',
    ...channelEn,
    'decoder.parallel.option.clock_edge': 'Clock edge to sample on',
    'decoder.parallel.value.rising': 'Rising',
    'decoder.parallel.value.falling': 'Falling',
    'decoder.parallel.value.either': 'Either',
    'decoder.parallel.option.reset_polarity': 'Reset line polarity',
    'decoder.parallel.value.low-active': 'Low Active',
    'decoder.parallel.value.high-active': 'High Active',
    'decoder.parallel.option.wordsize': 'Data wordsize (# bus cycles)',
    'decoder.parallel.option.endianness': 'Data endianness',
    'decoder.parallel.value.little': 'Little',
    'decoder.parallel.value.big': 'Big',
    'decoder.parallel.row.0': 'Items',
    'decoder.parallel.row.1': 'Words',
    'decoder.parallel.row.2': 'Warnings',
    'decoder.parallel.annotation.0': 'Item',
    'decoder.parallel.annotation.1': 'Word',
    'decoder.parallel.annotation.2': 'Warning',
    'decoder.parallel.binary.0': 'Binary',
  },
  'zh-CN': {
    'decoder.parallel.name': '并行总线 *',
    'decoder.parallel.description': '通用并行同步总线。',
    ...channelZh,
    'decoder.parallel.option.clock_edge': '采样时钟边沿',
    'decoder.parallel.value.rising': '上升沿',
    'decoder.parallel.value.falling': '下降沿',
    'decoder.parallel.value.either': '双边沿',
    'decoder.parallel.option.reset_polarity': '复位线极性',
    'decoder.parallel.value.low-active': '低有效',
    'decoder.parallel.value.high-active': '高有效',
    'decoder.parallel.option.wordsize': '数据字宽（总线周期数）',
    'decoder.parallel.option.endianness': '数据字节序',
    'decoder.parallel.value.little': '小端',
    'decoder.parallel.value.big': '大端',
    'decoder.parallel.row.0': '数据项',
    'decoder.parallel.row.1': '字',
    'decoder.parallel.row.2': '警告',
    'decoder.parallel.annotation.0': '数据项',
    'decoder.parallel.annotation.1': '字',
    'decoder.parallel.annotation.2': '警告',
    'decoder.parallel.binary.0': '二进制',
  },
} as const satisfies ComponentMessages;
