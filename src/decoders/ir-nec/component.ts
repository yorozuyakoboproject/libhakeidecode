import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';

function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 0) {
    const value = annotation.value ?? 0;
    return [
      (annotation.texts[0] === 'Invalid NEC frame'
        ? context.text('decoder.ir-nec.annotation.invalid-frame', 'Invalid NEC frame')
        : context.text('decoder.ir-nec.annotation.frame', 'Frame')) +
        ': 0x' +
        value.toString(16).padStart(8, '0').toUpperCase(),
    ];
  }
  if (annotation.classIndex === 1) return [context.text('decoder.ir-nec.annotation.repeat', 'Repeat')];
  return [
    context.text('decoder.ir-nec.annotation.warning', 'Warning') +
      ': ' +
      warningText(annotation.texts[0] ?? '', context),
  ];
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
      { label: 'Frames', labelKey: 'decoder.ir-nec.annotation.frame', classes: [0, 1] },
      { label: 'Warnings', labelKey: 'decoder.ir-nec.annotation.warning', classes: [2] },
    ],
    primaryOptions: ['polarity', 'extended'],
    edgeInput: 'ir',
    annotationTexts,
    isErrorClass(classIndex): boolean {
      return classIndex === 2;
    },
  },
} satisfies DecoderDefinition;
