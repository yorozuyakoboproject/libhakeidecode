import type { GenerationOptions, RoundtripCase, WaveformEncoder } from '../build/roundtrip.js';
import type { OptionValue } from '../libhakeidecode/types.js';

export interface SignalEncoderModule {
  cases(options?: GenerationOptions): Iterable<RoundtripCase<unknown>>;
  createEncoder(config: RoundtripCase<unknown>): WaveformEncoder<unknown>;
}

export interface SignalEncoderPreset {
  readonly name: string;
  readonly options: Readonly<Record<string, OptionValue>>;
}
