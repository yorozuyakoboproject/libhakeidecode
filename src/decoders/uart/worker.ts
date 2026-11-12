import { descriptor } from './descriptor.js';
import { createUARTRuntime } from './runtime.js';
import type { DecoderWorkerDefinition, DecodeFrame } from '../definition.js';
import type { UARTFrame } from './runtime.js';

const frame = (value: DecodeFrame): UARTFrame => value as UARTFrame;
export const worker: DecoderWorkerDefinition = {
  id: descriptor.id,
  mode: 'logic',
  inputs: descriptor.inputs,
  outputs: descriptor.outputs,
  createRuntime: createUARTRuntime,
  csvHeader: 'direction,start_sample,end_sample,time_s,value_hex,value_dec,valid',
  csvRow(value, sampleRate, triggerSample): string {
    const item = frame(value);
    return [
      item.direction ? 'TX' : 'RX',
      item.ss,
      item.es,
      Number(item.ss - triggerSample) / sampleRate,
      item.value.toString(16).toUpperCase(),
      item.value,
      item.valid === null ? 'incomplete' : item.valid,
    ].join(',');
  },
  compareFrames(left, right): number {
    return left.ss < right.ss ? -1 : left.ss > right.ss ? 1 : frame(left).direction - frame(right).direction;
  },
};
