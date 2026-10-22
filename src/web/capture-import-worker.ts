import { importCaptureLocal } from './capture-import.js';
import type { Capture, CaptureImportPipelineOptions } from './capture.js';
import { UIError, type MessageKey, type MessageParams } from './i18n.js';
import { WorkerStoreServer } from './worker-store-server.js';
import type { StoreMetadata } from './worker-store.js';
import type { PlanarSampleStore } from './data/planarStore.js';
import type { RleSampleStore } from './data/rleStore.js';

export interface CaptureImportInfo {
  readonly metadata: StoreMetadata;
  readonly name: string;
  readonly triggerSample: bigint;
  readonly loadedMs: number;
  readonly logicChannelCount?: number;
  readonly workspace?: Capture['workspace'];
  readonly acquisition?: Capture['acquisition'];
}
type ImportRequest = {
  type: 'start';
  file: File;
  sampleRate: number;
  width: number;
  pipeline: CaptureImportPipelineOptions;
  port: MessagePort;
};
type ImportResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; capture: CaptureImportInfo }
  | { type: 'error'; message: string; key?: MessageKey; params?: MessageParams };
type Scope = {
  onmessage: ((event: MessageEvent<ImportRequest>) => void) | null;
  postMessage(message: ImportResponse, transfer?: Transferable[]): void;
};
const scope = globalThis as unknown as Scope;

scope.onmessage = ({ data }) => {
  if (data.type !== 'start') return;
  scope.onmessage = null;
  void (async () => {
    let capture: Capture | null = null;
    const server = new WorkerStoreServer(() =>
      capture
        ? {
            store: capture.store as PlanarSampleStore | RleSampleStore,
            labels: capture.labels,
            ...(capture.logicChannelCount === undefined ? {} : { logicChannelCount: capture.logicChannelCount }),
            ...(capture.analogChannels ? { analogChannels: capture.analogChannels } : {}),
          }
        : null,
    );
    try {
      capture = await importCaptureLocal(
        data.file,
        data.sampleRate,
        data.width,
        (fraction) => scope.postMessage({ type: 'progress', fraction }),
        undefined,
        data.pipeline,
      );
      server.connect(data.port);
      scope.postMessage({
        type: 'done',
        capture: {
          metadata: server.metadata(),
          name: capture.name,
          triggerSample: capture.triggerSample,
          loadedMs: capture.loadedMs,
          ...(capture.logicChannelCount === undefined ? {} : { logicChannelCount: capture.logicChannelCount }),
          ...(capture.workspace ? { workspace: capture.workspace } : {}),
          ...(capture.acquisition ? { acquisition: capture.acquisition } : {}),
        },
      });
    } catch (error) {
      server.dispose();
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof UIError ? { key: error.key, params: error.params } : {}),
      });
    }
  })();
};
