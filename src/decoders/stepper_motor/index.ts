import { descriptor } from './descriptor.js';
import { Decoder, generatorPlugin, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator } from '../../libhakeidecode/index.js';

export interface StepperMotorOptions {
  unit: string;
  steps_per_mm: number;
}

export const STEPPER_ANN = Object.freeze({
  SPEED: 0,
  POSITION: 1,
});

export function formatStepper(value: number, decimals: 0 | 2): string {
  return value.toFixed(decimals);
}

export class StepperMotorDecoder extends Decoder<StepperMotorOptions> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outAnn = -1;
  private previousStep: bigint | null = null;
  private position = 0;
  private scale = 1;
  private unit = 'steps';
  private decimals: 0 | 2 = 0;

  constructor(options: Partial<StepperMotorOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.previousStep = null;
    this.position = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    if (this.options.unit === 'steps') {
      this.scale = 1;
      this.unit = 'steps';
      this.decimals = 0;
    } else {
      this.scale = this.options.steps_per_mm;
      this.unit = 'mm';
      this.decimals = 2;
    }
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private step(ss: bigint, direction: number): void {
    if (this.previousStep !== null) {
      const previous = this.previousStep;
      if (this.samplerate) {
        const speed = this.samplerate / Number(ss - previous) / this.scale;
        const text = formatStepper(speed, this.decimals);
        this.put(previous, ss, this.outAnn, [STEPPER_ANN.SPEED, [`${text} ${this.unit}/s`, text]]);
      }
      const text = formatStepper(this.position / this.scale, this.decimals);
      this.put(previous, ss, this.outAnn, [STEPPER_ANN.POSITION, [`${text} ${this.unit}`, text]]);
    }
    this.position += direction ? 1 : -1;
    this.previousStep = ss;
  }

  *decode(): LogicGenerator {
    while (true) {
      yield this.wait({ step: 'r' });
      const direction = this.channelValue('dir');
      if (direction !== 0 && direction !== 1) throw new Error('Stepper direction input is unavailable.');
      this.step(this.samplenum, direction);
    }
  }
}

export const stepperMotorPlugin: DecoderPlugin<any, any> = {
  decoder: StepperMotorDecoder,
  descriptor,
  createEngine: (context) => generatorPlugin(StepperMotorDecoder).createEngine(context),
};

export default StepperMotorDecoder;
