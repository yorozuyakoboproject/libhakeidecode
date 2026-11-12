import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'mlx90614',
  name: 'MLX90614 *',
  longname: 'Melexis MLX90614',
  desc: 'Melexis MLX90614 infrared thermometer protocol.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['IC', 'Sensor'],
  annotations: [
    ['celsius', 'Temperature / °C'],
    ['kelvin', 'Temperature / K'],
  ],
  annotationRows: [
    ['temps-celsius', 'Temperature / °C', [0]],
    ['temps-kelvin', 'Temperature / K', [1]],
  ],
};
