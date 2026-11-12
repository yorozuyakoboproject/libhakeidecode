import type { ComponentMessages } from '../../components.js';

const channels = {
  clk: ['Clock', '时钟'],
  ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`bit${index}`, [`Bit${index}`, `位 ${index}`]])),
} as const;

const rows = [
  'Raw bits',
  'Numbers',
  ...Array.from({ length: 32 }, (_, index) => `Enumeration slots ${index}`),
  'Enumeration overflows',
  'Warnings',
] as const;

const annotations = [
  'Raw pattern',
  'Number',
  ...Array.from({ length: 32 }, (_, index) => `Enumeration slot ${index}`),
  'Enumeration overflow',
  'Warning',
] as const;

const zhRows = [
  '原始位',
  '数字',
  ...Array.from({ length: 32 }, (_, index) => `枚举槽 ${index}`),
  '枚举溢出',
  '警告',
] as const;

const zhAnnotations = [
  '原始模式',
  '数字',
  ...Array.from({ length: 32 }, (_, index) => `枚举槽 ${index}`),
  '枚举溢出',
  '警告',
] as const;

const baseEn = {
  'decoder.numbers_and_state.name': 'Numbers and State *',
  'decoder.numbers_and_state.description':
    'Interpret bit patterns as different kinds of numbers (integer, float, enum).',
  'decoder.numbers_and_state.option.clkedge': 'Clock edge',
  'decoder.numbers_and_state.value.rising': 'Rising',
  'decoder.numbers_and_state.value.falling': 'Falling',
  'decoder.numbers_and_state.value.either': 'Either',
  'decoder.numbers_and_state.option.count': 'Total bits count',
  'decoder.numbers_and_state.option.interp': 'Interpretation',
  'decoder.numbers_and_state.value.unsigned': 'Unsigned',
  'decoder.numbers_and_state.value.signed': 'Signed',
  'decoder.numbers_and_state.value.fixpoint': 'Fixpoint',
  'decoder.numbers_and_state.value.fixsigned': 'Fixsigned',
  'decoder.numbers_and_state.value.ieee754': 'Ieee754',
  'decoder.numbers_and_state.value.enum': 'Enum',
  'decoder.numbers_and_state.option.fracbits': 'Fraction bits count',
  'decoder.numbers_and_state.option.mapping': 'Enum to text map file',
  'decoder.numbers_and_state.option.format': 'Number format',
  'decoder.numbers_and_state.value.-': '-',
  'decoder.numbers_and_state.value.bin': 'Bin',
  'decoder.numbers_and_state.value.oct': 'Oct',
  'decoder.numbers_and_state.value.dec': 'Dec',
  'decoder.numbers_and_state.value.hex': 'Hex',
} as const;

const baseZh = {
  'decoder.numbers_and_state.name': '数字与状态 *',
  'decoder.numbers_and_state.description': '将位模式解释为整数、浮点数或枚举状态。',
  'decoder.numbers_and_state.option.clkedge': '时钟边沿',
  'decoder.numbers_and_state.value.rising': '上升沿',
  'decoder.numbers_and_state.value.falling': '下降沿',
  'decoder.numbers_and_state.value.either': '双边沿',
  'decoder.numbers_and_state.option.count': '总位数',
  'decoder.numbers_and_state.option.interp': '解释方式',
  'decoder.numbers_and_state.value.unsigned': '无符号整数',
  'decoder.numbers_and_state.value.signed': '有符号整数',
  'decoder.numbers_and_state.value.fixpoint': '无符号定点',
  'decoder.numbers_and_state.value.fixsigned': '有符号定点',
  'decoder.numbers_and_state.value.ieee754': 'IEEE754 浮点',
  'decoder.numbers_and_state.value.enum': '枚举',
  'decoder.numbers_and_state.option.fracbits': '小数位数',
  'decoder.numbers_and_state.option.mapping': '枚举文本映射',
  'decoder.numbers_and_state.option.format': '数字格式',
  'decoder.numbers_and_state.value.-': '原生',
  'decoder.numbers_and_state.value.bin': '二进制',
  'decoder.numbers_and_state.value.oct': '八进制',
  'decoder.numbers_and_state.value.dec': '十进制',
  'decoder.numbers_and_state.value.hex': '十六进制',
} as const;

const channelEn = Object.fromEntries(
  Object.entries(channels).map(([id, [name]]) => [`decoder.numbers_and_state.channel.${id}`, name]),
);
const channelZh = Object.fromEntries(
  Object.entries(channels).map(([id, [, name]]) => [`decoder.numbers_and_state.channel.${id}`, name]),
);
const rowEn = Object.fromEntries(rows.map((name, index) => [`decoder.numbers_and_state.row.${index}`, name]));
const rowZh = Object.fromEntries(zhRows.map((name, index) => [`decoder.numbers_and_state.row.${index}`, name]));
const annotationEn = Object.fromEntries(
  annotations.map((name, index) => [`decoder.numbers_and_state.annotation.${index}`, name]),
);
const annotationZh = Object.fromEntries(
  zhAnnotations.map((name, index) => [`decoder.numbers_and_state.annotation.${index}`, name]),
);

export const messages = {
  en: { ...baseEn, ...channelEn, ...rowEn, ...annotationEn },
  'zh-CN': { ...baseZh, ...channelZh, ...rowZh, ...annotationZh },
} as const satisfies ComponentMessages;
