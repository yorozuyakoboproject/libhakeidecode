import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';

function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 0)
    return [
      context.text('decoder.i2c.annotation.address', 'Address') +
        ': 0x' +
        (annotation.value ?? 0).toString(16).toUpperCase() +
        ' (' +
        ackText(annotation.texts[1], context) +
        ')',
    ];
  if (annotation.classIndex === 1)
    return [
      context.text('decoder.i2c.annotation.data', 'Data') +
        ': 0x' +
        (annotation.value ?? 0).toString(16).padStart(2, '0').toUpperCase() +
        ' (' +
        ackText(annotation.texts[1], context) +
        ')',
    ];
  if (annotation.classIndex === 2)
    return [
      context.text('decoder.i2c.annotation.warning', 'Warning') +
        ': ' +
        warningText(annotation.texts[0] ?? '', context),
    ];
  if (annotation.classIndex === 3)
    return [
      annotation.texts[0] === 'Repeated START'
        ? context.text('decoder.i2c.annotation.repeated-start', 'Repeated START')
        : context.text('decoder.i2c.annotation.start', 'START'),
    ];
  if (annotation.classIndex === 4) return [context.text('decoder.i2c.annotation.stop', 'STOP')];
  return annotation.texts;
}

function ackText(text: string | undefined, context: AnnotationTextContext): string {
  return text === 'NACK'
    ? context.text('decoder.i2c.annotation.nack', 'NACK')
    : context.text('decoder.i2c.annotation.ack', 'ACK');
}

function warningText(text: string, context: AnnotationTextContext): string {
  if (text === 'Incomplete byte discarded at a repeated START')
    return context.text('decoder.i2c.warning.incomplete-repeated-start', text);
  if (text === 'Incomplete byte discarded at STOP') return context.text('decoder.i2c.warning.incomplete-stop', text);
  if (text === 'Incomplete byte discarded at end of capture')
    return context.text('decoder.i2c.warning.incomplete-end', text);
  return text;
}

export const component = {
  descriptor,
  messages,
  ui: {
    description: descriptor.desc,
    descriptionKey: 'decoder.i2c.description',
    inputs: [
      { key: 'scl', label: 'SCL', labelKey: 'decoder.i2c.scl' },
      { key: 'sda', label: 'SDA', labelKey: 'decoder.i2c.sda' },
    ],
    inputRequirement: 'all',
    rows: [
      { label: 'Addresses', labelKey: 'decoder.i2c.annotation.address', classes: [0] },
      { label: 'Data', labelKey: 'decoder.i2c.annotation.data', classes: [1] },
      { label: 'Warnings', labelKey: 'decoder.i2c.annotation.warning', classes: [2] },
      { label: 'Conditions', labelKey: 'decoder.i2c.conditions', classes: [3, 4] },
    ],
    primaryOptions: ['address_format'],
    binaryOutputs: [
      { key: 'address-read', label: 'Address reads', labelKey: 'decoder.i2c.binary.address-read' },
      { key: 'address-write', label: 'Address writes', labelKey: 'decoder.i2c.binary.address-write' },
      { key: 'data-read', label: 'Data reads', labelKey: 'decoder.i2c.binary.data-read' },
      { key: 'data-write', label: 'Data writes', labelKey: 'decoder.i2c.binary.data-write' },
    ],
    annotationTexts,
    isErrorClass(classIndex): boolean {
      return classIndex === 2;
    },
  },
} satisfies DecoderDefinition;
