import { descriptor } from './descriptor.js';
import { createRF433Runtime } from './runtime.js';
import type { DecoderWorkerDefinition, DecodeFrame } from '../definition.js';
import type { RF433Frame } from './index.js';

const frame = (value: DecodeFrame): RF433Frame => value as RF433Frame;
export const worker: DecoderWorkerDefinition = {
  id: descriptor.id,
  createRuntime: createRF433Runtime,
  csvHeader: 'start_sample,end_sample,time_s,encoding,address,button,code,valid',
  csvRow(value, sampleRate, triggerSample): string {
    const item = frame(value);
    return [
      item.ss,
      item.es,
      Number(item.ss - triggerSample) / sampleRate,
      item.encoding,
      item.address,
      item.button,
      item.code,
      item.valid,
    ].join(',');
  },
  compareFrames(left, right): number {
    const a = frame(left),
      b = frame(right);
    return a.ss < b.ss ? -1 : a.ss > b.ss ? 1 : a.code - b.code;
  },
};
