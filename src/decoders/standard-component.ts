import type { DecoderDescriptor } from '../libhakeidecode/types.js';
import type { DecoderInputDefinition, DecoderUiDefinition } from './definition.js';

export function standardUi(descriptor: DecoderDescriptor): DecoderUiDefinition {
  const inputs: DecoderInputDefinition[] = [
    ...(descriptor.channels ?? []).map((channel) => ({
      key: channel.id,
      label: channel.name ?? channel.id,
      labelKey: `decoder.${descriptor.id}.channel.${channel.id}`,
    })),
    ...(descriptor.optionalChannels ?? []).map((channel) => ({
      key: channel.id,
      label: channel.name ?? channel.id,
      labelKey: `decoder.${descriptor.id}.channel.${channel.id}`,
      optional: true,
    })),
    ...(descriptor.inputs ?? [])
      .filter((input) => input !== 'logic')
      .map((input) => ({
        key: input,
        label: input.toUpperCase(),
        kind: 'protocol' as const,
      })),
  ];
  const rows = descriptor.annotationRows?.length
    ? descriptor.annotationRows.map((row, index) => ({
        id: row[0],
        label: row[1],
        labelKey: `decoder.${descriptor.id}.row.${index}`,
        classes: row[2],
      }))
    : [
        {
          id: 'annotations',
          label: 'Annotations',
          labelKey: `decoder.${descriptor.id}.row.default`,
          classes: (descriptor.annotations ?? []).map((_, index) => index),
        },
      ];
  return {
    description: descriptor.desc,
    descriptionKey: `decoder.${descriptor.id}.description`,
    inputs,
    inputRequirement: 'all',
    rows,
    primaryOptions: optionIds(descriptor),
    binaryOutputs: (descriptor.binary ?? []).map((item, index) => ({
      key: item[0],
      label: item[1],
      labelKey: `decoder.${descriptor.id}.binary.${index}`,
    })),
    isErrorClass(classIndex): boolean {
      return /(?:warn|error|fail|invalid|alert)/i.test(descriptor.annotations?.[classIndex]?.[0] ?? '');
    },
  };
}

function optionIds(descriptor: DecoderDescriptor): string[] {
  const options = descriptor.options;
  if (!options) return [];
  return Array.isArray(options) ? options.map((option) => option.id) : Object.keys(options);
}
