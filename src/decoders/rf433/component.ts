import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';

function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 1)
    return [
      context.text('decoder.rf433.annotation.warning', 'Warning') +
        ': ' +
        warningText(annotation.texts[0] ?? '', context),
    ];
  const label =
    annotation.texts[0] === 'Invalid RF packet'
      ? context.text('decoder.rf433.annotation.invalid-frame', 'Invalid RF packet')
      : context.text('decoder.rf433.annotation.frame', 'Frame');
  return [label + ': 0x' + (annotation.texts[1] ?? '0')];
}

function warningText(text: string, context: AnnotationTextContext): string {
  if (text === 'Incomplete RF packet discarded during resynchronization')
    return context.text('decoder.rf433.warning.resync', text);
  if (text === 'Invalid RF pulse rejected') return context.text('decoder.rf433.warning.invalid-pulse', text);
  if (text === 'Incomplete RF packet discarded at end of capture')
    return context.text('decoder.rf433.warning.incomplete', text);
  return text;
}

export const component = {
  descriptor,
  messages,
  ui: {
    description: descriptor.desc,
    descriptionKey: 'decoder.rf433.description',
    inputs: [{ key: 'data', label: 'DATA', labelKey: 'decoder.rf433.data' }],
    inputRequirement: 'all',
    rows: [
      { id: 'frames', label: 'Frames', labelKey: 'decoder.rf433.annotation.frame', classes: [0] },
      { id: 'warnings', label: 'Warnings', labelKey: 'decoder.rf433.annotation.warning', classes: [1] },
    ],
    primaryOptions: ['encoding'],
    edgeInput: 'data',
    annotationTexts,
    isErrorClass(classIndex): boolean {
      return classIndex === 1;
    },
  },
} satisfies DecoderDefinition;
