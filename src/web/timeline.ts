export type TimelineRow =
  | { kind: 'channel'; id: number }
  | { kind: 'analog'; id: number }
  | { kind: 'protocol'; id: string };
export function rowKey(row: TimelineRow): string {
  return row.kind + ':' + row.id;
}

export function reconcileRowOrder(
  order: readonly TimelineRow[],
  channels: readonly number[],
  protocols: readonly string[],
  analogs: readonly number[] = [],
): TimelineRow[] {
  const available: TimelineRow[] = [
    ...channels.map((id) => ({ kind: 'channel' as const, id })),
    ...protocols.map((id) => ({ kind: 'protocol' as const, id })),
    ...analogs.map((id) => ({ kind: 'analog' as const, id })),
  ];
  const valid = new Map(available.map((row) => [rowKey(row), row])),
    seen = new Set<string>();
  return [...order, ...available].flatMap((row) => {
    const key = rowKey(row),
      entry = valid.get(key);
    if (!entry || seen.has(key)) return [];
    seen.add(key);
    return [{ ...entry }];
  });
}

export function moveTimelineRow(order: readonly TimelineRow[], item: TimelineRow, before?: TimelineRow): TimelineRow[] {
  const key = rowKey(item),
    result = order.filter((row) => rowKey(row) !== key);
  const target = before ? result.findIndex((row) => rowKey(row) === rowKey(before)) : result.length;
  result.splice(target < 0 ? result.length : target, 0, { ...item });
  return result;
}
