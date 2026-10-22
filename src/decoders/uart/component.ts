import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';

const rowData = [0, 2, 4, 6, 8, 10, 14, 16] as const;
const rowTxData = [1, 3, 5, 7, 9, 11, 15, 17] as const;
function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 6 || annotation.classIndex === 7)
    return [context.text('decoder.uart.annotation.parityError', 'Parity error'), 'PE'];
  if (annotation.classIndex === 10 || annotation.classIndex === 11)
    return [context.text('decoder.uart.annotation.frameError', 'Frame error'), 'FE'];
  return annotation.texts;
}

export const component = {
  descriptor,
  messages,
  ui: {
    description: descriptor.desc,
    descriptionKey: 'decoder.uart.description',
    inputs: [
      { key: 'rx', label: 'RX', labelKey: 'decoder.uart.rx', optional: true },
      { key: 'tx', label: 'TX', labelKey: 'decoder.uart.tx', optional: true },
    ],
    inputRequirement: 'any',
    rows: [
      { label: 'RX bits', classes: [12] },
      { label: 'RX data', classes: rowData },
      { label: 'TX bits', classes: [13] },
      { label: 'TX data', classes: rowTxData },
    ],
    primaryOptions: ['baudrate', 'data_bits', 'parity', 'stop_bits', 'format'],
    binaryOutputs: [
      { key: 'rx', label: 'RX' },
      { key: 'tx', label: 'TX' },
    ],
    annotationTexts,
    isErrorClass(classIndex): boolean {
      return classIndex === 6 || classIndex === 7 || classIndex === 10 || classIndex === 11;
    },
    summary(result): string {
      const data = result.previews.rx;
      return data?.length ? 'RX: ' + new TextDecoder().decode(data.subarray(0, 100)).replace(/[\r\n]/g, ' ') : '';
    },
  },
} satisfies DecoderDefinition;
