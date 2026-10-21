import type { Capture, CaptureImportPipelineOptions } from './capture.js';
import { UIError } from './i18n.js';
import type { CaptureImportInfo } from './capture-import-worker.js';
import { WorkerCaptureStore } from './worker-store.js';

type ImportResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; capture: CaptureImportInfo }
  | { type: 'error'; message: string; key?: ConstructorParameters<typeof UIError>[0]; params?: ConstructorParameters<typeof UIError>[1] };

export function importCaptureWorker(file: File, sampleRate: number, width: number, progress: (fraction: number) => void,
  signal?: AbortSignal, pipeline: CaptureImportPipelineOptions = {}): Promise<Capture> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./capture-import-worker.js', import.meta.url), { type: 'module' });
    const channel = new MessageChannel();
    let settled = false;
    const cleanup = (): void => { signal?.removeEventListener('abort', abort); };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true; cleanup(); channel.port2.close(); worker.terminate(); reject(error);
    };
    const abort = (): void => fail(signal?.reason instanceof Error ? signal.reason : new DOMException('Import aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<ImportResponse>) => {
      if (data.type === 'progress') { progress(data.fraction); return; }
      if (data.type === 'error') { fail(data.key ? new UIError(data.key, data.params) : new Error(data.message)); return; }
      if (settled) return;
      settled = true; cleanup();
      const info = data.capture, store = new WorkerCaptureStore(worker, channel.port2, info.metadata);
      resolve({ name: info.name, store, labels: [...info.metadata.labels], triggerSample: info.triggerSample,
        loadedMs: info.loadedMs, ...(info.logicChannelCount === undefined ? {} : { logicChannelCount: info.logicChannelCount }),
        analogChannels: store.analogStores.map(analog => ({ name: analog.name, store: analog })),
        ...(info.workspace ? { workspace: info.workspace } : {}), ...(info.acquisition ? { acquisition: info.acquisition } : {}) });
    };
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Capture import Worker failed')); };
    try {
      worker.postMessage({ type: 'start', file, sampleRate, width, pipeline, port: channel.port1 } satisfies {
        type: 'start'; file: File; sampleRate: number; width: number; pipeline: CaptureImportPipelineOptions; port: MessagePort }, [channel.port1]);
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}
