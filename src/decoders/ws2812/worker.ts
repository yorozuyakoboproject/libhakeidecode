import { descriptor } from './descriptor.js';
import { createWS2812Runtime } from './runtime.js';
import type { DecoderWorkerDefinition, DecodeFrame } from '../definition.js';
import type { WS2812Frame } from './index.js';

const frame = (value: DecodeFrame): WS2812Frame => value as WS2812Frame;
export const worker: DecoderWorkerDefinition = {
  id: descriptor.id,
  mode: 'logic',
  inputs: descriptor.inputs,
  outputs: descriptor.outputs,
  createRuntime: createWS2812Runtime,
  csvHeader: 'start_sample,end_sample,time_s,index,r,g,b,w,text',
  csvRow(value, sampleRate, triggerSample): string {
    const item = frame(value);
    return [
      item.ss,
      item.es,
      Number(item.ss - triggerSample) / sampleRate,
      item.index,
      item.r,
      item.g,
      item.b,
      item.w ?? '',
      '"' + item.text.replaceAll('"', '""') + '"',
    ].join(',');
  },
  compareFrames(left, right): number {
    const a = frame(left),
      b = frame(right);
    return a.ss < b.ss ? -1 : a.ss > b.ss ? 1 : a.index - b.index;
  },
};
