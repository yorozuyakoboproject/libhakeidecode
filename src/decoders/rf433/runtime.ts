import { generatorPlugin, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { OutputEvent } from '../../libhakeidecode/index.js';
import { RF433Decoder } from './index.js';
import type { RF433Frame, RF433ProtocolPacket } from './index.js';
import { EventRuntime } from '../event-runtime.js';
import type { DecodeRuntime, DecodeRuntimeContext } from '../definition.js';

export function createRF433Runtime(context: DecodeRuntimeContext): DecodeRuntime {
  return new EventRuntime<RF433Frame>(generatorPlugin(RF433Decoder), context, {
    event(event: OutputEvent, runtime): void {
      if (event.type !== OUTPUT_PROTOCOL) return;
      const packet = event.data as RF433ProtocolPacket;
      if (packet[0] === 'FRAME') runtime.addFrame({ ss: event.ss, es: event.es, ...packet[1] });
    },
  });
}

export type { RF433Frame };
