import { createSampleChunk } from '../libhakei/index.js';
import type { LogicSamples } from '../libhakei/index.js';
import { DecodeError } from './errors.js';
import { DecoderRunner } from './runner.js';
import { materializeLogicWindow } from './signal.js';
import type {
  DecoderClass,
  DecoderEngine,
  DecoderEngineContext,
  DecoderPlugin,
  LogicDecoder,
  LogicWindow,
  OutputEvent,
  SignalWindow,
} from './types.js';

function logicSamples(window: LogicWindow): LogicSamples {
  if (window.kind === 'values' && window.data && ArrayBuffer.isView(window.data) && !(window.data instanceof DataView))
    return window.data as LogicSamples;
  return materializeLogicWindow(window) as LogicSamples;
}

export class GeneratorEngine implements DecoderEngine<readonly OutputEvent[]> {
  readonly runner: DecoderRunner;
  readonly sink: DecoderEngineContext['sink'];
  private events: OutputEvent[] = [];
  constructor(DecoderClass: DecoderClass, context: DecoderEngineContext) {
    const decoder = new DecoderClass(context.options) as unknown as LogicDecoder;
    this.sink = context.sink;
    this.runner = new DecoderRunner(decoder, {
      channels: context.channels,
      instanceId: context.instanceId,
      onEvent: (event) => this.events.push(event),
    });
  }
  private async emit(): Promise<void> {
    if (!this.events.length) return;
    const batch = this.events;
    this.events = [];
    await this.sink.write(batch);
  }
  async push(window: SignalWindow): Promise<void> {
    const channels: Record<string, LogicSamples> = {};
    for (let index = 0; index < this.runner.channelMap.length; index++) {
      const mapped = this.runner.channelMap[index];
      if (mapped === null) continue;
      const view = window.channel(this.runner.channelDeclarations[index]!.id);
      if (view) channels[mapped] = logicSamples(view);
    }
    if (!Object.keys(channels).length) throw new DecodeError('No decoder channels are present in the signal window.');
    const chunk = createSampleChunk({ startSample: window.startSample, sampleRate: window.sampleRate, channels });
    this.runner.push(chunk, window);
    await this.emit();
  }
  async flush(): Promise<void> {
    await this.emit();
  }
  async finish(): Promise<void> {
    this.runner.finish();
    await this.emit();
  }
  reset(): void {
    this.runner.reset();
    this.events = [];
  }
  cancel(): void {
    this.runner.cancel();
    this.events = [];
  }
}

export function generatorPlugin(decoder: DecoderClass): DecoderPlugin {
  return {
    decoder,
    descriptor: decoder.descriptor,
    createEngine: (context) => new GeneratorEngine(decoder, context),
  };
}
