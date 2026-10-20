import { decoderDefinition } from '../decoders/index.js';
import type { DecodeRuntime, DecodeRuntimeHost, DecodeRuntimeResult } from '../decoders/definition.js';
import type { DecodeStartRequest } from './protocol.js';

export type { DecodeRuntime, DecodeRuntimeHost, DecodeRuntimeResult };

export function createDecodeRuntime(request: DecodeStartRequest, host: DecodeRuntimeHost): DecodeRuntime {
  return decoderDefinition(request.decoder).createRuntime({
    sampleRate: request.sampleRate,
    channels: request.channels,
    options: request.options,
    paged: request.paged ?? 'auto',
    host,
  });
}
