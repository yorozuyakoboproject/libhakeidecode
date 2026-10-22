import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';
import { formatPWMFrequency, formatPWMPeriod } from './format.js';

function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 0) return [(annotation.value ?? 0).toFixed(context.decimals) + '%'];
  const seconds = Number(annotation.es - annotation.ss) / context.sampleRate;
  if (annotation.classIndex === 1) return [formatPWMPeriod(seconds)];
  return [formatPWMFrequency(seconds)];
}

export const component = {
  descriptor,
  messages,
  ui: {
    description: descriptor.desc,
    descriptionKey: 'decoder.pwm.description',
    inputs: [{ key: 'data', label: 'Data', labelKey: 'decoder.pwm.channel' }],
    inputRequirement: 'all',
    rows: [
      { label: 'Duty cycle', labelKey: 'decoder.pwm.duty', classes: [0] },
      { label: 'Period', labelKey: 'decoder.pwm.period', classes: [1] },
      { label: 'Frequency', labelKey: 'decoder.pwm.frequency', classes: [2] },
    ],
    primaryOptions: ['polarity'],
    decimals: true,
    edgeInput: 'data',
    binaryOutputs: [{ key: 'raw', label: 'RAW' }],
    annotationTexts,
    summary(result, decimals, text): string {
      const average = result.values.averageDutyCycle;
      return average === null || average === undefined ? '' : text('decoder.pwm.summary', 'Mean duty: {duty}%').replace('{duty}', average.toFixed(decimals));
    },
  },
} satisfies DecoderDefinition;
