import { createSampleChunk } from '../libhakei/index.js';
import type { SampleChunk, SampleChunkInput } from '../libhakei/index.js';
import type { ChannelDeclaration, ChannelId, DecoderContext, LogicDecoder, LogicGenerator, Pin, Pins, RunnerOptions } from './types.js';
import type { CompiledWait } from './wait.js';
import { DecodeError, EOFError, SampleGapError } from './errors.js';
import { OutputStreams, SRD_CONF_SAMPLERATE } from './outputs.js';
import { WaitToken, compileWait, matchWait } from './wait.js';

export class DecoderRunner {
  readonly decoder: LogicDecoder;
  readonly channelDeclarations: readonly ChannelDeclaration[];
  readonly channelMap: (string | null)[];
  readonly initialPins: NonNullable<RunnerOptions['initialPins']>;
  readonly allowGaps: boolean;
  readonly outputs: OutputStreams;
  started!: boolean;
  ended!: boolean;
  completed!: boolean;
  generator!: LogicGenerator | null;
  pendingWait!: CompiledWait | null;
  firstWait!: boolean;
  chunk!: SampleChunk | null;
  position!: bigint | null;
  expectedSample!: bigint | null;
  sampleRate!: number | null;
  previous!: Pins | null;
  channelKeys!: string | null;
  constructor(decoder: LogicDecoder, { channels = {}, onEvent, instanceId, allowGaps = false, initialPins = {} }: RunnerOptions = {}) {
    this.decoder = decoder;
    const descriptor = decoder.descriptor;
    const declared = [...(descriptor.channels ?? []), ...(descriptor.optionalChannels ?? [])];
    this.channelDeclarations = declared.length ? declared : Object.keys(channels).map(id => ({ id, optional: true }));
    this.channelMap = this.channelDeclarations.map((channel, index) => {
      const value = channels[channel.id] ?? channels[index];
      if (value == null || value === false || value === -1) {
        if (!channel.optional && index < (descriptor.channels?.length ?? 0n)) throw new DecodeError(`Missing required channel: ${channel.id}`);
        return null;
      }
      return value === true ? channel.id : String(value);
    });
    if (Object.values(initialPins).some(value => value !== 0 && value !== 1)) throw new DecodeError('Initial pins must be 0 or 1.');
    this.initialPins = initialPins;
    this.allowGaps = allowGaps;
    this.outputs = new OutputStreams(decoder, { instanceId, onEvent });
    this.clearState();
  }
  clearState() {
    this.started = false; this.ended = false; this.completed = false;
    this.generator = null; this.pendingWait = null; this.firstWait = true;
    this.chunk = null; this.position = null; this.expectedSample = null;
    this.sampleRate = null; this.previous = null; this.channelKeys = null;
    this.decoder.samplenum = 0n; this.decoder.matched = null;
  }
  channelIndex(id: ChannelId): number {
    if (typeof id === 'number' || /^\d+$/.test(String(id))) return Number(id);
    return this.channelDeclarations.findIndex(channel => channel.id === id);
  }
  hasChannel(id: ChannelId): boolean { const index = this.channelIndex(id); return index >= 0 && this.channelMap[index] != null; }
  channelValue(id: ChannelId, sample = this.decoder.samplenum): Pin | undefined {
    if (!this.chunk || sample < this.chunk.startSample || sample >= this.chunk.endSample) return undefined;
    const name = this.channelMap[this.channelIndex(id)];
    return name == null ? 255 : this.chunk.channels[name][Number(sample - this.chunk.startSample)] as Pin;
  }
  start(sampleRate: number, { deferMetadata = false }: { deferMetadata?: boolean } = {}): void {
    if (this.started) return;
    this.sampleRate = sampleRate;
    const runner = this;
    const context: DecoderContext = {
      register: (...args) => this.outputs.register(...args),
      put: (...args) => this.outputs.put(...args),
      hasChannel: id => this.hasChannel(id),
      channelValue: (id, sample) => this.channelValue(id, sample),
      get currentSample() { return runner.decoder.samplenum; },
    };
    this.decoder.ctx = context;
    this.decoder.start(context);
    if (!deferMetadata) this.decoder.metadata(SRD_CONF_SAMPLERATE, sampleRate);
    if (typeof this.decoder.decode !== 'function') throw new DecodeError('Logic decoder must implement *decode().');
    this.generator = this.decoder.decode();
    if (!this.generator || typeof this.generator.next !== 'function') throw new DecodeError('Logic decode() must return a synchronous generator.');
    this.started = true;
  }
  push(input: SampleChunkInput): this {
    if (this.ended) throw new DecodeError('Cannot push after EOF or cancellation.');
    const chunk = createSampleChunk(input);
    if (this.expectedSample !== null && chunk.startSample !== this.expectedSample) {
      if (!this.allowGaps || chunk.startSample < this.expectedSample) throw new SampleGapError(this.expectedSample, chunk.startSample);
      this.reset();
    }
    if (this.sampleRate !== null && chunk.sampleRate !== this.sampleRate) throw new DecodeError('Sample rate changed; reset the runner first.');
    const keys = Object.keys(chunk.channels).sort().join('\0');
    if (this.channelKeys !== null && keys !== this.channelKeys) throw new DecodeError('Input channel layout changed; reset the runner first.');
    for (const name of this.channelMap) if (name != null && !Object.hasOwn(chunk.channels, name)) throw new DecodeError(`Input chunk has no mapped channel: ${name}`);
    if (!this.started) this.start(chunk.sampleRate);
    this.channelKeys = keys;
    if (this.position === null) this.position = chunk.startSample;
    this.expectedSample = chunk.endSample;
    this.chunk = chunk;
    try { this.pump(); this.decoder.flush?.(); } finally { this.chunk = null; }
    if (chunk.isFinal) this.finish();
    return this;
  }
  pump(): void {
    const chunk = this.chunk, generator = this.generator;
    if (!chunk || !generator || this.position === null) throw new DecodeError('Runner has no active sample chunk.');
    let resume: Pins | undefined;
    let sameSampleHits = 0;
    while (!this.completed && this.position < chunk.endSample) {
      if (!this.pendingWait) {
        let result;
        try { result = resume === undefined ? generator.next() : generator.next(resume); }
        catch (error) { this.completed = true; throw new DecodeError(`Decoder ${this.outputs.instanceId} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
        resume = undefined;
        if (result.done) { this.completed = true; return; }
        if (!(result.value instanceof WaitToken)) throw new DecodeError('A logic decoder must yield wait() tokens.');
        this.pendingWait = compileWait(result.value, id => this.channelIndex(id), { firstWait: this.firstWait, position: this.position });
        this.firstWait = false;
      }
      const pins = this.channelMap.map(name => name == null ? 255 : chunk.channels[name][Number(this.position! - chunk.startSample)] as Pin);
      if (this.previous === null) this.previous = pins.map((pin, index) => this.initialPins[index] ?? this.initialPins[this.channelDeclarations[index].id] ?? pin);
      const automatic = this.pendingWait.every(terms => terms.length === 0);
      const flags = automatic ? null : matchWait(this.pendingWait, pins, this.previous);
      if (!automatic) this.previous = pins;
      if (automatic || flags!.some(Boolean)) {
        this.decoder.samplenum = this.position;
        this.decoder.matched = flags;
        this.pendingWait = null;
        resume = pins;
        if (++sameSampleHits > 10000) throw new DecodeError('Decoder made too many waits without advancing a sample.');
      } else {
        this.position += 1n;
        sameSampleHits = 0;
      }
    }
  }
  finish(): this {
    if (this.ended) return this;
    try {
      if (this.started && !this.completed) {
        this.decoder.samplenum = this.expectedSample ?? this.position ?? 0n;
        try {
          const result = this.generator!.throw(new EOFError());
          if (!result.done) throw new DecodeError('Decoder yielded another wait after EOF.');
        } catch (error) {
          if (!(error instanceof EOFError)) throw error;
        }
      }
      if (this.started) this.decoder.flush?.();
      this.decoder.onEof?.({ sample: this.expectedSample ?? 0n });
    } finally {
      this.ended = true; this.completed = true;
      this.generator = null; this.pendingWait = null; this.chunk = null;
    }
    return this;
  }
  reset(): this {
    try { this.generator?.return?.(); }
    finally {
      this.decoder.reset?.();
      this.outputs.streams = [];
      this.clearState();
    }
    return this;
  }
  cancel(): this {
    if (this.ended) return this;
    try { this.generator?.return?.(); this.decoder.onCancel?.(); }
    finally {
      this.generator = null; this.pendingWait = null; this.chunk = null;
      this.ended = true; this.completed = true;
    }
    return this;
  }
}
