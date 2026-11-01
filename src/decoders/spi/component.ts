import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';

function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 1)
    return [
      context.text('decoder.spi.annotation.warning', 'Warning') +
        ': ' +
        warningText(annotation.texts[0] ?? '', context),
    ];
  const index = annotation.texts[1],
    details = annotation.texts.slice(2);
  return [
    context.text('decoder.spi.annotation.word', 'Word') +
      (index === undefined ? '' : ' ' + index) +
      (details.length ? ': ' + details.join(' ') : ''),
  ];
}

function warningText(text: string, context: AnnotationTextContext): string {
  const prefix = 'Chip select deasserted: ';
  if (text.startsWith(prefix))
    return context
      .text('decoder.spi.warning.cs-deasserted', 'Chip select deasserted: {bits} bit(s) discarded')
      .replace('{bits}', text.slice(prefix.length).replace(' bit(s) discarded', ''));
  const endPrefix = 'End of capture: ';
  if (text.startsWith(endPrefix))
    return context
      .text('decoder.spi.warning.end', 'End of capture: {bits} bit(s) discarded')
      .replace('{bits}', text.slice(endPrefix.length).replace(' bit(s) discarded', ''));
  return text;
}

export const component = {
  descriptor,
  messages,
  ui: {
    description: descriptor.desc,
    descriptionKey: 'decoder.spi.description',
    inputs: [
      { key: 'clk', label: 'CLK', labelKey: 'decoder.spi.clk' },
      { key: 'miso', label: 'MISO', labelKey: 'decoder.spi.miso', optional: true },
      { key: 'mosi', label: 'MOSI', labelKey: 'decoder.spi.mosi', optional: true },
      { key: 'cs', label: 'CS', labelKey: 'decoder.spi.cs', optional: true },
    ],
    inputRequirement: 'all',
    rows: [
      { label: 'Words', labelKey: 'decoder.spi.annotation.word', classes: [0] },
      { label: 'Warnings', labelKey: 'decoder.spi.annotation.warning', classes: [1] },
    ],
    primaryOptions: ['cpol', 'cpha', 'bitorder', 'wordsize'],
    binaryOutputs: [
      { key: 'mosi', label: 'MOSI', labelKey: 'decoder.spi.binary.mosi' },
      { key: 'miso', label: 'MISO', labelKey: 'decoder.spi.binary.miso' },
    ],
    annotationTexts,
    isErrorClass(classIndex): boolean {
      return classIndex === 1;
    },
  },
} satisfies DecoderDefinition;
