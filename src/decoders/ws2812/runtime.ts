import { generatorPlugin, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { OutputEvent } from '../../libhakeidecode/index.js';
import { WS2812Decoder } from './index.js';
import type { WS2812Frame, WS2812ProtocolPacket } from './index.js';
import { EventRuntime } from '../event-runtime.js';
import type { DecodeRuntime, DecodeRuntimeContext } from '../definition.js';

export function createWS2812Runtime(context: DecodeRuntimeContext): DecodeRuntime {
  return new EventRuntime<WS2812Frame>(generatorPlugin(WS2812Decoder), context, {
    event(event: OutputEvent, runtime): void {
      if (event.type !== OUTPUT_PROTOCOL) return;
      const packet = event.data as WS2812ProtocolPacket;
      if (packet[0] === 'PIXEL') runtime.addFrame({ ss: event.ss, es: event.es, ...packet[1] });
      else runtime.addValue('incompleteBits', packet[1]);
    },
  });
}

export type { WS2812Frame };
