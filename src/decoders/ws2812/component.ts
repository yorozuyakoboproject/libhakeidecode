import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';

function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 1)
    return [
      context
        .text('decoder.ws2812.annotation.incomplete', 'Incomplete pixel ({bits} bits)')
        .replace('{bits}', String(annotation.value ?? 0)),
    ];
  return [
    context.text('decoder.ws2812.annotation.pixel', 'Pixel') +
      ' ' +
      (annotation.texts[1] ?? '') +
      (annotation.texts[2] ? ': ' + annotation.texts[2] : ''),
  ];
}

export const component = {
  descriptor,
  messages,
  ui: {
    description: descriptor.desc,
    descriptionKey: 'decoder.ws2812.description',
    inputs: [{ key: 'din', label: 'DIN', labelKey: 'decoder.ws2812.din' }],
    inputRequirement: 'all',
    rows: [
      { label: 'Pixels', labelKey: 'decoder.ws2812.annotation.pixel', classes: [0] },
      { label: 'Warnings', labelKey: 'decoder.ws2812.annotation.warning', classes: [1] },
    ],
    primaryOptions: ['wireorder', 'textorder'],
    edgeInput: 'din',
    annotationTexts,
    isErrorClass(classIndex): boolean {
      return classIndex === 1;
    },
  },
} satisfies DecoderDefinition;
