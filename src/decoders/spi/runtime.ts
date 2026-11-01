import { generatorPlugin, OUTPUT_BINARY, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { OutputEvent } from '../../libhakeidecode/index.js';
import { SPIDecoder } from './index.js';
import type { SPIFrame, SPIProtocolPacket } from './index.js';
import { EventRuntime } from '../event-runtime.js';
import type { DecodeRuntime, DecodeRuntimeContext } from '../definition.js';

export function createSPIRuntime(context: DecodeRuntimeContext): DecodeRuntime {
  return new EventRuntime<SPIFrame>(generatorPlugin(SPIDecoder), context, {
    event(event: OutputEvent, runtime): void {
      if (event.type === OUTPUT_PROTOCOL) {
        const packet = event.data as SPIProtocolPacket;
        if (packet[0] === 'WORD')
          runtime.addFrame({
            ss: event.ss,
            es: event.es,
            mosi: packet[1],
            miso: packet[2],
            cs: packet[3],
            wordIndex: packet[4],
          });
      } else if (event.type === OUTPUT_BINARY) {
        const [index, bytes] = event.data as readonly [number, Uint8Array];
        runtime.addBinary(index === 0 ? 'mosi' : 'miso', bytes);
      }
    },
  });
}

export type { SPIFrame };
