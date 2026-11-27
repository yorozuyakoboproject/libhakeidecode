import { decoderWorkerDefinition } from './workers.js';
import { createSignalWindow } from '../libhakeidecode/signal.js';
import { resultMemory } from './definition.js';
import type {
  Annotation,
  DecodeFrame,
  DecodeGraphHost,
  DecodeGraphNode,
  DecodeGraphResult,
  DecodeResultMemory,
  DecodeRuntime,
} from './definition.js';
import type { OutputEvent, SignalWindow } from '../libhakeidecode/types.js';

interface NodeState {
  readonly spec: DecodeGraphNode;
  readonly runtime: DecodeRuntime;
  readonly inputs: Readonly<Record<string, { instanceId: string; protoId: string }>>;
}

export class DecodeGraphRuntime {
  private readonly nodes = new Map<string, NodeState>();
  private readonly order: NodeState[] = [];
  private readonly roots: NodeState[] = [];
  private readonly children = new Map<string, NodeState[]>();
  private finished = false;

  get frameCount(): number {
    return [...this.nodes.values()].reduce((count, node) => count + node.runtime.frameCount, 0);
  }

  get annotationCount(): number {
    return [...this.nodes.values()].reduce((count, node) => count + node.runtime.annotationCount, 0);
  }

  stats(): readonly {
    id: string;
    decoder: string;
    frames: number;
    annotations: number;
    memory: DecodeResultMemory;
  }[] {
    return [...this.nodes.values()].map((node) => ({
      id: node.spec.id,
      decoder: node.spec.decoder,
      frames: node.runtime.frameCount,
      annotations: node.runtime.annotationCount,
      memory: node.runtime.memory(),
    }));
  }

  memory(): DecodeResultMemory {
    const items = [...this.nodes.values()].map((node) => node.runtime.memory());
    return resultMemory(
      items.reduce((sum, item) => sum + item.annotationsBytes, 0),
      items.reduce((sum, item) => sum + item.framesBytes, 0),
      items.reduce((sum, item) => sum + item.binaryBytes, 0),
    );
  }

  constructor(
    nodes: readonly DecodeGraphNode[],
    {
      sampleRate,
      paged,
      host,
    }: {
      sampleRate: number;
      paged: 'always' | 'auto' | 'never';
      host: DecodeGraphHost;
    },
  ) {
    if (!nodes.length) throw new Error('Protocol graph requires at least one instance');
    const hasChildren = new Set<string>();
    for (const spec of nodes) {
      for (const binding of Object.values(spec.inputs ?? {})) {
        if (binding.instanceId) hasChildren.add(binding.instanceId);
      }
    }
    for (const spec of nodes) {
      if (!spec.id || this.nodes.has(spec.id)) throw new Error('Protocol graph contains duplicate instance IDs');
      const definition = decoderWorkerDefinition(spec.decoder);
      const inputs = spec.inputs ?? {};
      const connections = new Set<string>();
      for (const [key, binding] of Object.entries(inputs)) {
        if (!binding.instanceId || !binding.protoId) throw new Error(`Invalid protocol binding: ${spec.id}/${key}`);
        if (!nodes.some((candidate) => candidate.id === binding.instanceId))
          throw new Error(`Protocol input references a missing instance: ${binding.instanceId}`);
        if (binding.instanceId === spec.id) throw new Error('Protocol graph cannot contain a self-loop');
        const connection = binding.instanceId + '\0' + binding.protoId;
        if (connections.has(connection)) throw new Error('Duplicate protocol connection');
        connections.add(connection);
      }
      if ((definition.mode ?? 'logic') === 'logic') {
        const available = Object.keys(spec.channels ?? {});
        if (!available.length) throw new Error(`Logic decoder has no channel mapping: ${spec.id}`);
      } else {
        if (!Object.keys(inputs).length) throw new Error(`Protocol decoder has no upstream: ${spec.id}`);
        for (const input of definition.inputs ?? [])
          if (input !== 'logic' && !inputs[input])
            throw new Error(`Protocol input is not connected: ${spec.id}/${input}`);
      }
      const runtime = definition.createRuntime({
        instanceId: spec.id,
        sampleRate,
        channels: Object.keys(spec.channels ?? {}),
        options: { ...spec.options },
        paged,
        host: {
          postBatch: (batch) => host.postBatch(spec.id, batch),
          postPaged: (frames, annotations, resultBytes) => host.postPaged(spec.id, frames, annotations, resultBytes),
          retain: (startSample) => {
            const counts = host.retain?.(spec.id, startSample);
            if (!counts) throw new Error('Rolling protocol graph results are unavailable');
            return counts;
          },
        },
        ...(hasChildren.has(spec.id) ? { publish: (event: OutputEvent) => this.dispatch(spec.id, event) } : {}),
      });
      this.nodes.set(spec.id, { spec, runtime, inputs });
    }
    for (const node of this.nodes.values()) {
      const parents = [...new Set(Object.values(node.inputs).map((binding) => binding.instanceId))];
      if (!parents.length) this.roots.push(node);
      for (const parentId of parents) {
        const list = this.children.get(parentId) ?? [];
        list.push(node);
        this.children.set(parentId, list);
      }
    }
    this.order.push(...this.sort());
    this.validateBindings();
  }

  private sort(): NodeState[] {
    const order: NodeState[] = [];
    const remaining = new Set(this.nodes.values());
    while (remaining.size) {
      const next = [...remaining].find((node) =>
        [...new Set(Object.values(node.inputs).map((binding) => binding.instanceId))].every(
          (parent) => !remaining.has(this.nodes.get(parent)!),
        ),
      );
      if (!next) throw new Error('Protocol graph cannot contain cycles');
      remaining.delete(next);
      order.push(next);
    }
    return order;
  }

  private validateBindings(): void {
    for (const node of this.nodes.values()) {
      for (const binding of Object.values(node.inputs)) {
        const parent = this.nodes.get(binding.instanceId)!;
        const outputs = decoderWorkerDefinition(parent.spec.decoder).outputs ?? [];
        if (!outputs.includes(binding.protoId))
          throw new Error(`Protocol output is not available: ${binding.instanceId}/${binding.protoId}`);
      }
    }
  }

  private dispatch(parentId: string, event: OutputEvent): void {
    if (event.type !== 'protocol') return;
    for (const child of this.children.get(parentId) ?? []) {
      const matching = Object.values(child.inputs).filter(
        (binding) => binding.instanceId === parentId && binding.protoId === event.protoId,
      );
      if (!matching.length) continue;
      if (matching.length > 1) throw new Error('Duplicate protocol input binding');
      if (!child.runtime.decodeProtocol) throw new Error(`Decoder cannot accept protocol input: ${child.spec.id}`);
      child.runtime.decodeProtocol(event.ss, event.es, structuredClone(event.data));
    }
  }

  async push(window: SignalWindow, progress: number): Promise<void> {
    if (this.finished) throw new Error('Protocol graph already finished');
    for (const node of this.nodes.values()) node.runtime.observeRange?.(window.startSample, window.endSample);
    for (const root of this.roots) {
      const views: Record<string, NonNullable<ReturnType<SignalWindow['channel']>>> = {};
      for (const [key, channel] of Object.entries(root.spec.channels ?? {})) {
        const view = window.channel(String(channel)) ?? window.channel(key) ?? window.channel(channel);
        if (view) views[key] = view;
      }
      const input = createSignalWindow({
        startSample: window.startSample,
        endSample: window.endSample,
        sampleRate: window.sampleRate,
        channels: views,
      });
      await root.runtime.push(input, progress);
    }
    await this.flush(progress);
  }

  async flush(progress: number): Promise<void> {
    for (const node of this.order) await node.runtime.flush(progress);
  }

  retain(startSample: bigint): void {
    for (const node of this.order) node.runtime.retain?.(startSample);
  }

  async finish(progress: number): Promise<DecodeGraphResult[]> {
    if (this.finished) throw new Error('Protocol graph already finished');
    this.finished = true;
    const results: DecodeGraphResult[] = [];
    for (const node of this.order) {
      const result = await node.runtime.finish(progress);
      results.push({ id: node.spec.id, decoder: node.spec.decoder, result });
    }
    return results.sort((left, right) => left.id.localeCompare(right.id));
  }

  frameCountFor(instanceId: string): number {
    const node = this.nodes.get(instanceId);
    if (!node) throw new Error('Unknown protocol instance: ' + instanceId);
    return node.runtime.frameCount;
  }

  queryAnnotations(instanceId: string, start: bigint, end: bigint, maxResults: number): Annotation[] | null {
    const node = this.nodes.get(instanceId);
    if (!node) throw new Error('Unknown protocol instance: ' + instanceId);
    return node.runtime.queryAnnotations?.(start, end, maxResults) ?? null;
  }

  readFrames(instanceId: string, offset: number, count: number): DecodeFrame[] | null {
    const node = this.nodes.get(instanceId);
    if (!node) throw new Error('Unknown protocol instance: ' + instanceId);
    return node.runtime.readFrames?.(offset, count) ?? null;
  }

  reset(): void {
    if (this.finished) throw new Error('A finished protocol graph cannot be reset');
    for (const node of this.order) node.runtime.reset();
  }
}
