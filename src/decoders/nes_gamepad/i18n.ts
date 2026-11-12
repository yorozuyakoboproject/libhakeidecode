import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.nes_gamepad.name': 'NES gamepad *',
    'decoder.nes_gamepad.description': 'NES gamepad button states.',
    'decoder.nes_gamepad.option.variant': 'Gamepad variant',
    'decoder.nes_gamepad.value.Standard gamepad': 'Standard Gamepad',
    'decoder.nes_gamepad.row.0': 'Button states',
    'decoder.nes_gamepad.row.1': 'No button presses',
    'decoder.nes_gamepad.row.2': 'Gamepad unconnected',
    'decoder.nes_gamepad.annotation.0': 'Button state',
    'decoder.nes_gamepad.annotation.1': 'No button press',
    'decoder.nes_gamepad.annotation.2': 'Gamepad unconnected',
  },
  'zh-CN': {
    'decoder.nes_gamepad.name': 'NES 游戏手柄 *',
    'decoder.nes_gamepad.description': 'NES 游戏手柄按键状态。',
    'decoder.nes_gamepad.option.variant': '手柄型号',
    'decoder.nes_gamepad.value.Standard gamepad': '标准手柄',
    'decoder.nes_gamepad.row.0': '按键状态',
    'decoder.nes_gamepad.row.1': '无按键按下',
    'decoder.nes_gamepad.row.2': '手柄未连接',
    'decoder.nes_gamepad.annotation.0': '按键状态',
    'decoder.nes_gamepad.annotation.1': '无按键按下',
    'decoder.nes_gamepad.annotation.2': '手柄未连接',
  },
} as const satisfies ComponentMessages;
