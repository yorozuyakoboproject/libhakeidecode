import { sampleRatio } from '../libhakei/sample-index.js';
import { formatPWMDuty, formatPWMPeriod, formatPWMFrequency } from '../decoders/pwm.js';
import type { Annotation, PWMFrame, PackedPWMBatch, DecodeMessage } from './protocol.js';

export function createPWMBatchReader(sampleRate: number): (message: PackedPWMBatch) => Extract<DecodeMessage, { type: 'batch' }> {
  const texts = new Map<bigint, Map<bigint, readonly (readonly string[])[]>>(); let cached = 0;
  return message => {
    const frames: PWMFrame[] = [], annotations: Annotation[] = []; let remaining = message.annotations;
    for (let i = 0; i < message.cycles.length; i += 3) {
      const rawSs = message.cycles[i]!, rawEs = message.cycles[i + 1]!, rawActive = message.cycles[i + 2];
      const ss = typeof rawSs === 'bigint' ? rawSs : BigInt(rawSs);
      const es = typeof rawEs === 'bigint' ? rawEs : BigInt(rawEs);
      const activeSamples = typeof rawActive === 'bigint' ? rawActive : BigInt(rawActive);
      const averageDutyCycle = message.averages[i / 3];
      const periodSamples = es - ss, dutyCycle = sampleRatio(activeSamples, periodSamples) * 100, periodSeconds = Number(periodSamples) / sampleRate;
      frames.push({ protocol: 'pwm', ss, es, activeSamples, periodSamples, dutyCycle, periodSeconds, frequencyHz: sampleRate / Number(periodSamples), averageDutyCycle });
      if (remaining > 0) {
        let periodTexts = texts.get(periodSamples), cycleTexts = periodTexts?.get(activeSamples);
        if (!cycleTexts) {
          if (cached === 4096) { texts.clear(); cached = 0; periodTexts = undefined; }
          cycleTexts = [Object.freeze([formatPWMDuty(dutyCycle)]), Object.freeze([formatPWMPeriod(periodSeconds)]), Object.freeze([formatPWMFrequency(periodSeconds)])];
          if (!periodTexts) { periodTexts = new Map(); texts.set(periodSamples, periodTexts); }
          periodTexts.set(activeSamples, cycleTexts); cached++;
        }
        for (let classIndex = 0; classIndex < 3 && remaining > 0; classIndex++, remaining--)
          annotations.push({ ss, es, classIndex, texts: cycleTexts[classIndex], value: classIndex === 0 ? dutyCycle : classIndex === 1 ? periodSeconds : sampleRate / Number(periodSamples) });
      }
    }
    return { type: 'batch', progress: message.progress, frames, annotations };
  };
}
