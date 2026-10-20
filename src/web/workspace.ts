import { sampleIndex, type SampleInput } from '../libhakei/sample-index.js';
import type { DecoderId } from './protocol.js';
import { rowKey, type TimelineRow } from './timeline.js';
export interface ProtocolSettings {
  id: string;
  decoder: DecoderId;
  name: string;
  color: string;
  options: Record<string, string | number>;
  decimalPlaces?: number;
  mapping: { rx?: number; tx?: number; data?: number };
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
}

export function parseWorkspace(value: unknown, channelCount: number, length: bigint): WorkspaceSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid workspace');
  const input = value as WorkspaceSettings;
  const cursor = (v: SampleInput | null): bigint | null => v === null ? null : sampleIndex(v);
  const obj = {...input, cursor: cursor(input.cursor), ...(input.cursorA !== undefined ? {cursorA: cursor(input.cursorA)} : {}), ...(input.cursorB !== undefined ? {cursorB: cursor(input.cursorB)} : {}), viewport: Array.isArray(input.viewport) ? input.viewport.map(v => sampleIndex(v)) : input.viewport} as WorkspaceSettings;
  const index = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) < channelCount;
  if (!Array.isArray(obj.protocols) || obj.protocols.length > 100) throw new Error('Invalid protocol list');
  const ids = new Set<string>();
  const protocols = obj.protocols.map(p => {
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id) || !['uart', 'pwm'].includes(p.decoder)
      || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || !/^#[\da-f]{6}$/i.test(p.color)
      || !p.options || typeof p.options !== 'object' || Array.isArray(p.options)
      || Object.entries(p.options).some(([key, v]) => !/^[a-z_]+$/.test(key) || (typeof v !== 'string' && (typeof v !== 'number' || !Number.isFinite(v))))
      || (p.decimalPlaces !== undefined && (!Number.isInteger(p.decimalPlaces) || p.decimalPlaces < 0 || p.decimalPlaces > 9))
      || !p.mapping || typeof p.mapping !== 'object' || Array.isArray(p.mapping)
      || Object.entries(p.mapping).some(([key, v]) => !['rx', 'tx', 'data'].includes(key) || !index(v))) throw new Error('Invalid protocol settings');
    ids.add(p.id);
    return { ...p, options: { ...p.options }, mapping: { ...p.mapping } };
  });
  if (obj.selectedId !== null && !ids.has(obj.selectedId)) throw new Error('Invalid selected protocol');
  const validCursor = (value: unknown): value is bigint | null => value === null || (typeof value === 'bigint' && value >= 0n && value < length);
  if (!validCursor(obj.cursor)) throw new Error('Invalid cursor');
  if (obj.cursorA !== undefined && !validCursor(obj.cursorA)) throw new Error('Invalid cursor A');
  if (obj.cursorB !== undefined && !validCursor(obj.cursorB)) throw new Error('Invalid cursor B');
  if (!Array.isArray(obj.viewport) || obj.viewport.length !== 2 || !obj.viewport.every(v => typeof v === 'bigint')
    || obj.viewport[0] < 0 || obj.viewport[1] > length || obj.viewport[1] <= obj.viewport[0]) throw new Error('Invalid viewport');
  if (!Array.isArray(obj.channels) || !obj.channels.every(index) || new Set(obj.channels).size !== obj.channels.length) throw new Error('Invalid visible channels');
  const result: WorkspaceSettings = { protocols, selectedId: obj.selectedId, cursor: obj.cursor, viewport: [...obj.viewport], channels: [...obj.channels] };
  if (obj.cursorA !== undefined) result.cursorA = obj.cursorA;
  if (obj.cursorB !== undefined) result.cursorB = obj.cursorB;
  if (obj.rowOrder !== undefined) {
    if (!Array.isArray(obj.rowOrder) || obj.rowOrder.length !== channelCount + protocols.length
      || obj.rowOrder.some(row => !row || (row.kind === 'channel' ? !index(row.id) : row.kind !== 'protocol' || !ids.has(row.id)))
      || new Set(obj.rowOrder.map(rowKey)).size !== obj.rowOrder.length) throw new Error('Invalid timeline row order');
    const visible = new Set(obj.channels);
    const channels = obj.rowOrder.flatMap(row => row.kind === 'channel' && visible.has(row.id) ? [row.id] : []);
    const protocolIds = obj.rowOrder.flatMap(row => row.kind === 'protocol' ? [row.id] : []);
    if (channels.some((id, i) => id !== obj.channels[i]) || protocolIds.some((id, i) => id !== protocols[i].id)) throw new Error('Inconsistent timeline row order');
    result.rowOrder = obj.rowOrder.map(row => ({ ...row }));
  }
  return result;
}
