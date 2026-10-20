import { createTranspose32, type ActiveTranspose32Backend } from './data/transpose32-wasm.js';
export type TransposeWorkerRequest =
  | {type: 'init'; backend: ActiveTranspose32Backend}
  | {type: 'transpose'; id: number; samples: number; input: ArrayBuffer; output: ArrayBuffer};
export type TransposeWorkerResponse =
  | {type: 'ready'; scratchBytes: number}
  | {type: 'error'; message: string; id?: number}
  | {type: 'result'; id: number; input: ArrayBuffer; output: ArrayBuffer; computeMs: number};
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TransposeWorkerRequest>) => void) | null;
  postMessage(message: TransposeWorkerResponse, transfer?: Transferable[]): void;
};
let impl: ReturnType<typeof createTranspose32> | null = null;
scope.onmessage = ({data}) => {
  try {
    if (data.type === 'init') {
      impl = createTranspose32(data.backend);
      scope.postMessage({type: 'ready', scratchBytes: impl.scratchBytes});
    } else {
      if (!impl) throw new Error('Transpose worker is not initialized');
      const words = data.samples / 32, source = new Uint32Array(data.input, 0, data.samples);
      const planes = Array.from({length: 32}, (_, ch) => new Uint32Array(data.output, ch * words * 4, words));
      const start = performance.now(); impl.transpose(source, 0, words, planes, 0);
      scope.postMessage({type: 'result', id: data.id, input: data.input, output: data.output,
        computeMs: performance.now() - start}, [data.input, data.output]);
    }
  } catch (error) {
    scope.postMessage({type: 'error', message: error instanceof Error ? error.message : String(error),
      ...(data.type === 'transpose' ? {id: data.id} : {})});
  }
};
