import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.stepper_motor.name': 'Stepper motor *',
    'decoder.stepper_motor.description': 'Absolute position and movement speed from step/dir.',
    'decoder.stepper_motor.channel.step': 'Step',
    'decoder.stepper_motor.channel.dir': 'Direction',
    'decoder.stepper_motor.option.unit': 'Unit',
    'decoder.stepper_motor.value.steps': 'Steps',
    'decoder.stepper_motor.value.mm': 'Mm',
    'decoder.stepper_motor.option.steps_per_mm': 'Steps per mm',
    'decoder.stepper_motor.row.0': 'Speeds',
    'decoder.stepper_motor.row.1': 'Positions',
    'decoder.stepper_motor.annotation.0': 'Speed',
    'decoder.stepper_motor.annotation.1': 'Position',
  },
  'zh-CN': {
    'decoder.stepper_motor.name': '步进电机 *',
    'decoder.stepper_motor.description': '根据步进/方向信号显示绝对位置和运动速度。',
    'decoder.stepper_motor.channel.step': '步进脉冲',
    'decoder.stepper_motor.channel.dir': '方向',
    'decoder.stepper_motor.option.unit': '单位',
    'decoder.stepper_motor.value.steps': '步',
    'decoder.stepper_motor.value.mm': '毫米',
    'decoder.stepper_motor.option.steps_per_mm': '每毫米步数',
    'decoder.stepper_motor.row.0': '速度',
    'decoder.stepper_motor.row.1': '位置',
    'decoder.stepper_motor.annotation.0': '速度',
    'decoder.stepper_motor.annotation.1': '位置',
  },
} as const satisfies ComponentMessages;
