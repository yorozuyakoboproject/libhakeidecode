import type { Annotation, AnnotationTextContext, DecodeFrame, DecodeRuntimeContext, DecoderDefinition } from '../definition.js';
import { UARTDecoder } from './index.js';
import { createUARTRuntime } from './runtime.js';
import type { UARTFrame } from './runtime.js';

const frame = (value: DecodeFrame): UARTFrame => value as UARTFrame;
const rowData = [0, 2, 4, 6, 8, 10, 14, 16] as const;
const rowTxData = [1, 3, 5, 7, 9, 11, 15, 17] as const;
function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 6 || annotation.classIndex === 7) return [context.text('annotation.parityError', 'Parity error'), 'PE'];
  if (annotation.classIndex === 10 || annotation.classIndex === 11) return [context.text('annotation.frameError', 'Frame error'), 'FE'];
  return annotation.texts;
}

export const uartDefinition: DecoderDefinition = {
  decoder: UARTDecoder,
  ui: {
    description: UARTDecoder.descriptor.desc,
    descriptionKey: 'decoder.description',
    inputs: [
      { key: 'rx', label: 'RX', labelKey: 'decoder.rx', optional: true },
      { key: 'tx', label: 'TX', labelKey: 'decoder.tx', optional: true },
    ],
    inputRequirement: 'any',
    rows: [
      { label: 'RX bits', classes: [12] },
      { label: 'RX data', classes: rowData },
      { label: 'TX bits', classes: [13] },
      { label: 'TX data', classes: rowTxData },
    ],
    primaryOptions: ['baudrate', 'data_bits', 'parity', 'stop_bits', 'format'],
    binaryOutputs: [{ key: 'rx', label: 'RX' }, { key: 'tx', label: 'TX' }],
    csvHeader: 'direction,start_sample,end_sample,time_s,value_hex,value_dec,valid',
    csvRow(value, sampleRate, triggerSample): string {
      const item = frame(value);
      return [item.direction ? 'TX' : 'RX', item.ss, item.es, Number(item.ss - triggerSample) / sampleRate,
        item.value.toString(16).toUpperCase(), item.value, item.valid === null ? 'incomplete' : item.valid].join(',');
    },
    compareFrames(a, b): number { return a.ss < b.ss ? -1 : a.ss > b.ss ? 1 : frame(a).direction - frame(b).direction; },
    annotationTexts,
    isErrorClass(classIndex): boolean { return classIndex === 6 || classIndex === 7 || classIndex === 10 || classIndex === 11; },
    summary(result): string {
      const data = result.binaries.rx;
      return data?.length ? 'RX: ' + new TextDecoder().decode(data.subarray(0, 100)).replace(/[\r\n]/g, ' ') : '';
    },
  },
  createRuntime(context: DecodeRuntimeContext) { return createUARTRuntime(context); },
};
