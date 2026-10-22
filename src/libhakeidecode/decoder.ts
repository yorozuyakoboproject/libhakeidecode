import { DecodeError } from './errors.js';
import { generatorPlugin } from './engine.js';
import { WaitToken } from './wait.js';
import type {
  ChannelId,
  DecoderClass,
  DecoderContext,
  DecoderDescriptor,
  DecoderLifecycle,
  DecoderPlugin,
  MetaDefinition,
  OptionDeclaration,
  OptionValue,
  OutputType,
  Pin,
  WaitConditions,
} from './types.js';

export class Decoder<Options extends object = Record<string, OptionValue>> implements DecoderLifecycle {
  static apiVersion = 3;
  static descriptor: DecoderDescriptor = {
    apiVersion: 3,
    id: 'decoder',
    name: 'Decoder',
    inputs: ['logic'],
    outputs: [],
  };
  options: Options;
  ctx: DecoderContext | null = null;
  samplenum = 0n;
  matched: boolean[] | null = null;
  get descriptor(): DecoderDescriptor {
    return (this.constructor as typeof Decoder).descriptor;
  }
  constructor(options: Partial<Options> = {}) {
    const declarations = this.descriptor.options ?? {};
    const list = Array.isArray(declarations) ? (declarations as readonly OptionDeclaration[]) : null;
    const defaults = list
      ? Object.fromEntries(list.map((o) => [o.id, o.default]))
      : (declarations as Readonly<Record<string, OptionValue>>);
    for (const key of Object.keys(options))
      if (!Object.hasOwn(defaults, key)) throw new DecodeError(`Unknown option: ${key}`);
    const resolved = { ...defaults, ...options };
    this.options = resolved as Options;
    if (list)
      for (const declaration of list) {
        const value = resolved[declaration.id];
        if (typeof value !== typeof declaration.default)
          throw new DecodeError(`Wrong type for option: ${declaration.id}`);
        if (typeof value === 'number' && !Number.isFinite(value))
          throw new DecodeError(`Non-finite option: ${declaration.id}`);
      }
  }
  start(ctx: DecoderContext): void {
    this.ctx = ctx;
  }
  metadata(_key: number, _value: number): void {}
  reset(): void {}
  wait(conditions: WaitConditions = null): WaitToken {
    return new WaitToken(conditions);
  }
  register(type: OutputType, protoId?: string, meta?: MetaDefinition | null): number {
    return this.context.register(type, protoId, meta);
  }
  put(ss: bigint, es: bigint, outputId: number, data: unknown): void {
    this.context.put(ss, es, outputId, data);
  }
  hasChannel(id: ChannelId): boolean {
    return this.context.hasChannel(id);
  }
  has_channel(id: ChannelId): boolean {
    return this.hasChannel(id);
  }
  channelValue(id: ChannelId, sample?: bigint): Pin | undefined {
    return this.context.channelValue(id, sample);
  }
  private get context(): DecoderContext {
    if (!this.ctx) throw new DecodeError('Decoder has not started.');
    return this.ctx;
  }
}

export class DecoderRegistry {
  readonly decoders = new Map<string, DecoderClass>();
  readonly plugins = new Map<string, DecoderPlugin<any, any>>();
  register<T extends DecoderClass>(DecoderClass: T): T {
    const descriptor = DecoderClass.descriptor;
    if (!descriptor?.id || (descriptor.apiVersion ?? DecoderClass.apiVersion) !== 3)
      throw new DecodeError('Decoder must declare an id and API version 3.');
    if (this.decoders.has(descriptor.id)) throw new DecodeError(`Decoder already registered: ${descriptor.id}`);
    this.decoders.set(descriptor.id, DecoderClass);
    return DecoderClass;
  }
  get(id: string): DecoderClass {
    const decoder = this.decoders.get(id);
    if (!decoder) throw new DecodeError(`Unknown decoder: ${id}`);
    return decoder;
  }
  registerPlugin<T extends DecoderPlugin<any, any>>(plugin: T): T {
    const descriptor = plugin.descriptor;
    if (!descriptor?.id || (descriptor.apiVersion ?? plugin.decoder.apiVersion) !== 3)
      throw new DecodeError('Plugin must declare an id and API version 3.');
    if (this.decoders.has(descriptor.id) && this.decoders.get(descriptor.id) !== plugin.decoder)
      throw new DecodeError(`Decoder already registered: ${descriptor.id}`);
    this.decoders.set(descriptor.id, plugin.decoder);
    this.plugins.set(descriptor.id, plugin);
    return plugin;
  }
  getPlugin(id: string): DecoderPlugin<any, any> {
    const plugin = this.plugins.get(id);
    if (plugin) return plugin;
    const decorated = generatorPlugin(this.get(id));
    this.plugins.set(id, decorated);
    return decorated;
  }
  list(): DecoderDescriptor[] {
    return [...this.decoders.values()].map((cls) => cls.descriptor);
  }
}
export const registry = new DecoderRegistry();
