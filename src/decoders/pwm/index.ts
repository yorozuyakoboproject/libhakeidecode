import { sampleRatio } from '../../libhakei/sample-index.js';

import { Decoder, OUTPUT_ANN, OUTPUT_BINARY, OUTPUT_META, OutputStreams, SRD_CONF_SAMPLERATE, registry } from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderDescriptor, DecoderEngine, DecoderEngineContext, DecoderPlugin, LogicGenerator, OutputEvent } from '../../libhakeidecode/index.js';
import { PWMScanEngine } from './engine.js';
import type { PWMScanBatch } from './engine.js';
import { formatPWMDuty, formatPWMFrequency, formatPWMPeriod } from './format.js';
export interface PWMOptions {   polarity: string; }
export const PWM_ANN = Object.freeze({ DUTY_CYCLE: 0, PERIOD: 1, FREQUENCY: 2 });
export { formatPWMDuty, formatPWMFrequency, formatPWMPeriod } from './format.js';
export class PWMDecoder extends Decoder<PWMOptions> {
  static descriptor: DecoderDescriptor = {
    apiVersion: 3, id: 'pwm', name: 'PWM', longname: 'Pulse-width modulation',
    desc: 'Analog level encoded in duty cycle percentage.',
    inputs: ['logic'], outputs: [], tags: ['Encoding'],
    channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
    options: [{ id: 'polarity', desc: 'Polarity', default: 'active-high', values: ['active-low', 'active-high'] }],
    annotations: [['duty-cycle', 'Duty cycle'], ['period', 'Period'], ['frequency', 'Frequency']],
    annotationRows: [['duty-cycle-vals', 'Duty cycles', [0]], ['periods', 'Periods', [1]], ['frequency-vals', 'Frequencies', [2]]],
    binary: [['raw', 'RAW file']],
  };
  samplerate: number | null = null;
  ss_block: bigint | null = null;
  es_block: bigint | null = null;
  first_samplenum = 0n;
  private out_ann = -1;
  private out_binary = -1;
  private out_average = -1;
  constructor(options: Partial<PWMOptions> = {}) { super(options); this.reset(); }
  reset(): void { this.samplerate = null; this.ss_block = this.es_block = null; this.first_samplenum = 0n; }
  metadata(key: number, value: number): void { if (key === SRD_CONF_SAMPLERATE) this.samplerate = value; }
  start(ctx: DecoderContext): void {
    super.start(ctx); this.out_ann = this.register(OUTPUT_ANN); this.out_binary = this.register(OUTPUT_BINARY);
    this.out_average = this.register(OUTPUT_META, undefined, ['float', 'Average', 'PWM base (cycle) frequency']);
  }
  private putPeriod(seconds: number): void {
    this.put(this.ss_block!, this.es_block!, this.out_ann, [PWM_ANN.PERIOD, [formatPWMPeriod(seconds)]]);
  }
  private putFrequency(seconds: number): void {
    this.put(this.ss_block!, this.es_block!, this.out_ann, [PWM_ANN.FREQUENCY, [formatPWMFrequency(seconds)]]);
  }
  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    let cycles = 0, totalPercent = 0;
    yield this.wait({ 0: this.options.polarity === 'active-low' ? 'f' : 'r' });
    this.first_samplenum = this.samplenum;
    while (true) {
      const start = this.samplenum;
      yield this.wait({ 0: 'e' }); const middle = this.samplenum;
      yield this.wait({ 0: 'e' }); this.ss_block = start; this.es_block = this.samplenum;
      const period = this.samplenum - start, ratio = sampleRatio(middle - start, period), percent = ratio * 100;
      this.put(start, this.samplenum, this.out_ann, [PWM_ANN.DUTY_CYCLE, [formatPWMDuty(percent)]]);
      this.put(start, this.samplenum, this.out_binary, [0, Uint8Array.of(Math.trunc(ratio * 256))]);
      const seconds = Number(period) / this.samplerate; this.putPeriod(seconds); this.putFrequency(seconds);
      totalPercent += percent; cycles++;
      this.put(this.first_samplenum, this.es_block, this.out_average, totalPercent / cycles);
    }
  }
}

export class PWMEventEngine implements DecoderEngine<readonly OutputEvent[]> {
  private readonly out: OutputStreams;
  private readonly scan: PWMScanEngine;
  private readonly sink: DecoderEngineContext<PWMOptions>['sink'];
  private readonly sampleRate: number;
  private readonly outAnnual: number;
  private readonly outBinary: number;
  private readonly outAverage: number;
  private events: OutputEvent[] = [];
  private firstSample: bigint | null = null;
  constructor(context: DecoderEngineContext<PWMOptions>) {
    this.sink = context.sink;
    this.sampleRate = context.sampleRate;
    this.out = new OutputStreams({ descriptor: PWMDecoder.descriptor }, { instanceId: context.instanceId, onEvent: event => this.events.push(event) });
    this.outAnnual = this.out.register(OUTPUT_ANN);
    this.outBinary = this.out.register(OUTPUT_BINARY);
    this.outAverage = this.out.register(OUTPUT_META, undefined, ['float', 'Average', 'PWM base (cycle) frequency']);
    this.scan = new PWMScanEngine({ ...context, sink: { write: batch => this.adapt(batch) } });
  }
  private adapt(batch: PWMScanBatch): void {
    for (let index = 0; index < batch.cycles.length; index += 3) {
      const ss = batch.cycles[index]!, es = batch.cycles[index + 1]!, activeSamples = batch.cycles[index + 2]!;
      const periodSamples = typeof es === 'bigint' ? es - (ss as bigint) : es - (ss as number);
      const period = typeof periodSamples === 'bigint' ? periodSamples : BigInt(periodSamples);
      const active = typeof activeSamples === 'bigint' ? activeSamples : BigInt(activeSamples);
      const duty = sampleRatio(active, period) * 100, seconds = Number(period) / this.sampleRate;
      if (this.firstSample === null) this.firstSample = typeof ss === 'bigint' ? ss : BigInt(ss);
      this.out.put(typeof ss === 'bigint' ? ss : BigInt(ss), typeof es === 'bigint' ? es : BigInt(es), this.outAnnual, [PWM_ANN.DUTY_CYCLE, [formatPWMDuty(duty)]]);
      this.out.put(typeof ss === 'bigint' ? ss : BigInt(ss), typeof es === 'bigint' ? es : BigInt(es), this.outBinary, [0, Uint8Array.of(batch.raw[index / 3]!)]);
      this.out.put(typeof ss === 'bigint' ? ss : BigInt(ss), typeof es === 'bigint' ? es : BigInt(es), this.outAnnual, [PWM_ANN.PERIOD, [formatPWMPeriod(seconds)]]);
      this.out.put(typeof ss === 'bigint' ? ss : BigInt(ss), typeof es === 'bigint' ? es : BigInt(es), this.outAnnual, [PWM_ANN.FREQUENCY, [formatPWMFrequency(seconds)]]);
      this.out.put(this.firstSample, typeof es === 'bigint' ? es : BigInt(es), this.outAverage, batch.averages[index / 3]!);
    }
  }
  private async emit(): Promise<void> {
    if (!this.events.length) return;
    const batch = this.events;
    this.events = [];
    await this.sink.write(batch);
  }
  async push(window: import('../../libhakeidecode/index.js').SignalWindow): Promise<void> {
    await this.scan.push(window);
    await this.emit();
  }
  async flush(): Promise<void> { await this.emit(); }
  async finish(): Promise<void> { await this.scan.finish(); await this.emit(); }
  reset(): void { this.scan.reset(); this.events = []; this.firstSample = null; }
  cancel(): void { this.scan.cancel(); this.events = []; }
}

export const pwmPlugin: DecoderPlugin<PWMOptions, readonly OutputEvent[]> = {
  decoder: PWMDecoder,
  descriptor: PWMDecoder.descriptor,
  createEngine: context => new PWMEventEngine(context),
};
registry.registerPlugin(pwmPlugin);
export { PWMScanEngine, createPWMScanEngine } from './engine.js';
export type { PWMScanBatch, PWMPosition } from './engine.js';
