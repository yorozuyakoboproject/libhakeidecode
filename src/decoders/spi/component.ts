import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';

function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 4)
    return [
      context.text('decoder.spi.annotation.warning', 'Warning') +
        ': ' +
        warningText(annotation.texts[0] ?? '', context),
    ];
  return annotation.texts;
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
      { id: 'miso-bits', label: 'MISO bits', labelKey: 'decoder.spi.row.miso-bits', classes: [2] },
      { id: 'miso-data-vals', label: 'MISO data', labelKey: 'decoder.spi.row.miso-data-vals', classes: [0] },
      { id: 'miso-transfers', label: 'MISO transfers', labelKey: 'decoder.spi.row.miso-transfers', classes: [5] },
      { id: 'mosi-bits', label: 'MOSI bits', labelKey: 'decoder.spi.row.mosi-bits', classes: [3] },
      { id: 'mosi-data-vals', label: 'MOSI data', labelKey: 'decoder.spi.row.mosi-data-vals', classes: [1] },
      { id: 'mosi-transfers', label: 'MOSI transfers', labelKey: 'decoder.spi.row.mosi-transfers', classes: [6] },
      { id: 'other', label: 'Other', labelKey: 'decoder.spi.row.other', classes: [4] },
    ],
    primaryOptions: ['cpol', 'cpha', 'bitorder', 'wordsize'],
    binaryOutputs: [
      { key: 'mosi', label: 'MOSI', labelKey: 'decoder.spi.binary.mosi' },
      { key: 'miso', label: 'MISO', labelKey: 'decoder.spi.binary.miso' },
    ],
    annotationTexts,
    isErrorClass(classIndex): boolean {
      return classIndex === 4;
    },
  },
} satisfies DecoderDefinition;
