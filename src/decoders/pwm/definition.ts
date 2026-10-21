import type { Annotation, AnnotationTextContext, DecodeRuntimeContext, DecoderDefinition } from '../definition.js';
import { PWMDecoder } from './index.js';
import { createPWMRuntime } from './runtime.js';
import type { PWMFrame } from './frame-store.js';
import { formatPWMFrequency, formatPWMPeriod } from './format.js';

const frame = (value: import('../definition.js').DecodeFrame): PWMFrame => value as PWMFrame;
function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 0) return [(annotation.value ?? 0).toFixed(context.decimals) + '%'];
  const seconds = Number(annotation.es - annotation.ss) / context.sampleRate;
  if (annotation.classIndex === 1) return [formatPWMPeriod(seconds)];
  return [formatPWMFrequency(seconds)];
}

export const pwmDefinition: DecoderDefinition = {
  decoder: PWMDecoder,
  ui: {
    description: PWMDecoder.descriptor.desc,
    descriptionKey: 'pwm.description',
    inputs: [{ key: 'data', label: 'Data', labelKey: 'pwm.channel' }],
    inputRequirement: 'all',
    rows: [
      { label: 'Duty cycle', labelKey: 'pwm.duty', classes: [0] },
      { label: 'Period', labelKey: 'pwm.period', classes: [1] },
      { label: 'Frequency', labelKey: 'pwm.frequency', classes: [2] },
    ],
    primaryOptions: ['polarity'],
    decimals: true,
    edgeInput: 'data',
    binaryOutputs: [{ key: 'raw', label: 'RAW' }],
    csvHeader: 'start_sample,end_sample,time_s,active_samples,period_samples,duty_percent,period_s,frequency_hz,average_duty_percent',
    csvRow(value, sampleRate, triggerSample): string {
      const item = frame(value);
      return [item.ss, item.es, Number(item.ss - triggerSample) / sampleRate, item.activeSamples, item.periodSamples,
        item.dutyCycle, item.periodSeconds, item.frequencyHz, item.averageDutyCycle].join(',');
    },
    compareFrames(a, b): number { return a.ss < b.ss ? -1 : a.ss > b.ss ? 1 : 0; },
    annotationTexts,
    summary(result, decimals, text): string {
      const average = result.values.averageDutyCycle;
      return average === null || average === undefined ? '' : text('pwm.summary', 'Mean duty: {duty}%').replace('{duty}', average.toFixed(decimals));
    },
  },
  createRuntime(context: DecodeRuntimeContext) { return createPWMRuntime(context); },
};
