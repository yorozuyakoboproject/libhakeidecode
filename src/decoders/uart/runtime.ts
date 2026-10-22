import { generatorPlugin, OUTPUT_BINARY, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { OutputEvent } from '../../libhakeidecode/index.js';
import { UARTDecoder } from './index.js';
import { EventRuntime } from '../event-runtime.js';
import type { EventRuntimeApi } from '../event-runtime.js';
import type { DecodeFrame, DecodeRuntime, DecodeRuntimeContext } from '../definition.js';
import type { UARTDirection, UARTProtocolPacket } from './index.js';

export interface UARTFrame extends DecodeFrame {
  direction: UARTDirection;
  value: number;
  valid: boolean | null;
}

export function createUARTRuntime(context: DecodeRuntimeContext): DecodeRuntime {
  const pending: [UARTFrame | null, UARTFrame | null] = [null, null];
  const flushPending = (runtime: EventRuntimeApi<UARTFrame>): void => {
    for (let direction = 0; direction < 2; direction++) {
      const frame = pending[direction];
      if (frame) runtime.addFrame(frame);
      pending[direction] = null;
    }
  };
  return new EventRuntime<UARTFrame>(generatorPlugin(UARTDecoder), context, {
    event(event: OutputEvent, runtime): void {
      if (event.type === OUTPUT_PROTOCOL) {
        const packet = event.data as UARTProtocolPacket;
        if (packet[0] === 'DATA')
          pending[packet[1]] = { ss: event.ss, es: event.es, direction: packet[1], value: packet[2][0], valid: null };
        else if (packet[0] === 'FRAME') {
          runtime.addFrame({
            ss: event.ss,
            es: event.es,
            direction: packet[1],
            value: packet[2][0],
            valid: packet[2][1],
          });
          pending[packet[1]] = null;
        }
      } else if (event.type === OUTPUT_BINARY) {
        const data = event.data as readonly [number, Uint8Array];
        if (data[0] < 0 || data[0] > 1) return;
        runtime.addBinary(data[0] === 0 ? 'rx' : 'tx', data[1]);
      }
    },
    finish(runtime): void {
      flushPending(runtime);
    },
    reset(runtime): void {
      flushPending(runtime);
    },
  });
}
