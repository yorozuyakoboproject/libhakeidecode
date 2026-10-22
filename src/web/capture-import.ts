import { sampleIndex, type SampleInput } from '../libhakei/sample-index.js';
import { PlanarSampleStore } from './data/planarStore.js';
import { RleSampleStore, type RleChannelData } from './data/rleStore.js';
import type { GapSpan } from './data/types.js';
import type { ChannelCount } from './data/channel-count.js';
import { UIError } from './i18n.js';
import { Transpose32Pipeline } from './transpose32-pipeline.js';
import type { AcquisitionResult, Capture, CaptureImportPipelineOptions } from './capture.js';

export function validRate(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new UIError('error.rate');
  return n;
}
export function validWidth(n: number): ChannelCount {
  if (![4, 8, 16, 32].includes(n)) throw new UIError('error.width');
  return n as ChannelCount;
}

export function parseAcquisitionResult(value: unknown, length: bigint): AcquisitionResult | undefined {
  if (value === undefined) return undefined;
  const source = value as AcquisitionResult;
  const result = source && {
    ...source,
    targetSamples: sampleIndex(source.targetSamples),
    actualSamples: sampleIndex(source.actualSamples),
  };
  if (
    !result ||
    result.targetSamples < length ||
    result.actualSamples !== length ||
    !['complete', 'stopped', 'budget', 'allocation-failed', 'store-limit', 'error'].includes(result.stopReason) ||
    (result.stopReason === 'complete' && result.targetSamples !== length) ||
    !result.memory ||
    ![result.memory.limitBytes, result.memory.usedBytes, result.memory.peakBytes, result.memory.allocations].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    result.memory.usedBytes > result.memory.peakBytes ||
    result.memory.peakBytes > result.memory.limitBytes ||
    typeof result.worker !== 'boolean' ||
    !Number.isInteger(result.buffers) ||
    result.buffers < 1 ||
    result.buffers > 3 ||
    !Number.isInteger(result.maxQueued) ||
    result.maxQueued < 0 ||
    result.maxQueued > result.buffers ||
    (result.error !== undefined && typeof result.error !== 'string')
  )
    throw new Error('Invalid acquisition metadata');
  return {
    targetSamples: result.targetSamples,
    actualSamples: result.actualSamples,
    stopReason: result.stopReason,
    memory: { ...result.memory },
    worker: result.worker,
    buffers: result.buffers,
    maxQueued: result.maxQueued,
    ...(result.error ? { error: result.error.slice(0, 4096) } : {}),
  };
}
export function parseCapture(text: string, name = 'capture.hakei.json'): Capture {
  const t = performance.now();
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new UIError('error.json');
  }
  if (!obj || !['libhakei.capture/v1', 'libhakei.capture/v2'].includes(obj.format)) throw new UIError('error.format');
  const samplerate = validRate(obj.sampleRate),
    channelCount = validWidth(obj.channelCount),
    length = sampleIndex(obj.length);
  if (length < 1n) throw new UIError('error.length');
  if (!Array.isArray(obj.channels) || obj.channels.length !== channelCount) throw new UIError('error.channelCount');
  const channels: RleChannelData[] = obj.channels.map((c: { initial?: unknown; edges?: unknown }, index: number) => {
    if (!c || (c.initial !== 0 && c.initial !== 1) || !Array.isArray(c.edges))
      throw new UIError('error.channel', { channel: index });
    let previous = 0n;
    for (const input of c.edges) {
      const edge = sampleIndex(input as SampleInput);
      if (edge <= previous || edge >= length) throw new UIError('error.edges', { channel: index });
      previous = edge;
    }
    return { initial: c.initial, edges: c.edges.map((value: SampleInput) => sampleIndex(value)) };
  });
  const triggerSample = sampleIndex(obj.triggerSample ?? 0n);
  if (triggerSample < 0 || triggerSample >= length) throw new UIError('error.trigger');
  if (obj.gaps !== undefined && !Array.isArray(obj.gaps)) throw new UIError('error.gapsArray');
  const gaps: GapSpan[] = (obj.gaps ?? []).map((g: GapSpan) => {
    if (!g || sampleIndex(g.endSample) <= sampleIndex(g.startSample) || sampleIndex(g.endSample) > length)
      throw new UIError('error.gaps');
    return { startSample: sampleIndex(g.startSample), endSample: sampleIndex(g.endSample) };
  });
  const labels = channels.map((_, i) =>
    typeof obj.channels[i].name === 'string' ? obj.channels[i].name.slice(0, 80) : `D${i}`,
  );
  const logicChannelCount = obj.logicChannelCount;
  if (
    logicChannelCount !== undefined &&
    (!Number.isInteger(logicChannelCount) || logicChannelCount < 0 || logicChannelCount > channelCount)
  )
    throw new UIError('error.channelCount');
  return {
    name,
    ...(logicChannelCount === undefined ? {} : { logicChannelCount }),
    acquisition: parseAcquisitionResult(obj.acquisition, length),
    store: new RleSampleStore({ channelCount, samplerate, length, channels, gaps }),
    labels,
    triggerSample,
    loadedMs: performance.now() - t,
  };
}
async function* binaryChunks(file: File, chunkBytes: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  let pending = file.slice(0, chunkBytes).arrayBuffer();
  void pending.catch(() => {});
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    signal?.throwIfAborted();
    const buffer = await pending;
    signal?.throwIfAborted();
    const next = offset + chunkBytes;
    if (next < file.size) {
      pending = file.slice(next, next + chunkBytes).arrayBuffer();
      void pending.catch(() => {});
    }
    yield new Uint8Array(buffer);
  }
}
export async function importCaptureLocal(
  file: File,
  sampleRate: number,
  width: number,
  progress: (fraction: number) => void = () => {},
  signal?: AbortSignal,
  pipelineOptions: CaptureImportPipelineOptions = {},
): Promise<Capture> {
  const t = performance.now();
  signal?.throwIfAborted();
  if (/\.sr$/i.test(file.name)) {
    const { importSR } = await import('./sr.js');
    return importSR(file, progress, signal);
  }
  if (/\.json$/i.test(file.name)) {
    if (file.size > 64 * 1024 * 1024) throw new UIError('error.jsonLimit');
    const text = await file.text();
    signal?.throwIfAborted();
    const capture = parseCapture(text, file.name);
    capture.loadedMs = performance.now() - t;
    return capture;
  }
  if (!/\.(bin|raw|dat)$/i.test(file.name)) throw new UIError('error.fileType');
  const channelCount = validWidth(width),
    samplerate = validRate(sampleRate),
    stride = Math.ceil(channelCount / 8);
  if (file.size === 0 || file.size % stride !== 0) throw new UIError('error.binaryLength', { stride });
  if (file.size > 256 * 1024 * 1024) throw new UIError('error.binaryLimit');
  const store = new PlanarSampleStore({ channelCount, samplerate });
  let pipe: Transpose32Pipeline | null = null;
  const chunkSamples = pipelineOptions.chunkSamples ?? 1_048_576;
  const backend =
    pipelineOptions.backend && pipelineOptions.backend !== 'auto' ? pipelineOptions.backend : store.transpose32Backend;
  const buffers = pipelineOptions.buffers ?? (backend === 'wasm-simd' || backend === 'webgpu' ? 2 : 3);
  const workers =
    pipelineOptions.workers ??
    (backend === 'js' || backend === 'wasm-scalar'
      ? Math.min(buffers, (globalThis.navigator?.hardwareConcurrency ?? 4) > 2 ? 2 : 1)
      : 1);
  if (!Number.isSafeInteger(chunkSamples) || chunkSamples <= 0 || chunkSamples % 32) {
    throw new Error('Import pipeline chunkSamples must be a positive multiple of 32');
  }
  if (
    pipelineOptions.buffers !== undefined &&
    (!Number.isInteger(pipelineOptions.buffers) || pipelineOptions.buffers < 1 || pipelineOptions.buffers > 8)
  ) {
    throw new Error('Import pipeline buffers must be between 1 and 8');
  }
  if (
    pipelineOptions.workers !== undefined &&
    (!Number.isInteger(pipelineOptions.workers) || pipelineOptions.workers < 1 || pipelineOptions.workers > buffers)
  ) {
    throw new Error('Import pipeline workers must be between 1 and the buffer count');
  }
  const explicitPipeline = Object.keys(pipelineOptions).length > 0;
  if (
    channelCount === 32 &&
    (file.size >= 4 * 1024 * 1024 || explicitPipeline) &&
    (typeof Worker !== 'undefined' || pipelineOptions.backend === 'webgpu')
  ) {
    try {
      pipe = await Transpose32Pipeline.create({ backend, maxSamples: chunkSamples, buffers, workers });
    } catch (error) {
      if (pipelineOptions.backend && pipelineOptions.backend !== 'auto') throw error;
    }
  }
  if (channelCount === 32 && !pipe && pipelineOptions.backend && pipelineOptions.backend !== 'auto') {
    throw new Error('Explicit import pipeline requires Worker support');
  }
  const onAbort = (): void =>
    pipe?.cancel(signal?.reason instanceof Error ? signal.reason : new Error('Import aborted'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const chunkBytes = pipe ? chunkSamples * stride : 262144;
    for await (const chunk of binaryChunks(file, chunkBytes, signal)) {
      signal?.throwIfAborted();
      if (pipe) {
        await pipe.waitForSlot();
        signal?.throwIfAborted();
        const aligned = Math.floor(chunk.byteLength / stride / 32) * 32;
        if (aligned) {
          void pipe
            .enqueue(new Uint32Array(chunk.buffer, chunk.byteOffset, aligned), (planes) => {
              store.appendTransposed32(planes);
              progress(Number(store.length * BigInt(stride)) / file.size);
            })
            .catch(() => {});
        }
        if (aligned * stride < chunk.byteLength) {
          await pipe.drain();
          signal?.throwIfAborted();
          store.append(chunk.subarray(aligned * stride));
          progress(Number(store.length * BigInt(stride)) / file.size);
        }
      } else {
        store.append(chunk);
        progress(Number(store.length * BigInt(stride)) / file.size);
      }
    }
    await pipe?.drain();
    signal?.throwIfAborted();
  } catch (error) {
    pipe?.cancel(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (pipe) {
      try {
        await pipe.drain();
      } catch {}
      pipe.dispose();
    }
  }
  return {
    name: file.name,
    store,
    labels: Array.from({ length: channelCount }, (_, i) => 'D' + i),
    triggerSample: 0n,
    loadedMs: performance.now() - t,
  };
}
