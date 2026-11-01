import { generatorPlugin, OUTPUT_BINARY, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { OutputEvent } from '../../libhakeidecode/index.js';
import { I2CDecoder } from './index.js';
import type { I2CFrame, I2CProtocolPacket } from './index.js';
import { EventRuntime } from '../event-runtime.js';
import type { EventRuntimeApi } from '../event-runtime.js';
import type { DecodeRuntime, DecodeRuntimeContext } from '../definition.js';

export function createI2CRuntime(context: DecodeRuntimeContext): DecodeRuntime {
  return new EventRuntime<I2CFrame>(generatorPlugin(I2CDecoder), context, {
    event(event: OutputEvent, runtime: EventRuntimeApi<I2CFrame>): void {
      if (event.type === OUTPUT_PROTOCOL) {
        const packet = event.data as I2CProtocolPacket;
        if (packet[0] === 'ADDRESS')
          runtime.addFrame({
            ss: event.ss,
            es: event.es,
            kind: 'address',
            direction: packet[1],
            value: packet[2],
            ack: packet[3],
            address: packet[2],
          });
        else if (packet[0] === 'DATA')
          runtime.addFrame({
            ss: event.ss,
            es: event.es,
            kind: 'data',
            direction: packet[1],
            value: packet[2],
            ack: packet[3],
            address: packet[4],
          });
      } else if (event.type === OUTPUT_BINARY) {
        const [index, bytes] = event.data as readonly [number, Uint8Array];
        const key = ['address-read', 'address-write', 'data-read', 'data-write'][index];
        if (key) runtime.addBinary(key, bytes);
      }
    },
  });
}

export type { I2CFrame };
