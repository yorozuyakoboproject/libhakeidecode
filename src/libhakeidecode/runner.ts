import { createSampleChunk } from '../libhakei/index.js';
import type { SampleChunk, SampleChunkInput } from '../libhakei/index.js';
import type {
  ChannelDeclaration,
  ChannelId,
  DecoderContext,
  LogicDecoder,
  LogicGenerator,
  LogicWindow,
  Pin,
  Pins,
  RunnerOptions,
  SignalWindow,
} from './types.js';
import type { CompiledWait, WaitTerm } from './wait.js';
import { DecodeError, EOFError, SampleGapError } from './errors.js';
import { OutputStreams, SRD_CONF_SAMPLERATE } from './outputs.js';
import { ValuesLogicWindow } from './signal.js';
import { WaitToken, compileWait, matchWaitInto } from './wait.js';

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
  window!: SignalWindow | null;
  position!: bigint | null;
  expectedSample!: bigint | null;
  sampleRate!: number | null;
  previous!: Pins | null;
  pins!: Pins;
  windows!: (LogicWindow | null)[];
  flags!: boolean[];
  failed!: Error | null;
  channelKeys!: string | null;
  constructor(
    decoder: LogicDecoder,
    { channels = {}, onEvent, instanceId, allowGaps = false, initialPins = {} }: RunnerOptions = {},
  ) {
    this.decoder = decoder;
    const descriptor = decoder.descriptor;
    const declared = [...(descriptor.channels ?? []), ...(descriptor.optionalChannels ?? [])];
    this.channelDeclarations = declared.length ? declared : Object.keys(channels).map((id) => ({ id, optional: true }));
    this.channelMap = this.channelDeclarations.map((channel, index) => {
      const value = channels[channel.id] ?? channels[index];
      if (value == null || value === false || value === -1) {
        if (!channel.optional && index < (descriptor.channels?.length ?? 0))
          throw new DecodeError(`Missing required channel: ${channel.id}`);
        return null;
      }
      return value === true ? channel.id : String(value);
    });
    if (Object.values(initialPins).some((value) => value !== 0 && value !== 1))
      throw new DecodeError('Initial pins must be 0 or 1.');
    this.initialPins = initialPins;
    this.allowGaps = allowGaps;
    this.outputs = new OutputStreams(decoder, { instanceId, onEvent });
    this.clearState();
  }
  clearState(): void {
    this.started = false;
    this.ended = false;
    this.completed = false;
    this.generator = null;
    this.pendingWait = null;
    this.firstWait = true;
    this.chunk = null;
    this.window = null;
    this.position = null;
    this.expectedSample = null;
    this.sampleRate = null;
    this.previous = null;
    this.pins = [];
    this.windows = [];
    this.flags = [];
    this.failed = null;
    this.channelKeys = null;
    this.decoder.samplenum = 0n;
    this.decoder.matched = null;
  }
  channelIndex(id: ChannelId): number {
    if (typeof id === 'number' || /^\d+$/.test(String(id))) return Number(id);
    return this.channelDeclarations.findIndex((channel) => channel.id === id);
  }
  hasChannel(id: ChannelId): boolean {
    const index = this.channelIndex(id);
    return index >= 0 && this.channelMap[index] != null;
  }
  channelValue(id: ChannelId, sample = this.decoder.samplenum): Pin | undefined {
    if (!this.chunk || sample < this.chunk.startSample || sample >= this.chunk.endSample) return undefined;
    const name = this.channelMap[this.channelIndex(id)];
    return name == null ? 255 : (this.chunk.channels[name][Number(sample - this.chunk.startSample)] as Pin);
  }
  start(sampleRate: number, { deferMetadata = false }: { deferMetadata?: boolean } = {}): void {
    if (this.started) return;
    this.sampleRate = sampleRate;
    const { decoder } = this;
    const context: DecoderContext = {
      register: (...args) => this.outputs.register(...args),
      put: (...args) => this.outputs.put(...args),
      hasChannel: (id) => this.hasChannel(id),
      channelValue: (id, sample) => this.channelValue(id, sample),
      get currentSample() {
        return decoder.samplenum;
      },
    };
    this.decoder.ctx = context;
    this.decoder.start(context);
    if (!deferMetadata) this.decoder.metadata(SRD_CONF_SAMPLERATE, sampleRate);
    if (typeof this.decoder.decode !== 'function') throw new DecodeError('Logic decoder must implement *decode().');
    this.generator = this.decoder.decode();
    if (!this.generator || typeof this.generator.next !== 'function')
      throw new DecodeError('Logic decode() must return a synchronous generator.');
    this.started = true;
  }
  push(input: SampleChunkInput, signalWindow?: SignalWindow): this {
    if (this.ended) throw new DecodeError('Cannot push after EOF or cancellation.');
    if (this.failed) throw this.failed;
    const chunk = createSampleChunk(input);
    if (this.expectedSample !== null && chunk.startSample !== this.expectedSample) {
      if (!this.allowGaps || chunk.startSample < this.expectedSample)
        throw new SampleGapError(this.expectedSample, chunk.startSample);
      this.reset();
    }
    if (this.sampleRate !== null && chunk.sampleRate !== this.sampleRate)
      throw new DecodeError('Sample rate changed; reset the runner first.');
    const keys = Object.keys(chunk.channels).sort().join('\0');
    if (this.channelKeys !== null && keys !== this.channelKeys)
      throw new DecodeError('Input channel layout changed; reset the runner first.');
    for (const name of this.channelMap)
      if (name != null && !Object.hasOwn(chunk.channels, name))
        throw new DecodeError(`Input chunk has no mapped channel: ${name}`);
    if (!this.started) this.start(chunk.sampleRate);
    this.channelKeys = keys;
    if (this.position === null) this.position = chunk.startSample;
    this.expectedSample = chunk.endSample;
    this.chunk = chunk;
    this.window = signalWindow ?? null;
    this.prepareWindows();
    try {
      this.pump();
      this.decoder.flush?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wrapped =
        error instanceof DecodeError
          ? error
          : new DecodeError(`Decoder ${this.outputs.instanceId} failed: ${message}`, { cause: error });
      this.failed = wrapped;
      this.completed = true;
      throw wrapped;
    } finally {
      this.chunk = null;
      this.window = null;
    }
    if (chunk.isFinal) this.finish();
    return this;
  }
  private prepareWindows(): void {
    const chunk = this.chunk!;
    this.windows.length = this.channelMap.length;
    for (let index = 0; index < this.channelMap.length; index++) {
      const declaration = this.channelDeclarations[index]!;
      const view = this.window?.channel(declaration.id) ?? this.window?.channel(index);
      const name = this.channelMap[index];
      this.windows[index] = view ?? (name == null ? null : new ValuesLogicWindow(chunk.channels[name]!));
    }
    this.pins.length = this.channelMap.length;
  }
  private readPins(offset: number, target: Pins): void {
    for (let index = 0; index < this.windows.length; index++) {
      const view = this.windows[index];
      target[index] = view ? view.at(offset) : 255;
    }
  }
  private skipOffset(conditions: CompiledWait, cursor: number, length: number): number {
    let best = length - cursor;
    for (const terms of conditions) {
      if (terms.length !== 1) return 0;
      const term = terms[0]!;
      let candidate: number;
      if (term.kind === 'skip') {
        if (term.count < 0) return 0;
        candidate = Number(term.count - term.skipped + 1n);
      } else if (term.kind === 'e' || term.kind === 'r' || term.kind === 'f') {
        const view = this.windows[term.channel];
        candidate = view ? view.nextEdge(cursor + 1) - cursor : length - cursor;
      } else return 0;
      if (candidate < 1) candidate = 1;
      if (candidate < best) best = candidate;
    }
    return best > 1 ? Math.min(best, length - cursor) : 0;
  }
  private advanceSkipTerms(conditions: CompiledWait, skipped: number): void {
    if (skipped < 1) return;
    const delta = BigInt(skipped);
    for (const terms of conditions)
      for (const term of terms) {
        if ((term as WaitTerm).kind !== 'skip') continue;
        const wait = term as Extract<WaitTerm, { kind: 'skip' }>;
        wait.skipped = wait.count < wait.skipped + delta ? wait.count : wait.skipped + delta;
      }
  }
  pump(): void {
    const chunk = this.chunk,
      generator = this.generator;
    if (!chunk || !generator || this.position === null) throw new DecodeError('Runner has no active sample chunk.');
    let cursor = Number(this.position - chunk.startSample);
    let resume: Pins | undefined;
    let sameSampleHits = 0;
    while (!this.completed && cursor < chunk.length) {
      if (!this.pendingWait) {
        let result;
        try {
          result = resume === undefined ? generator.next() : generator.next(resume);
        } catch (error) {
          this.completed = true;
          this.position = chunk.startSample + BigInt(cursor);
          throw error;
        }
        resume = undefined;
        if (result.done) {
          this.completed = true;
          this.position = chunk.startSample + BigInt(cursor);
          return;
        }
        if (!(result.value instanceof WaitToken)) throw new DecodeError('A logic decoder must yield wait() tokens.');
        this.pendingWait = compileWait(result.value, (id) => this.channelIndex(id), {
          firstWait: this.firstWait,
          position: this.position,
        });
        this.firstWait = false;
      }
      this.readPins(cursor, this.pins);
      if (this.previous === null) {
        const initial: Pins = new Array(this.pins.length);
        for (let index = 0; index < this.pins.length; index++) {
          initial[index] =
            this.initialPins[index] ?? this.initialPins[this.channelDeclarations[index]!.id] ?? this.pins[index]!;
        }
        this.previous = initial;
      }
      const automatic = this.pendingWait.every((terms) => terms.length === 0);
      if (automatic) {
        this.decoder.samplenum = chunk.startSample + BigInt(cursor);
        this.decoder.matched = null;
        this.pendingWait = null;
        this.position = this.decoder.samplenum;
        resume = this.pins;
        if (++sameSampleHits > 10000) throw new DecodeError('Decoder made too many waits without advancing a sample.');
        continue;
      }
      const matched = matchWaitInto(this.pendingWait, this.pins, this.previous, this.flags);
      if (matched) {
        this.decoder.samplenum = chunk.startSample + BigInt(cursor);
        this.decoder.matched = this.flags;
        this.pendingWait = null;
        this.position = this.decoder.samplenum;
        resume = this.pins;
        [this.pins, this.previous] = [this.previous, this.pins];
        if (++sameSampleHits > 10000) throw new DecodeError('Decoder made too many waits without advancing a sample.');
        continue;
      }
      [this.pins, this.previous] = [this.previous, this.pins];
      const jump = this.skipOffset(this.pendingWait, cursor, chunk.length);
      if (jump > 1) {
        this.advanceSkipTerms(this.pendingWait, jump - 1);
        cursor += jump;
        if (cursor < chunk.length) this.readPins(cursor - 1, this.previous);
      } else cursor++;
      sameSampleHits = 0;
    }
    this.position = chunk.startSample + BigInt(cursor);
  }
  finish(): this {
    if (this.ended) return this;
    if (this.failed) {
      this.ended = true;
      this.completed = true;
      this.generator = null;
      this.pendingWait = null;
      this.chunk = null;
      return this;
    }
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
      this.ended = true;
      this.completed = true;
      this.generator = null;
      this.pendingWait = null;
      this.chunk = null;
      this.window = null;
    }
    return this;
  }
  reset(): this {
    try {
      this.generator?.return?.();
    } finally {
      this.decoder.reset?.();
      this.outputs.streams = [];
      this.clearState();
    }
    return this;
  }
  cancel(): this {
    if (this.ended) return this;
    try {
      this.generator?.return?.();
      this.decoder.onCancel?.();
    } finally {
      this.generator = null;
      this.pendingWait = null;
      this.chunk = null;
      this.window = null;
      this.ended = true;
      this.completed = true;
    }
    return this;
  }
}
