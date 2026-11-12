import { descriptor } from './descriptor.js';
import { createSPIRuntime } from './runtime.js';
import type { DecoderWorkerDefinition, DecodeFrame } from '../definition.js';
import type { SPIFrame } from './index.js';

const frame = (value: DecodeFrame): SPIFrame => value as SPIFrame;
export const worker: DecoderWorkerDefinition = {
  id: descriptor.id,
  mode: 'logic',
  inputs: descriptor.inputs,
  outputs: descriptor.outputs,
  createRuntime: createSPIRuntime,
  csvHeader: 'start_sample,end_sample,time_s,word_index,mosi,miso,cs',
  csvRow(value, sampleRate, triggerSample): string {
    const item = frame(value);
    return [
      item.ss,
      item.es,
      Number(item.ss - triggerSample) / sampleRate,
      item.wordIndex,
      item.mosi ?? '',
      item.miso ?? '',
      item.cs ?? '',
    ].join(',');
  },
  compareFrames(left, right): number {
    const a = frame(left),
      b = frame(right);
    return a.ss < b.ss ? -1 : a.ss > b.ss ? 1 : a.wordIndex - b.wordIndex;
  },
};
