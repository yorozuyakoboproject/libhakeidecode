import { generatorPlugin, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { OutputEvent } from '../../libhakeidecode/index.js';
import { IRNECDecoder } from './index.js';
import type { IRNECFrame, IRNECProtocolPacket } from './index.js';
import { EventRuntime } from '../event-runtime.js';
import type { DecodeRuntime, DecodeRuntimeContext } from '../definition.js';

export function createIRNECRuntime(context: DecodeRuntimeContext): DecodeRuntime {
  return new EventRuntime<IRNECFrame>(generatorPlugin(IRNECDecoder), context, {
    event(event: OutputEvent, runtime): void {
      if (event.type !== OUTPUT_PROTOCOL) return;
      const packet = event.data as IRNECProtocolPacket;
      if (packet[0] === 'FRAME') runtime.addFrame({ ss: event.ss, es: event.es, ...packet[1] });
    },
  });
}

export type { IRNECFrame };
