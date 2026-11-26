import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';

function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 12)
    return [
      context.text('decoder.ir-nec.annotation.warning', 'Warning') +
        ': ' +
        warningText(annotation.texts[0] ?? '', context),
    ];
  if (annotation.classIndex === 10)
    return [context.text('decoder.ir-nec.annotation.repeat', 'Repeat code'), 'Repeat', 'RC', 'R'];
  if (annotation.classIndex === 5)
    return [context.text('decoder.ir-nec.annotation.leader', 'Leader code'), 'Leader', 'LC', 'L'];
  if (annotation.classIndex === 4)
    return [context.text('decoder.ir-nec.annotation.stop-bit', 'Stop bit'), 'Stop', 'St', 'S'];
  if (annotation.classIndex === 1) return [context.text('decoder.ir-nec.annotation.agc', 'AGC pulse'), 'AGC', 'A'];
  return annotation.texts;
}

function warningText(text: string, context: AnnotationTextContext): string {
  const keys: Record<string, string> = {
    'Interrupted by an idle period': 'decoder.ir-nec.warning.idle',
    'Unexpected IR mark duration': 'decoder.ir-nec.warning.unexpected-mark',
    'Invalid NEC leader space': 'decoder.ir-nec.warning.leader-space',
    'Invalid NEC bit mark': 'decoder.ir-nec.warning.bit-mark',
    'Invalid NEC bit space': 'decoder.ir-nec.warning.bit-space',
    'Automatic polarity detection failed': 'decoder.ir-nec.warning.polarity',
    'Incomplete NEC frame discarded at end of capture': 'decoder.ir-nec.warning.incomplete',
  };
  const key = keys[text];
  return key ? context.text(key, text) : text;
}

export const component = {
  descriptor,
  messages,
  ui: {
    description: descriptor.desc,
    descriptionKey: 'decoder.ir-nec.description',
    inputs: [{ key: 'ir', label: 'IR', labelKey: 'decoder.ir-nec.ir' }],
    inputRequirement: 'all',
    rows: [
      { id: 'bits', label: 'Bits', labelKey: 'decoder.ir-nec.row.bits', classes: [0, 1, 2, 3, 4] },
      { id: 'fields', label: 'Fields', labelKey: 'decoder.ir-nec.row.fields', classes: [5, 6, 7, 8, 9, 10] },
      { id: 'remote-vals', label: 'Remote', labelKey: 'decoder.ir-nec.row.remote-vals', classes: [11] },
      { id: 'warnings', label: 'Warnings', labelKey: 'decoder.ir-nec.row.warnings', classes: [12] },
    ],
    primaryOptions: ['polarity', 'extended'],
    edgeInput: 'ir',
    annotationTexts,
    isErrorClass(classIndex): boolean {
      return classIndex === 12;
    },
  },
} satisfies DecoderDefinition;
