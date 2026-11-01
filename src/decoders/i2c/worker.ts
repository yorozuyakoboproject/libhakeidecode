import { descriptor } from './descriptor.js';
import { createI2CRuntime } from './runtime.js';
import type { DecoderWorkerDefinition, DecodeFrame } from '../definition.js';
import type { I2CFrame } from './index.js';

const frame = (value: DecodeFrame): I2CFrame => value as I2CFrame;
export const worker: DecoderWorkerDefinition = {
  id: descriptor.id,
  createRuntime: createI2CRuntime,
  csvHeader: 'start_sample,end_sample,time_s,kind,direction,address,value,ack',
  csvRow(value, sampleRate, triggerSample): string {
    const item = frame(value);
    return [
      item.ss,
      item.es,
      Number(item.ss - triggerSample) / sampleRate,
      item.kind,
      item.direction,
      item.address,
      item.value,
      item.ack,
    ].join(',');
  },
  compareFrames(left, right): number {
    const a = frame(left),
      b = frame(right);
    if (a.ss !== b.ss) return a.ss < b.ss ? -1 : 1;
    if (a.direction !== b.direction) return a.direction === 'read' ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'address' ? -1 : 1;
    return a.value - b.value;
  },
};
