import { sampleIndex, type SampleInput } from '../libhakei/sample-index.js';
import { decoderDefinition } from '../decoders/index.js';
import type { OptionValue } from '../libhakeidecode/index.js';
import type { ProtocolBinding } from '../decoders/definition.js';
import { rowKey, type TimelineRow } from './timeline.js';
import { parseAnalogSettings, type AnalogSettings } from './analog-settings.js';
export type ProtocolMappingValue = number | ProtocolBinding;
export interface ProtocolSettings {
  id: string;
  decoder: string;
  name: string;
  color: string;
  options: Record<string, OptionValue>;
  decimalPlaces?: number;
  mapping: Record<string, ProtocolMappingValue>;
}
export interface WorkspaceSettings {
  protocols: ProtocolSettings[];
  selectedId: string | null;
  cursor: bigint | null;
  cursorA?: bigint | null;
  cursorB?: bigint | null;
  viewport: [bigint, bigint];
  channels: number[];
  rowOrder?: TimelineRow[];
  channelNames?: { digital: string[]; analog: string[] };
  analogChannels?: number[];
  analogSettings?: AnalogSettings[];
  digitalHeights?: number[];
}

export function parseWorkspace(
  value: unknown,
  channelCount: number,
  length: bigint,
  analogCount = 0,
): WorkspaceSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid workspace');
  const input = value as WorkspaceSettings;
  const cursor = (v: SampleInput | null): bigint | null => (v === null ? null : sampleIndex(v));
  const obj = {
    ...input,
    cursor: cursor(input.cursor),
    ...(input.cursorA !== undefined ? { cursorA: cursor(input.cursorA) } : {}),
    ...(input.cursorB !== undefined ? { cursorB: cursor(input.cursorB) } : {}),
    viewport: Array.isArray(input.viewport) ? input.viewport.map((v) => sampleIndex(v)) : input.viewport,
  } as WorkspaceSettings;
  const index = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) < channelCount;
  if (!Array.isArray(obj.protocols) || obj.protocols.length > 100) throw new Error('Invalid protocol list');
  const parsed = obj.protocols.map((p) => {
    if (
      !p ||
      typeof p.id !== 'string' ||
      !p.id ||
      typeof p.decoder !== 'string' ||
      !p.decoder ||
      typeof p.name !== 'string' ||
      !p.name.trim() ||
      p.name.length > 80 ||
      !/^#[\da-f]{6}$/i.test(p.color) ||
      !p.options ||
      typeof p.options !== 'object' ||
      Array.isArray(p.options) ||
      Object.entries(p.options).some(
        ([key, v]) =>
          !/^[a-z_]+$/.test(key) ||
          !(typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))),
      ) ||
      (p.decimalPlaces !== undefined &&
        (!Number.isInteger(p.decimalPlaces) || p.decimalPlaces < 0 || p.decimalPlaces > 9)) ||
      !p.mapping ||
      typeof p.mapping !== 'object' ||
      Array.isArray(p.mapping)
    )
      throw new Error('Invalid protocol settings');
    try {
      decoderDefinition(p.decoder);
    } catch {
      throw new Error('Invalid protocol settings');
    }
    return p;
  });
  const ids = new Set<string>();
  for (const protocol of parsed) {
    if (ids.has(protocol.id)) throw new Error('Invalid protocol settings');
    ids.add(protocol.id);
  }
  const protocols = parsed.map((p) => {
    const inputs = new Map(decoderDefinition(p.decoder).ui.inputs.map((input) => [input.key, input]));
    const mapping = Object.fromEntries(
      Object.entries(p.mapping).map(([key, value]) => {
        const input = inputs.get(key);
        if (!input) throw new Error('Invalid protocol settings');
        if (input.kind === 'protocol') {
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            typeof value.instanceId !== 'string' ||
            !value.instanceId ||
            typeof value.protoId !== 'string' ||
            !value.protoId
          )
            throw new Error('Invalid protocol connection');
          return [key, { instanceId: value.instanceId, protoId: value.protoId }];
        }
        if (!index(value)) throw new Error('Invalid protocol settings');
        return [key, Number(value)];
      }),
    );
    return { ...p, options: { ...p.options }, mapping };
  });
  validateProtocolGraph(protocols, false);
  if (obj.selectedId !== null && !ids.has(obj.selectedId)) throw new Error('Invalid selected protocol');
  const validCursor = (value: unknown): value is bigint | null =>
    value === null || (typeof value === 'bigint' && value >= 0n && value < length);
  if (!validCursor(obj.cursor)) throw new Error('Invalid cursor');
  if (obj.cursorA !== undefined && !validCursor(obj.cursorA)) throw new Error('Invalid cursor A');
  if (obj.cursorB !== undefined && !validCursor(obj.cursorB)) throw new Error('Invalid cursor B');
  if (
    !Array.isArray(obj.viewport) ||
    obj.viewport.length !== 2 ||
    !obj.viewport.every((v) => typeof v === 'bigint') ||
    obj.viewport[0] < 0 ||
    obj.viewport[1] > length ||
    obj.viewport[1] <= obj.viewport[0]
  )
    throw new Error('Invalid viewport');
  if (!Array.isArray(obj.channels) || !obj.channels.every(index) || new Set(obj.channels).size !== obj.channels.length)
    throw new Error('Invalid visible channels');
  const result: WorkspaceSettings = {
    protocols,
    selectedId: obj.selectedId,
    cursor: obj.cursor,
    viewport: [...obj.viewport],
    channels: [...obj.channels],
  };
  if (obj.cursorA !== undefined) result.cursorA = obj.cursorA;
  if (obj.cursorB !== undefined) result.cursorB = obj.cursorB;
  if (obj.rowOrder !== undefined) {
    const hasAnalog = Array.isArray(obj.rowOrder) && obj.rowOrder.some((row) => row?.kind === 'analog');
    if (
      !Array.isArray(obj.rowOrder) ||
      obj.rowOrder.length !== channelCount + protocols.length + (hasAnalog ? analogCount : 0) ||
      obj.rowOrder.some(
        (row) =>
          !row ||
          (row.kind === 'channel'
            ? !index(row.id)
            : row.kind === 'analog'
              ? !Number.isInteger(row.id) || row.id < 0 || row.id >= analogCount
              : row.kind !== 'protocol' || !ids.has(row.id)),
      ) ||
      new Set(obj.rowOrder.map(rowKey)).size !== obj.rowOrder.length
    )
      throw new Error('Invalid timeline row order');
    const visible = new Set(obj.channels);
    const channels = obj.rowOrder.flatMap((row) => (row.kind === 'channel' && visible.has(row.id) ? [row.id] : []));
    const protocolIds = obj.rowOrder.flatMap((row) => (row.kind === 'protocol' ? [row.id] : []));
    if (channels.some((id, i) => id !== obj.channels[i]) || protocolIds.some((id, i) => id !== protocols[i].id))
      throw new Error('Inconsistent timeline row order');
    result.rowOrder = obj.rowOrder.map((row) => ({ ...row }));
  }
  if (obj.analogChannels !== undefined) {
    if (
      !Array.isArray(obj.analogChannels) ||
      obj.analogChannels.some((id) => !Number.isInteger(id) || id < 0 || id >= analogCount) ||
      new Set(obj.analogChannels).size !== obj.analogChannels.length
    )
      throw new Error('Invalid visible analog channels');
    result.analogChannels = [...obj.analogChannels];
  }
  if (obj.analogSettings !== undefined) {
    if (!Array.isArray(obj.analogSettings) || obj.analogSettings.length !== analogCount)
      throw new Error('Invalid analog channel settings');
    result.analogSettings = obj.analogSettings.map(parseAnalogSettings);
  }
  if (obj.digitalHeights !== undefined) {
    if (
      !Array.isArray(obj.digitalHeights) ||
      obj.digitalHeights.length !== channelCount ||
      obj.digitalHeights.some((height) => !Number.isInteger(height) || height < 12 || height > 250)
    )
      throw new Error('Invalid digital channel heights');
    result.digitalHeights = [...obj.digitalHeights];
  }
  if (obj.channelNames !== undefined) {
    const names = obj.channelNames,
      validNames = (items: unknown): items is string[] =>
        Array.isArray(items) && items.every((name) => typeof name === 'string' && name.trim() && name.length <= 80);
    if (
      !names ||
      !validNames(names.digital) ||
      names.digital.length !== channelCount ||
      !validNames(names.analog) ||
      names.analog.length > 128
    )
      throw new Error('Invalid channel names');
    result.channelNames = { digital: [...names.digital], analog: [...names.analog] };
  }
  return result;
}

export function validateProtocolGraph(protocols: readonly ProtocolSettings[], requireComplete = true): void {
  const byId = new Map(protocols.map((protocol) => [protocol.id, protocol]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (protocol: ProtocolSettings): void => {
    if (visited.has(protocol.id)) return;
    if (visiting.has(protocol.id)) throw new Error('Protocol graph cannot contain cycles');
    visiting.add(protocol.id);
    const inputs = decoderDefinition(protocol.decoder).ui.inputs;
    const seen = new Set<string>();
    for (const input of inputs) {
      if (input.kind !== 'protocol') continue;
      const value = protocol.mapping[input.key];
      if (value === undefined) {
        if (requireComplete) throw new Error('Protocol input is not connected');
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('instanceId' in value))
        throw new Error('Invalid protocol connection');
      const parent = byId.get(value.instanceId);
      if (!parent) throw new Error('Protocol input references a missing upstream');
      if (parent.id === protocol.id) throw new Error('Protocol graph cannot contain self-loops');
      const outputs = decoderDefinition(parent.decoder).descriptor.outputs ?? [];
      if (!outputs.includes(value.protoId)) throw new Error('Protocol input type does not match upstream output');
      const key = parent.id + '\0' + value.protoId;
      if (seen.has(key)) throw new Error('Duplicate protocol connection');
      seen.add(key);
      visit(parent);
    }
    visiting.delete(protocol.id);
    visited.add(protocol.id);
  };
  for (const protocol of protocols) visit(protocol);
}
