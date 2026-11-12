import type { ComponentMessages } from '../../components.js';

export const messages = {
  en: {
    'decoder.mlx90614.name': 'MLX90614 *',
    'decoder.mlx90614.description': 'Melexis MLX90614 infrared thermometer protocol.',
    'decoder.mlx90614.row.0': 'Temperature / °C',
    'decoder.mlx90614.row.1': 'Temperature / K',
    'decoder.mlx90614.annotation.0': 'Temperature / °C',
    'decoder.mlx90614.annotation.1': 'Temperature / K',
  },
  'zh-CN': {
    'decoder.mlx90614.name': 'MLX90614 *',
    'decoder.mlx90614.description': 'Melexis MLX90614 红外温度计协议。',
    'decoder.mlx90614.row.0': '温度 / °C',
    'decoder.mlx90614.row.1': '温度 / K',
    'decoder.mlx90614.annotation.0': '温度 / °C',
    'decoder.mlx90614.annotation.1': '温度 / K',
  },
} as const satisfies ComponentMessages;
