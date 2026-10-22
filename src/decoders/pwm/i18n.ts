import type { ComponentMessages } from '../../components.js';

export const messages = {
  "en": {
    "decoder.pwm.description": "Pulse-width modulation",
    "decoder.pwm.channel": "Input channel",
    "decoder.pwm.duty": "Duty cycle",
    "decoder.pwm.period": "Period",
    "decoder.pwm.frequency": "Frequency",
    "decoder.pwm.summary": "Mean duty: {duty}%",
    "decoder.pwm.option.polarity": "Active polarity",
    "decoder.pwm.value.active-high": "High active",
    "decoder.pwm.value.active-low": "Low active",
    "decoder.pwm.name": "PWM"
  },
  "zh-CN": {
    "decoder.pwm.description": "脉冲宽度调制",
    "decoder.pwm.channel": "输入通道",
    "decoder.pwm.duty": "占空比",
    "decoder.pwm.period": "周期",
    "decoder.pwm.frequency": "频率",
    "decoder.pwm.summary": "平均占空比：{duty}%",
    "decoder.pwm.option.polarity": "有效极性",
    "decoder.pwm.value.active-high": "高电平有效",
    "decoder.pwm.value.active-low": "低电平有效",
    "decoder.pwm.name": "PWM"
  }
} as const satisfies ComponentMessages;
