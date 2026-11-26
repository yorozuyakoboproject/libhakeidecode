import type { Annotation, AnnotationTextContext, DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';

function hexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function annotationTexts(annotation: Annotation, context: AnnotationTextContext): readonly string[] {
  if (annotation.classIndex === 0) return [context.text('decoder.i2c.annotation.start', 'START'), 'S'];
  if (annotation.classIndex === 1)
    return [context.text('decoder.i2c.annotation.repeated-start', 'Repeated START'), 'Sr'];
  if (annotation.classIndex === 2) return [context.text('decoder.i2c.annotation.stop', 'STOP'), 'P'];
  if (annotation.classIndex === 3) return [context.text('decoder.i2c.annotation.ack', 'ACK'), 'A'];
  if (annotation.classIndex === 4) return [context.text('decoder.i2c.annotation.nack', 'NACK'), 'N'];
  if (annotation.classIndex === 6 || annotation.classIndex === 7) {
    const rw = annotation.texts[0];
    if (rw === 'Read' || rw === 'Write') {
      const label = context.text(
        rw === 'Read' ? 'decoder.i2c.annotation.rw-read' : 'decoder.i2c.annotation.rw-write',
        rw,
      );
      return [label, ...annotation.texts.slice(1)];
    }
    const hex = hexByte(annotation.value ?? 0);
    const prefix = context.text(
      annotation.classIndex === 6 ? 'decoder.i2c.annotation.address-read' : 'decoder.i2c.annotation.address-write',
      annotation.classIndex === 6 ? 'Address read' : 'Address write',
    );
    const short = annotation.classIndex === 6 ? 'AR' : 'AW';
    return [`${prefix}: ${hex}`, `${short}: ${hex}`, hex];
  }
  if (annotation.classIndex === 8 || annotation.classIndex === 9) {
    const hex = hexByte(annotation.value ?? 0);
    const prefix = context.text(
      annotation.classIndex === 8 ? 'decoder.i2c.annotation.data-read' : 'decoder.i2c.annotation.data-write',
      annotation.classIndex === 8 ? 'Data read' : 'Data write',
    );
    const short = annotation.classIndex === 8 ? 'DR' : 'DW';
    return [`${prefix}: ${hex}`, `${short}: ${hex}`, hex];
  }
  if (annotation.classIndex === 10)
    return [
      context.text('decoder.i2c.annotation.warning', 'Warning') +
        ': ' +
        warningText(annotation.texts[0] ?? '', context),
    ];
  return annotation.texts;
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
      { id: 'bits', label: 'Bits', labelKey: 'decoder.i2c.row.bits', classes: [5] },
      {
        id: 'addr-data',
        label: 'Address/data',
        labelKey: 'decoder.i2c.row.addr-data',
        classes: [0, 1, 2, 3, 4, 6, 7, 8, 9],
      },
      { id: 'warnings', label: 'Warnings', labelKey: 'decoder.i2c.row.warnings', classes: [10] },
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
      return classIndex === 10;
    },
  },
} satisfies DecoderDefinition;
