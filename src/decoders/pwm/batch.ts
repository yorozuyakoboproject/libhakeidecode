import { sampleRatio } from '../../libhakei/sample-index.js';
import { formatPWMDuty, formatPWMFrequency, formatPWMPeriod } from './format.js';
import type { PWMScanBatch } from './engine.js';

export interface PWMBatchAnnotation { ss: bigint; es: bigint; classIndex: number; texts: readonly string[]; value?: number }
export interface PWMBatchFrame {
  ss: bigint; es: bigint; activeSamples: bigint; periodSamples: bigint;
  dutyCycle: number; periodSeconds: number; frequencyHz: number; averageDutyCycle: number;
}
export interface PWMBatchMessage { type: 'batch'; progress: number; frames: PWMBatchFrame[]; annotations: PWMBatchAnnotation[] }
export type PWMBatchSource = Pick<PWMScanBatch, 'cycles' | 'averages'> & { progress: number; annotations: number };

export function createPWMBatchReader(sampleRate: number): (message: PWMBatchSource) => PWMBatchMessage {
  const texts = new Map<bigint, Map<bigint, readonly (readonly string[])[]>>(); let cached = 0;
  return message => {
    const frames: PWMBatchFrame[] = [], annotations: PWMBatchAnnotation[] = []; let remaining = message.annotations;
    for (let index = 0; index < message.cycles.length; index += 3) {
      const rawSs = message.cycles[index]!, rawEs = message.cycles[index + 1]!, rawActive = message.cycles[index + 2];
      const ss = typeof rawSs === 'bigint' ? rawSs : BigInt(rawSs);
      const es = typeof rawEs === 'bigint' ? rawEs : BigInt(rawEs);
      const activeSamples = typeof rawActive === 'bigint' ? rawActive : BigInt(rawActive!);
      const averageDutyCycle = message.averages[index / 3]!;
      const periodSamples = es - ss, dutyCycle = sampleRatio(activeSamples, periodSamples) * 100, periodSeconds = Number(periodSamples) / sampleRate;
      frames.push({ ss, es, activeSamples, periodSamples, dutyCycle, periodSeconds, frequencyHz: sampleRate / Number(periodSamples), averageDutyCycle });
      if (remaining > 0) {
        let periodTexts = texts.get(periodSamples), cycleTexts = periodTexts?.get(activeSamples);
        if (!cycleTexts) {
          if (cached === 4096) { texts.clear(); cached = 0; periodTexts = undefined; }
          cycleTexts = [Object.freeze([formatPWMDuty(dutyCycle)]), Object.freeze([formatPWMPeriod(periodSeconds)]), Object.freeze([formatPWMFrequency(periodSeconds)])];
          if (!periodTexts) { periodTexts = new Map(); texts.set(periodSamples, periodTexts); }
          periodTexts.set(activeSamples, cycleTexts); cached++;
        }
        for (let classIndex = 0; classIndex < 3 && remaining > 0; classIndex++, remaining--)
          annotations.push({ ss, es, classIndex, texts: cycleTexts[classIndex]!, value: classIndex === 0 ? dutyCycle : classIndex === 1 ? periodSeconds : sampleRate / Number(periodSamples) });
      }
    }
    return { type: 'batch', progress: message.progress, frames, annotations };
  };
}
