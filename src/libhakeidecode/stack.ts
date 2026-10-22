import { createSampleChunk } from '../libhakei/index.js';
import type { SampleChunkInput } from '../libhakei/index.js';
import type {
  DecoderContext,
  DecoderLifecycle,
  EventHandler,
  LogicDecoder,
  OutputEvent,
  ProtocolDecoder,
  StackOptions,
} from './types.js';
import { DecodeError } from './errors.js';
import { DecoderRunner } from './runner.js';
import { OutputStreams, OUTPUT_PROTOCOL, SRD_CONF_SAMPLERATE } from './outputs.js';

interface Connection {
  to: ProtocolDecoder;
  protoId: string | null;
}

export class ProtocolStack {
  events: OutputEvent[];
  readonly onEvent: EventHandler;
  readonly collectEvents: boolean;
  readonly nodes: Map<DecoderLifecycle, OutputStreams>;
  readonly edges: Map<DecoderLifecycle, Connection[]>;
  started: boolean;
  ended: boolean;
  readonly sourceDecoder: LogicDecoder;
  readonly source: DecoderRunner;
  constructor(
    sourceDecoder: LogicDecoder,
    {
      channels = {},
      downstream = [],
      onEvent = () => {},
      collectEvents = true,
      instanceId,
      initialPins,
    }: StackOptions = {},
  ) {
    this.events = [];
    this.onEvent = onEvent;
    this.collectEvents = collectEvents;
    this.nodes = new Map();
    this.edges = new Map();
    this.started = false;
    this.ended = false;
    this.sourceDecoder = sourceDecoder;
    this.source = new DecoderRunner(sourceDecoder, {
      channels,
      instanceId,
      initialPins,
      onEvent: (event) => this.dispatch(sourceDecoder, event),
    });
    this.nodes.set(sourceDecoder, this.source.outputs);
    this.edges.set(sourceDecoder, []);
    let previous: DecoderLifecycle = sourceDecoder;
    for (const decoder of downstream) {
      this.add(decoder);
      this.connect(previous, decoder);
      previous = decoder;
    }
  }
  add<T extends ProtocolDecoder>(decoder: T, { instanceId }: { instanceId?: string } = {}): T {
    if (this.started) throw new DecodeError('Add decoders before starting the stack.');
    if (this.nodes.has(decoder)) throw new DecodeError('Decoder instance already belongs to this stack.');
    if (instanceId === undefined) {
      let index = 1;
      do {
        instanceId = decoder.descriptor.id + '-' + index++;
      } while ([...this.nodes.values()].some((node) => node.instanceId === instanceId));
    }
    const outputs = new OutputStreams(decoder, { instanceId, onEvent: (event) => this.dispatch(decoder, event) });
    if ([...this.nodes.values()].some((node) => node.instanceId === outputs.instanceId))
      throw new DecodeError('Duplicate instanceId; provide a distinct instanceId.');
    if (typeof decoder.decode !== 'function')
      throw new DecodeError('Upper decoder must implement decode(ss, es, data).');
    this.nodes.set(decoder, outputs);
    this.edges.set(decoder, []);
    return decoder;
  }
  connect(from: DecoderLifecycle, to: ProtocolDecoder, { protoId = null }: { protoId?: string | null } = {}): this {
    if (this.started) throw new DecodeError('Connect decoders before starting the stack.');
    if (!this.nodes.has(from) || !this.nodes.has(to)) throw new DecodeError('Both endpoints must belong to the stack.');
    const reaches = (node: DecoderLifecycle, seen = new Set<DecoderLifecycle>()): boolean => {
      if (node === from) return true;
      if (seen.has(node)) return false;
      seen.add(node);
      return this.edges.get(node)!.some((edge) => reaches(edge.to, seen));
    };
    if (reaches(to)) throw new DecodeError('Protocol stack cannot contain cycles.');
    const outputs = from.descriptor.outputs ?? [];
    const inputs = to.descriptor.inputs ?? [];
    if (!outputs.some((id) => inputs.includes(id)))
      throw new DecodeError('Connected decoder protocols are incompatible.');
    if (this.edges.get(from)!.some((edge) => edge.to === to && edge.protoId === protoId))
      throw new DecodeError('Duplicate connection.');
    this.edges.get(from)!.push({ to, protoId });
    return this;
  }
  order(): DecoderLifecycle[] {
    const discovery: DecoderLifecycle[] = [],
      seen = new Set<DecoderLifecycle>();
    const visit = (decoder: DecoderLifecycle): void => {
      if (seen.has(decoder)) return;
      seen.add(decoder);
      discovery.push(decoder);
      for (const edge of this.edges.get(decoder)!) visit(edge.to);
    };
    for (const decoder of this.nodes.keys()) visit(decoder);
    const indegrees = new Map(discovery.map((decoder) => [decoder, 0]));
    for (const edges of this.edges.values()) for (const { to } of edges) indegrees.set(to, indegrees.get(to)! + 1);
    const result: DecoderLifecycle[] = [],
      emitted = new Set<DecoderLifecycle>();
    while (result.length < discovery.length) {
      const next = discovery.find((decoder) => !emitted.has(decoder) && indegrees.get(decoder) === 0);
      if (!next) throw new DecodeError('Protocol stack cannot contain cycles.');
      emitted.add(next);
      result.push(next);
      for (const { to } of this.edges.get(next)!) indegrees.set(to, indegrees.get(to)! - 1);
    }
    return result;
  }
  start(sampleRate: number): void {
    if (this.started) return;
    this.source.start(sampleRate, { deferMetadata: true });
    for (const decoder of this.order()) {
      if (decoder === this.sourceDecoder) continue;
      const outputs = this.nodes.get(decoder)!;
      const context: DecoderContext = {
        register: (...args) => outputs.register(...args),
        put: (...args) => outputs.put(...args),
        hasChannel: () => false,
        channelValue: () => undefined,
        get currentSample() {
          return decoder.samplenum;
        },
      };
      decoder.ctx = context;
      decoder.start(context);
    }
    for (const decoder of this.order()) decoder.metadata(SRD_CONF_SAMPLERATE, sampleRate);
    this.started = true;
  }
  dispatch(from: DecoderLifecycle, event: OutputEvent): void {
    if (event.type === OUTPUT_PROTOCOL)
      for (const edge of this.edges.get(from)!) {
        if (edge.protoId !== null && edge.protoId !== event.protoId) continue;
        edge.to.samplenum = event.es;
        edge.to.decode(event.ss, event.es, structuredClone(event.data));
      }
    if (this.collectEvents) this.events.push(event);
    this.onEvent(event);
  }
  push(input: SampleChunkInput): this {
    if (this.ended) throw new DecodeError('Cannot push after EOF or cancellation.');
    const chunk = createSampleChunk(input);
    this.start(chunk.sampleRate);
    this.source.push(chunk.isFinal ? { ...chunk, isFinal: false } : chunk);
    for (const decoder of this.order()) if (decoder !== this.sourceDecoder) decoder.flush?.();
    if (chunk.isFinal) this.finish();
    return this;
  }
  finish(): this {
    if (this.ended) return this;
    try {
      this.source.finish();
      if (this.started)
        for (const decoder of this.order())
          if (decoder !== this.sourceDecoder) {
            decoder.flush?.();
            decoder.onEof?.({ sample: this.source.expectedSample ?? 0n });
          }
    } finally {
      this.ended = true;
    }
    return this;
  }
  reset(): this {
    this.source.reset();
    for (const [decoder, outputs] of this.nodes)
      if (decoder !== this.sourceDecoder) {
        decoder.reset?.();
        outputs.streams = [];
        decoder.samplenum = 0n;
        decoder.matched = null;
      }
    this.events = [];
    this.started = false;
    this.ended = false;
    return this;
  }
  cancel(): this {
    if (this.ended) return this;
    try {
      this.source.cancel();
      for (const decoder of this.order()) if (decoder !== this.sourceDecoder) decoder.onCancel?.();
    } finally {
      this.ended = true;
    }
    return this;
  }
}
