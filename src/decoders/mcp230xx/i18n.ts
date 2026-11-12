import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.mcp230xx.name': 'MCP230XX *',
    'decoder.mcp230xx.description': 'MCP230XX 8/16-bit I²C output expanders.',
    'decoder.mcp230xx.option.type': 'Type',
    'decoder.mcp230xx.value.MCP23008': 'MCP23008',
    'decoder.mcp230xx.value.MCP23017': 'MCP23017',
    'decoder.mcp230xx.row.0': 'Registers',
    'decoder.mcp230xx.row.1': 'Warnings',
    'decoder.mcp230xx.annotation.0': 'Register read',
    'decoder.mcp230xx.annotation.1': 'Register write',
    'decoder.mcp230xx.annotation.2': 'Warning',
  },
  'zh-CN': {
    'decoder.mcp230xx.name': 'MCP230XX *',
    'decoder.mcp230xx.description': 'MCP230XX 8/16 位 I²C 输出扩展器。',
    'decoder.mcp230xx.option.type': '型号',
    'decoder.mcp230xx.value.MCP23008': 'MCP23008',
    'decoder.mcp230xx.value.MCP23017': 'MCP23017',
    'decoder.mcp230xx.row.0': '寄存器',
    'decoder.mcp230xx.row.1': '警告',
    'decoder.mcp230xx.annotation.0': '寄存器读取',
    'decoder.mcp230xx.annotation.1': '寄存器写入',
    'decoder.mcp230xx.annotation.2': '警告',
  },
} as const satisfies ComponentMessages;
