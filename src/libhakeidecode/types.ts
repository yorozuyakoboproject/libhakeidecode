import type { WaitToken } from './wait.js';

export type ChannelId = string | number;
export type LogicLevel = 0 | 1;

export type Pin = LogicLevel | 255;
export type Pins = Pin[];
export type WaitPredicate = 'l' | 'h' | 'r' | 'f' | 'e' | 'n';
export type WaitValue = WaitPredicate | number | bigint;
export type WaitCondition = Readonly<Record<string, WaitValue>> | ReadonlyMap<ChannelId, WaitValue>;
export type WaitConditions = WaitCondition | readonly WaitCondition[] | null;
export type LogicGenerator = Generator<WaitToken, void, Pins>;

export type OptionValue = string | number | boolean;
export interface ChannelDeclaration {
  readonly id: string;
  readonly name?: string;
  readonly desc?: string;
  readonly optional?: boolean;
}
export interface OptionDeclaration {
  readonly id: string;
  readonly desc?: string;
  readonly default: OptionValue;
  readonly values?: readonly OptionValue[];
}
export type ClassDeclaration = readonly [id: string, description: string];
export type AnnotationRow = readonly [id: string, description: string, classes: readonly number[]];
export interface DecoderDescriptor {
  readonly apiVersion?: number;
  readonly id: string;
  readonly name?: string;
  readonly longname?: string;
  readonly desc?: string;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly tags?: readonly string[];
  readonly channels?: readonly ChannelDeclaration[];
  readonly optionalChannels?: readonly ChannelDeclaration[];
  readonly options?: readonly OptionDeclaration[] | Readonly<Record<string, OptionValue>>;
  readonly annotations?: readonly ClassDeclaration[];
  readonly annotationRows?: readonly AnnotationRow[];
  readonly binary?: readonly ClassDeclaration[];
  readonly logicOutputChannels?: readonly (ClassDeclaration | string)[];
}
export type OutputType = 'annotation' | 'protocol' | 'binary' | 'meta' | 'logic';
export type MetaDefinition = readonly [type: 'int' | 'float', name: string, description: string];
export type AnnotationData = readonly [classIndex: number, texts: readonly string[]];
export type BinaryData = readonly [classIndex: number, bytes: Uint8Array];
export type LogicData = readonly [groupIndex: number, bytes: Uint8Array];
export interface OutputDataMap {
  annotation: AnnotationData;
  protocol: unknown;
  binary: BinaryData;
  meta: number;
  logic: LogicData;
}
export interface OutputEventBase {
  readonly ss: bigint;
  readonly es: bigint;
  readonly outputId: number;
  readonly protoId: string;
  readonly decoder: string;
  readonly instanceId: string;
  readonly meta: MetaDefinition | null;
}

export type OutputEvent<K extends OutputType = OutputType> = {
  [T in K]: Readonly<OutputEventBase & { type: T; data: OutputDataMap[T] }>;
}[K];
export type EventHandler = (event: OutputEvent) => void;
export interface OutputRegistration {
  readonly id: number;
  readonly type: OutputType;
  readonly protoId: string;
  readonly meta: MetaDefinition | null;
}
export interface DecoderContext {
  register(type: OutputType, protoId?: string, meta?: MetaDefinition | null): number;
  put(ss: bigint, es: bigint, outputId: number, data: unknown): void;
  hasChannel(id: ChannelId): boolean;
  channelValue(id: ChannelId, sample?: bigint): Pin | undefined;
  readonly currentSample: bigint;
}
export interface EofInfo { readonly sample: bigint; }
export interface DecoderLifecycle {
  readonly descriptor: DecoderDescriptor;
  ctx: DecoderContext | null;
  samplenum: bigint;
  matched: boolean[] | null;
  start(ctx: DecoderContext): void;
  metadata(key: number, value: number): void;
  reset(): void;
  flush?(): void;
  onEof?(info: EofInfo): void;
  onCancel?(): void;
}
export interface LogicDecoder extends DecoderLifecycle { decode(): LogicGenerator; }
export interface ProtocolDecoder<Data = unknown> extends DecoderLifecycle { decode(ss: bigint, es: bigint, data: Data): void; }
export interface DecoderClass {
  new(options?: Record<string, OptionValue>): DecoderLifecycle;
  readonly descriptor: DecoderDescriptor;
  readonly apiVersion?: number;
}
export type ChannelMapping = Readonly<Record<string, string | number | boolean | null | undefined>>;
export interface RunnerOptions {
  channels?: ChannelMapping;
  onEvent?: EventHandler;
  instanceId?: string;
  allowGaps?: boolean;
  initialPins?: Readonly<Record<string, LogicLevel>>;
}
export interface StackOptions extends Omit<RunnerOptions, 'allowGaps'> {
  downstream?: readonly ProtocolDecoder[];
  collectEvents?: boolean;
}
