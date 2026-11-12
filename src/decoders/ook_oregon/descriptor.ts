import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ook_oregon',
  name: 'Oregon *',
  longname: 'Oregon Scientific',
  desc: 'Oregon Scientific weather sensor protocol.',
  inputs: ['ook'],
  outputs: [],
  tags: ['Sensor'],
  options: [
    {
      id: 'unknown',
      desc: 'Unknown type is',
      default: 'Unknown',
      values: [
        'Unknown',
        'Temp',
        'Temp_Hum',
        'Temp_Hum1',
        'Temp_Hum_Baro',
        'Temp_Hum_Baro1',
        'UV',
        'UV1',
        'Wind',
        'Rain',
        'Rain1',
      ],
    },
  ],
  annotations: [
    ['bit', 'Bit'],
    ['field', 'Field'],
    ['l2', 'Level 2'],
    ['pre', 'Preamble'],
    ['syn', 'Sync'],
    ['id', 'SensorID'],
    ['ch', 'Channel'],
    ['roll', 'Rolling code'],
    ['f1', 'Flags1'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['fields', 'Fields', [1, 3, 4]],
    ['l2vals', 'Level 2', [2]],
  ],
  binary: [['data-hex', 'Hex data']],
};
