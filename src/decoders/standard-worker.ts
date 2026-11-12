import { STANDARD_CSV_HEADER, StandardRuntime, standardCompareFrames, standardCsvRow } from './standard-runtime.js';
import type { StandardDecoderClass } from './standard-runtime.js';
import type { DecoderWorkerDefinition } from './definition.js';
import type { DecoderDescriptor } from '../libhakeidecode/types.js';

export function createStandardWorker(
  descriptor: DecoderDescriptor,
  DecoderClass: StandardDecoderClass,
  mode?: 'logic' | 'protocol',
): DecoderWorkerDefinition {
  const hasProtocolInput = descriptor.inputs?.some((input) => input !== 'logic') ?? false;
  const resolvedMode = hasProtocolInput ? 'protocol' : (mode ?? 'logic');
  return {
    id: descriptor.id,
    mode: resolvedMode,
    inputs: descriptor.inputs,
    outputs: descriptor.outputs,
    createRuntime: (context) => new StandardRuntime(DecoderClass, context, resolvedMode),
    csvHeader: STANDARD_CSV_HEADER,
    csvRow: standardCsvRow,
    compareFrames: standardCompareFrames,
  };
}
