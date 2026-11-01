import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'driver.demo.name': 'Demo device',
    'driver.demo.option.signals': 'Signal generator',
    'driver.demo.value.sine': 'Sine',
    'driver.demo.value.square': 'Square',
    'driver.demo.value.triangle': 'Triangle',
    'driver.demo.value.sawtooth': 'Sawtooth',
    'driver.demo.value.random': 'Random',
    'driver.demo.value.constant': 'Constant',
  },
  'zh-CN': {
    'driver.demo.name': 'Demo 设备',
    'driver.demo.option.signals': '信号发生器',
    'driver.demo.value.sine': '正弦',
    'driver.demo.value.square': '方波',
    'driver.demo.value.triangle': '三角波',
    'driver.demo.value.sawtooth': '锯齿波',
    'driver.demo.value.random': '随机',
    'driver.demo.value.constant': '恒定',
  },
} as const satisfies ComponentMessages;
