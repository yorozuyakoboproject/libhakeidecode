import { TRANSPOSE32_SCALAR_BASE64, TRANSPOSE32_SIMD_BASE64 } from './transpose32-wasm-binary.js';
import { transpose32Words } from './transpose32.js';

export type Transpose32Backend = 'auto' | 'js' | 'wasm-scalar' | 'wasm-simd';
export type ActiveTranspose32Backend = Exclude<Transpose32Backend, 'auto'>;
const INPUT_WORDS = 65536;
const OUTPUT_OFFSET = INPUT_WORDS * 4;
const modules = new Map<ActiveTranspose32Backend, WebAssembly.Module | null>();

function getModule(backend: 'wasm-scalar' | 'wasm-simd'): WebAssembly.Module | null {
  if (modules.has(backend)) return modules.get(backend)!;
  let module: WebAssembly.Module | null = null;
  try {
    const base64 = backend === 'wasm-simd' ? TRANSPOSE32_SIMD_BASE64 : TRANSPOSE32_SCALAR_BASE64;
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    if (WebAssembly.validate(bytes)) module = new WebAssembly.Module(bytes);
  } catch {}
  modules.set(backend, module);
  return module;
}

export class WasmTranspose32 {
  readonly backend: 'wasm-scalar' | 'wasm-simd';
  readonly scratchBytes: number;
  private readonly input: Uint32Array;
  private readonly output: Uint32Array;
  private readonly run: (words: number) => void;

  constructor(backend: 'wasm-scalar' | 'wasm-simd') {
    const module = getModule(backend);
    if (!module) throw new Error(`${backend} is unavailable`);
    const exports = new WebAssembly.Instance(module).exports;
    const memory = exports.memory as WebAssembly.Memory;
    this.backend = backend;
    this.scratchBytes = memory.buffer.byteLength;
    this.input = new Uint32Array(memory.buffer, 0, INPUT_WORDS);
    this.output = new Uint32Array(memory.buffer, OUTPUT_OFFSET, INPUT_WORDS);
    const basic = exports[backend === 'wasm-simd' ? 'transpose_simd' : 'transpose_scalar'] as (words: number) => void;
    const fourTiles = exports.transpose_simd4 as ((words: number) => void) | undefined;
    this.run = fourTiles ? (words) => (words % 4 === 0 ? fourTiles : basic)(words) : basic;
  }

  transpose(src: Uint32Array, si: number, words: number, blocks: readonly Uint32Array[], wordOffset: number): void {
    for (let done = 0; done < words;) {
      let count = Math.min(INPUT_WORDS / 32, words - done);
      if (this.backend === 'wasm-simd' && count >= 4) count &= ~3;
      const start = si + done * 32;
      this.input.set(src.subarray(start, start + count * 32));
      this.run(count);
      for (let ch = 0; ch < 32; ch++)
        blocks[ch]!.set(this.output.subarray(ch * count, (ch + 1) * count), wordOffset + done);
      done += count;
    }
  }
}

export function createTranspose32(backend: Transpose32Backend = 'auto'): {
  backend: ActiveTranspose32Backend;
  scratchBytes: number;
  transpose: typeof transpose32Words;
} {
  if (backend === 'auto') {
    try {
      const wasm = new WasmTranspose32('wasm-simd');
      return { backend: wasm.backend, scratchBytes: wasm.scratchBytes, transpose: wasm.transpose.bind(wasm) };
    } catch {
      backend = 'js';
    }
  }
  if (backend === 'js') return { backend, scratchBytes: 0, transpose: transpose32Words };
  const wasm = new WasmTranspose32(backend);
  return { backend, scratchBytes: wasm.scratchBytes, transpose: wasm.transpose.bind(wasm) };
}
