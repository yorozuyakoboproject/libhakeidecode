import { descriptor } from './descriptor.js';
import { createIRNECRuntime } from './runtime.js';
import type { DecoderWorkerDefinition, DecodeFrame } from '../definition.js';
import type { IRNECFrame } from './index.js';

const frame = (value: DecodeFrame): IRNECFrame => value as IRNECFrame;
export const worker: DecoderWorkerDefinition = {
  id: descriptor.id,
  mode: 'logic',
  inputs: descriptor.inputs,
  outputs: descriptor.outputs,
  createRuntime: createIRNECRuntime,
  csvHeader: 'start_sample,end_sample,time_s,kind,address,command,address_inverse,command_inverse,valid',
  csvRow(value, sampleRate, triggerSample): string {
    const item = frame(value);
    return [
      item.ss,
      item.es,
      Number(item.ss - triggerSample) / sampleRate,
      item.kind,
      item.address ?? '',
      item.command ?? '',
      item.addressInverse ?? '',
      item.commandInverse ?? '',
      item.valid,
    ].join(',');
  },
  compareFrames(left, right): number {
    const a = frame(left),
      b = frame(right);
    if (a.ss !== b.ss) return a.ss < b.ss ? -1 : 1;
    return a.kind === b.kind ? 0 : a.kind === 'nec' ? -1 : 1;
  },
};
