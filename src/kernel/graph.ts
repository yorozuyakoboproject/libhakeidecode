import type { PluginManifest } from './types.js';

export interface GraphPlan {
  readonly order: readonly string[];
  readonly errors: ReadonlyMap<string, string>;
  readonly providers: ReadonlyMap<string, string>;
}

export function resolveProviders(
  manifests: readonly PluginManifest[],
  preferred: Readonly<Record<string, string>>,
  hostServices: ReadonlySet<string>,
): {
  providers: Map<string, string>;
  candidates: Map<string, string[]>;
} {
  const candidates = new Map<string, string[]>();
  const sorted = [...manifests].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  for (const manifest of sorted) {
    for (const service of manifest.provides) {
      if (hostServices.has(service)) continue;
      const list = candidates.get(service) ?? [];
      list.push(manifest.id);
      candidates.set(service, list);
    }
  }
  const providers = new Map<string, string>();
  for (const [service, list] of candidates) {
    const choice = preferred[service];
    providers.set(service, choice && list.includes(choice) ? choice : list[0]!);
  }
  return { providers, candidates };
}

export function planActivation(
  manifests: readonly PluginManifest[],
  preferred: Readonly<Record<string, string>>,
  hostServices: ReadonlySet<string>,
  hostContracts: Readonly<Record<string, number>>,
): GraphPlan {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const { providers } = resolveProviders(manifests, preferred, hostServices);
  const errors = new Map<string, string>();

  const providerContracts = (service: string): number | undefined => {
    if (hostServices.has(service)) return hostContracts[service];
    const providerId = providers.get(service);
    if (!providerId) return undefined;
    return byId.get(providerId)?.contracts[service];
  };

  for (const manifest of manifests) {
    for (const service of manifest.inject) {
      if (!hostServices.has(service) && !providers.has(service)) {
        errors.set(manifest.id, `Missing required service: ${service}`);
        break;
      }
      const requiredContract = manifest.contracts[service];
      const providedContract = providerContracts(service);
      if (requiredContract !== undefined && providedContract !== undefined && requiredContract !== providedContract) {
        errors.set(
          manifest.id,
          `Contract mismatch for service ${service}: requires v${requiredContract}, got v${providedContract}`,
        );
        break;
      }
    }
  }

  const validIds = manifests.filter((m) => !errors.has(m.id)).map((m) => m.id);
  const deps = new Map<string, Set<string>>();
  for (const id of validIds) {
    const manifest = byId.get(id)!;
    const set = new Set<string>();
    for (const service of [...manifest.inject, ...manifest.optional]) {
      if (hostServices.has(service)) continue;
      const providerId = providers.get(service);
      if (providerId && providerId !== id && byId.has(providerId)) {
        if (errors.has(providerId)) {
          if (manifest.inject.includes(service)) {
            errors.set(id, `Required service ${service} provider (${providerId}) failed validation`);
          }
          continue;
        }
        set.add(providerId);
      }
    }
    deps.set(id, set);
  }

  const activeIds = validIds.filter((id) => !errors.has(id));
  const inDegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const id of activeIds) {
    inDegree.set(id, 0);
    edges.set(id, []);
  }
  for (const id of activeIds) {
    for (const dep of deps.get(id) ?? []) {
      if (!inDegree.has(dep)) continue;
      edges.get(dep)!.push(id);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  const compare = (a: string, b: string): number => {
    const ma = byId.get(a)!;
    const mb = byId.get(b)!;
    return ma.order - mb.order || a.localeCompare(b);
  };
  const queue = activeIds.filter((id) => (inDegree.get(id) ?? 0) === 0).sort(compare);
  const order: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    order.push(current);
    for (const next of edges.get(current) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) {
        queue.push(next);
        queue.sort(compare);
      }
    }
  }
  if (order.length < activeIds.length) {
    const placed = new Set(order);
    for (const id of activeIds) {
      if (!placed.has(id)) errors.set(id, 'Plugin dependency cycle detected');
    }
  }
  return { order, errors, providers };
}

export function collectDependents(
  rootIds: readonly string[],
  activeManifests: ReadonlyMap<string, PluginManifest>,
  providers: ReadonlyMap<string, string>,
): string[] {
  const affected = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, manifest] of activeManifests) {
      if (affected.has(id)) continue;
      const usesAffected = [...manifest.inject, ...manifest.optional].some((service) => {
        const provider = providers.get(service);
        return !!provider && affected.has(provider);
      });
      if (usesAffected) {
        affected.add(id);
        changed = true;
      }
    }
  }
  return [...affected];
}
