import { WebGPUTranspose32 } from './data/transpose32-webgpu.js';
import type { ActiveTranspose32Backend } from './data/transpose32-wasm.js';
import type { TransposeWorkerRequest, TransposeWorkerResponse } from './transpose32-pipeline-worker.js';
export type Pipeline32Backend = ActiveTranspose32Backend | 'webgpu';
export interface Pipeline32Options {
  backend: Pipeline32Backend;
  maxSamples?: number;
  buffers?: number;

  workers?: number;
}
export interface Pipeline32Timing {
  sequence: number; samples: number; latencyMs: number; readyMs: number;
  consumeMs: number; inputCopyMs: number; workerComputeMs: number | null;
}
interface Result {
  planes: readonly Uint32Array[]; release(): void;
  inputCopyMs: number; workerComputeMs: number | null;
}
interface Slot {busy: boolean; input: ArrayBuffer; output: ArrayBuffer;}
interface Pending {resolve(value: Extract<TransposeWorkerResponse, {type: 'result'}>): void; reject(error: Error): void;}

export class Transpose32Pipeline {
  readonly backend: Pipeline32Backend;
  readonly maxSamples: number;
  readonly buffers: number;
  readonly workers: number;
  readonly scratchBytes: number;
  readonly adapterInfo;
  maxInFlight = 0;
  submitted = 0;
  committed = 0;
  inFlight = 0;
  private closed = false;
  private failure: Error | null = null;
  private tail: Promise<void> = Promise.resolve();
  private readonly waiters = new Set<() => void>();
  private readonly pending = new Map<number, Pending>();
  private readonly slots: Slot[];

  static async create(options: Pipeline32Options): Promise<Transpose32Pipeline> {
    const maxSamples = options.maxSamples ?? 1_048_576, buffers = options.buffers ?? 3;
    const workers = options.backend === 'webgpu' ? 0 : options.workers ?? 1;
    if (!['js', 'wasm-scalar', 'wasm-simd', 'webgpu'].includes(options.backend)) throw new Error('Unknown pipeline backend');
    if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0 || maxSamples % 32) throw new Error('Pipeline capacity must be a positive multiple of 32');
    if (!Number.isInteger(buffers) || buffers < 1 || buffers > 8) throw new Error('Pipeline buffers must be between 1 and 8');
    if (options.backend !== 'webgpu' && (!Number.isInteger(workers) || workers < 1 || workers > buffers)) {
      throw new Error('Pipeline worker count must be between 1 and the buffer count');
    }
    if (options.backend === 'webgpu') {
      const gpu = await WebGPUTranspose32.create({maxSamples, buffers});
      return new Transpose32Pipeline(options.backend, maxSamples, buffers, [], gpu, gpu.scratchBytes);
    }
    const pool: Worker[] = [];
    let workerScratch = 0;
    try {
      for (let i = 0; i < workers; i++) {
        const worker = new Worker(new URL('./transpose32-pipeline-worker.js', import.meta.url), {type: 'module'});
        pool.push(worker);
        workerScratch += await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Transpose worker initialization timed out')), 15_000);
          worker.onerror = event => {event.preventDefault(); clearTimeout(timer); reject(new Error(event.message));};
          worker.onmessage = ({data}: MessageEvent<TransposeWorkerResponse>) => {
            clearTimeout(timer);
            if (data.type === 'ready') resolve(data.scratchBytes);
            else reject(new Error(data.type === 'error' ? data.message : 'Invalid worker initialization response'));
          };
          worker.postMessage({type: 'init', backend: options.backend} as TransposeWorkerRequest);
        });
      }
      return new Transpose32Pipeline(options.backend, maxSamples, buffers, pool, null,
        buffers * maxSamples * 8 + workerScratch);
    } catch (error) {for (const worker of pool) worker.terminate(); throw error;}
  }

  private constructor(backend: Pipeline32Backend, maxSamples: number, buffers: number,
    private readonly pool: Worker[], private readonly gpu: WebGPUTranspose32 | null, scratchBytes: number) {
    this.backend = backend; this.maxSamples = maxSamples; this.buffers = buffers;
    this.workers = pool.length; this.scratchBytes = scratchBytes; this.adapterInfo = gpu?.adapterInfo ?? null;
    this.slots = Array.from({length: buffers}, () => ({busy: false,
      input: new ArrayBuffer(gpu ? 0 : maxSamples * 4), output: new ArrayBuffer(gpu ? 0 : maxSamples * 4)}));
    for (const worker of pool) {
      worker.onerror = event => {event.preventDefault(); this.workerFailed(new Error(event.message));};
      worker.onmessageerror = () => this.workerFailed(new Error('Transpose worker message could not be decoded'));
      worker.onmessage = ({data}: MessageEvent<TransposeWorkerResponse>) => {
        if (data.type === 'error') {this.workerFailed(new Error(data.message)); return;}
        if (data.type !== 'result') {this.workerFailed(new Error('Unexpected transpose worker response')); return;}
        const pending = this.pending.get(data.id);
        if (!pending) {this.workerFailed(new Error('Unknown transpose job response')); return;}
        this.pending.delete(data.id); pending.resolve(data);
      };
    }
  }
  private check(): void {
    if (this.closed) throw new Error('Pipeline has been disposed');
    if (this.failure) throw this.failure;
  }
  private wake(): void {for (const waiter of this.waiters) waiter(); this.waiters.clear();}
  private workerFailed(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear(); for (const worker of this.pool) worker.terminate(); this.wake();
  }

  async waitForSlot(): Promise<void> {
    this.check();
    while (this.inFlight === this.buffers) {
      await new Promise<void>(resolve => this.waiters.add(resolve)); this.check();
    }
  }
  private async execute(slot: Slot, source: Uint32Array, sequence: number): Promise<Result> {
    if (this.gpu) {
      const mapped = await this.gpu.dispatch(source);
      return {...mapped, inputCopyMs: mapped.timing.uploadCpuMs, workerComputeMs: null};
    }
    const samples = source.length;
    const copyStart = performance.now(); new Uint32Array(slot.input, 0, samples).set(source);
    const inputCopyMs = performance.now() - copyStart;
    const response = await new Promise<Extract<TransposeWorkerResponse, {type: 'result'}>>((resolve, reject) => {
      this.pending.set(sequence, {resolve, reject});
      try {
        this.pool[sequence % this.pool.length]!.postMessage({type: 'transpose', id: sequence, samples,
          input: slot.input, output: slot.output} satisfies TransposeWorkerRequest, [slot.input, slot.output]);
      } catch (error) {this.pending.delete(sequence); reject(error as Error);}
    });
    slot.input = response.input; slot.output = response.output;
    const words = samples / 32;
    return {planes: Array.from({length: 32}, (_, ch) => new Uint32Array(slot.output, ch * words * 4, words)),
      inputCopyMs, workerComputeMs: response.computeMs, release() {}};
  }

  enqueue(source: Uint32Array, consume: (planes: readonly Uint32Array[], sequence: number) => void): Promise<Pipeline32Timing> {
    this.check();
    if (!(source instanceof Uint32Array) || !source.length || source.length % 32 || source.length > this.maxSamples) {
      throw new Error('Pipeline input must be a nonempty 32-aligned Uint32Array within capacity');
    }
    const slot = this.slots.find(value => !value.busy);
    if (!slot) throw new Error('Pipeline buffers are full; await waitForSlot() before enqueue');
    const samples = source.length, sequence = this.submitted++, started = performance.now();
    slot.busy = true; this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const outcome = this.execute(slot, source, sequence).then(result => ({result, ready: performance.now(), error: null}),
      (error: unknown) => ({result: null, ready: performance.now(), error: error instanceof Error ? error : new Error(String(error))}));
    const done = this.tail.then(async () => {
      const ready = await outcome;
      try {
        if (ready.error) throw ready.error;
        if (this.failure) throw this.failure;
        const begin = performance.now();
        const value = consume(ready.result!.planes, sequence) as unknown;
        if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(value).catch(() => {});
          throw new Error('Pipeline consumer must be synchronous');
        }
        this.committed++;
        return {sequence, samples, latencyMs: performance.now() - started,
          readyMs: ready.ready - started, consumeMs: performance.now() - begin,
          inputCopyMs: ready.result!.inputCopyMs, workerComputeMs: ready.result!.workerComputeMs};
      } catch (error) {this.failure ??= error instanceof Error ? error : new Error(String(error)); throw this.failure;}
      finally {ready.result?.release(); slot.busy = false; this.inFlight--; this.wake();}
    });
    this.tail = done.then(() => {}, () => {});
    return done;
  }

  async drain(): Promise<void> {await this.tail; this.check();}

  cancel(reason: Error = new Error('Pipeline cancelled')): void {this.failure ??= reason; this.wake();}
  dispose(): void {
    if (this.inFlight) throw new Error('Cannot dispose an active pipeline; drain it first');
    if (this.closed) return;
    this.closed = true; for (const worker of this.pool) worker.terminate(); this.gpu?.dispose();
    this.slots.length = 0; this.pending.clear(); this.wake();
  }
}
