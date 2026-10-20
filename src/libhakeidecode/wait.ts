import { DecodeError } from './errors.js';
import type { ChannelId, Pins, WaitCondition, WaitConditions, WaitPredicate } from './types.js';

export type WaitTerm = { kind: 'skip'; count: bigint; skipped: bigint } | { kind: WaitPredicate; channel: number };
export type CompiledWait = WaitTerm[][];

export class WaitToken {
  constructor(readonly conditions: WaitConditions) {}
}

export function compileWait(token: WaitToken, channelIndex: (id: ChannelId) => number, { firstWait, position }: { firstWait: boolean; position: bigint }): CompiledWait {
  let conditions = token.conditions;
  const emptyObject = conditions && !(conditions instanceof Map) && !Array.isArray(conditions) && Object.keys(conditions).length === 0;
  if (conditions == null || emptyObject || (Array.isArray(conditions) && conditions.length === 0) || (conditions instanceof Map && conditions.size === 0)) {
    conditions = [{ skip: firstWait && position === 0n ? 0 : 1 }];
  }
  const alternatives: readonly WaitCondition[] = Array.isArray(conditions) ? conditions : [conditions as WaitCondition];
  return alternatives.map(condition => {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition) || ArrayBuffer.isView(condition)) throw new DecodeError('wait conditions must be objects or Maps.');
    return [...(condition instanceof Map ? condition.entries() : Object.entries(condition))].map(([key, value]) => {
      if (key === 'skip') {
        if (typeof value !== 'bigint' && !Number.isSafeInteger(value)) throw new DecodeError('skip must be an exact integer.');
        return { kind: 'skip', count: BigInt(value as number | bigint), skipped: 0n };
      }
      const channel = channelIndex(key);
      const kind = value === 0 ? 'l' : value === 1 ? 'h' : value;
      if (!['l', 'h', 'r', 'f', 'e', 'n'].includes(String(kind))) throw new DecodeError(`Unknown wait predicate: ${String(value)}`);
      return { kind: kind as WaitPredicate, channel };
    });
  });
}

export function matchWait(conditions: CompiledWait, pins: Pins, previous: Pins): boolean[] {
  return conditions.map(terms => terms.length > 0 && terms.every(term => {
    if (term.kind === 'skip') {
      if (term.count < 0) return false;
      if (term.skipped === term.count) return true;
      term.skipped += 1n;
      return false;
    }
    if (term.channel < 0 || term.channel >= pins.length) return false;
    const pin = pins[term.channel], old = previous[term.channel];
    if (pin !== 0 && pin !== 1) return false;
    switch (term.kind) {
      case 'l': return pin === 0;
      case 'h': return pin === 1;
      case 'r': return old === 0 && pin === 1;
      case 'f': return old === 1 && pin === 0;
      case 'e': return old !== pin;
      case 'n': return old === pin;
      default: return false;
    }
  }));
}
