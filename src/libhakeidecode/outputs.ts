import { DecodeError, sampleNumber } from './errors.js';
import type {
  DecoderLifecycle,
  EventHandler,
  MetaDefinition,
  OutputEvent,
  OutputRegistration,
  OutputType,
} from './types.js';
export const OUTPUT_ANN = 'annotation';
export const OUTPUT_PROTOCOL = 'protocol';
export const OUTPUT_PYTHON = OUTPUT_PROTOCOL;
export const OUTPUT_BINARY = 'binary';
export const OUTPUT_META = 'meta';
export const OUTPUT_LOGIC = 'logic';
export const SRD_CONF_SAMPLERATE = 10000;
const TYPES = new Set<OutputType>([OUTPUT_ANN, OUTPUT_PROTOCOL, OUTPUT_BINARY, OUTPUT_META, OUTPUT_LOGIC]);

export class OutputStreams {
  readonly decoder: Pick<DecoderLifecycle, 'descriptor'>;
  readonly instanceId: string;
  readonly onEvent: EventHandler;
  streams: OutputRegistration[];
  constructor(
    decoder: Pick<DecoderLifecycle, 'descriptor'>,
    { instanceId, onEvent = () => {} }: { instanceId?: string; onEvent?: EventHandler } = {},
  ) {
    this.decoder = decoder;
    this.instanceId = instanceId ?? `${decoder.descriptor.id}-1`;
    this.onEvent = onEvent;
    this.streams = [];
  }
  register(type: OutputType, protoId: string = this.instanceId, meta: MetaDefinition | null = null): number {
    if (!TYPES.has(type)) throw new DecodeError(`Unknown output type: ${type}`);
    if (typeof protoId !== 'string' || !protoId) throw new DecodeError('protoId must be a non-empty string.');
    if (type === OUTPUT_META) {
      if (
        !Array.isArray(meta) ||
        meta.length !== 3 ||
        !['int', 'float'].includes(meta[0]) ||
        meta.slice(1).some((v) => typeof v !== 'string')
      ) {
        throw new DecodeError("Meta registration requires ['int'|'float', name, description].");
      }
      meta = Object.freeze([...meta]) as MetaDefinition;
    } else if (meta !== null) throw new DecodeError('meta is only valid for OUTPUT_META.');
    const existing = this.streams.find(
      (s) => s.type === type && s.protoId === protoId && JSON.stringify(s.meta) === JSON.stringify(meta),
    );
    if (existing) return existing.id;
    const id = this.streams.length;
    this.streams.push(Object.freeze({ id, type, protoId, meta }));
    return id;
  }
  put(ss: bigint, es: bigint, outputId: number, data: unknown): void {
    sampleNumber(ss, 'ss');
    sampleNumber(es, 'es');
    if (es < ss) throw new DecodeError('Output interval must satisfy ss <= es.');
    const stream = Number.isInteger(outputId) && this.streams[outputId];
    if (!stream) throw new DecodeError(`Unregistered output ID: ${outputId}`);
    const descriptor = this.decoder.descriptor;
    if (stream.type === OUTPUT_ANN) {
      if (
        !Array.isArray(data) ||
        (data.length !== 2 && data.length !== 3) ||
        !Number.isInteger(data[0]) ||
        !descriptor.annotations?.[data[0]] ||
        !Array.isArray(data[1]) ||
        data[1].some((v) => typeof v !== 'string') ||
        (data.length === 3 && (typeof data[2] !== 'number' || !Number.isFinite(data[2])))
      ) {
        throw new DecodeError('Annotation must be [declaredClassIndex, [text, ...], optionalValue].');
      }
    }
    if (stream.type === OUTPUT_BINARY) {
      if (
        !Array.isArray(data) ||
        data.length !== 2 ||
        !Number.isInteger(data[0]) ||
        !descriptor.binary?.[data[0]] ||
        !(data[1] instanceof Uint8Array) ||
        data[1].length === 0
      ) {
        throw new DecodeError('Binary must be [declaredClassIndex, Uint8Array].');
      }
    }
    if (stream.type === OUTPUT_META) {
      if (
        typeof data !== 'number' ||
        !Number.isFinite(data) ||
        (stream.meta![0] === 'int' && !Number.isSafeInteger(data))
      )
        throw new DecodeError('Meta value has the wrong numeric type or range.');
    }
    if (stream.type === OUTPUT_LOGIC) {
      if (
        es === ss ||
        !Array.isArray(data) ||
        data.length !== 2 ||
        !Number.isInteger(data[0]) ||
        !descriptor.logicOutputChannels?.[data[0]] ||
        !(data[1] instanceof Uint8Array) ||
        data[1].length === 0
      ) {
        throw new DecodeError(
          'Logic must be [declaredGroupIndex, Uint8Array bitfield] with declared logicOutputChannels and ss < es.',
        );
      }
    }
    this.onEvent(
      Object.freeze({
        type: stream.type,
        ss,
        es,
        outputId,
        protoId: stream.protoId,
        meta: stream.meta,
        decoder: descriptor.id,
        instanceId: this.instanceId,
        data,
      }) as OutputEvent,
    );
  }
}
