import { DecodeError } from './errors.js';
import { DecoderRunner } from './runner.js';
import type {
  DecoderClass,
  DecoderEngine,
  DecoderEngineContext,
  DecoderPlugin,
  LogicDecoder,
  OutputEvent,
  SignalWindow,
} from './types.js';

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
    if (
      !this.runner.channelMap.some(
        (mapped, index) => mapped !== null && window.channel(this.runner.channelDeclarations[index]!.id),
      )
    )
      throw new DecodeError('No decoder channels are present in the signal window.');
    this.runner.pushWindow(window);
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
