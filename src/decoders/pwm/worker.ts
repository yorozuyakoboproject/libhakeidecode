import { descriptor } from './descriptor.js';
import { createPWMRuntime } from './runtime.js';
import type { DecoderWorkerDefinition, DecodeFrame } from '../definition.js';
import type { PWMFrame } from './frame-store.js';

const frame = (value: DecodeFrame): PWMFrame => value as PWMFrame;
export const worker: DecoderWorkerDefinition = {
  id: descriptor.id,
  createRuntime: createPWMRuntime,
  csvHeader:
    'start_sample,end_sample,time_s,active_samples,period_samples,duty_percent,period_s,frequency_hz,average_duty_percent',
  csvRow(value, sampleRate, triggerSample): string {
    const item = frame(value);
    return [
      item.ss,
      item.es,
      Number(item.ss - triggerSample) / sampleRate,
      item.activeSamples,
      item.periodSamples,
      item.dutyCycle,
      item.periodSeconds,
      item.frequencyHz,
      item.averageDutyCycle,
    ].join(',');
  },
  compareFrames(left, right): number {
    return left.ss < right.ss ? -1 : left.ss > right.ss ? 1 : 0;
  },
};
