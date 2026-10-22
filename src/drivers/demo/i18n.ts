import type { ComponentMessages } from '../../components.js';

export const messages = {
  "en": {
    "driver.demo.name": "Demo device",
    "driver.demo.option.logicPattern": "Logic pattern",
    "driver.demo.option.analogPattern": "Analog pattern",
    "driver.demo.option.frequencyHz": "Signal frequency (Hz)",
    "driver.demo.option.amplitude": "Amplitude",
    "driver.demo.option.offset": "Offset",
    "driver.demo.option.seed": "Seed",
    "driver.demo.value.sine": "Sine",
    "driver.demo.value.square": "Square",
    "driver.demo.value.triangle": "Triangle",
    "driver.demo.value.sawtooth": "Sawtooth",
    "driver.demo.value.random": "Random",
    "driver.demo.value.constant": "Constant",
    "driver.demo.value.clock": "Clock",
    "driver.demo.value.incremental": "Incremental",
    "driver.demo.value.walking-one": "Walking one",
    "driver.demo.value.walking-zero": "Walking zero"
  },
  "zh-CN": {
    "driver.demo.name": "Demo 设备",
    "driver.demo.option.logicPattern": "数字信号模式",
    "driver.demo.option.analogPattern": "模拟信号模式",
    "driver.demo.option.frequencyHz": "信号频率（Hz）",
    "driver.demo.option.amplitude": "幅度",
    "driver.demo.option.offset": "偏置",
    "driver.demo.option.seed": "随机种子",
    "driver.demo.value.sine": "正弦",
    "driver.demo.value.square": "方波",
    "driver.demo.value.triangle": "三角波",
    "driver.demo.value.sawtooth": "锯齿波",
    "driver.demo.value.random": "随机",
    "driver.demo.value.constant": "恒定",
    "driver.demo.value.clock": "时钟",
    "driver.demo.value.incremental": "递增",
    "driver.demo.value.walking-one": "单一热码",
    "driver.demo.value.walking-zero": "单零热码"
  }
} as const satisfies ComponentMessages;
