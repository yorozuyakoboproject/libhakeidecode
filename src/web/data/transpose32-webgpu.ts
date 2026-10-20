const BUFFER_USAGE = {MAP_READ: 0x01, COPY_SRC: 0x04, COPY_DST: 0x08,
  UNIFORM: 0x40, STORAGE: 0x80, QUERY_RESOLVE: 0x200} as const;
const MAP_READ = 0x01;

function deltaSwapShader(): string {
  const lines = [
    '@group(0) @binding(0) var<storage, read> source: array<u32>;',
    '@group(0) @binding(1) var<storage, read_write> channelData: array<u32>;',
    '@group(0) @binding(2) var<uniform> params: vec4<u32>;',
    '@compute @workgroup_size(64)',
    'fn main(@builtin(global_invocation_id) id: vec3<u32>) {',
    '  let tile = id.x;', '  let words = params.x;',
    '  if (tile >= words) { return; }', '  let base = tile * 32u;', '  var t: u32;',
  ];
  for (let i = 0; i < 32; i++) lines.push(`  var a${i} = source[base + ${i}u];`);
  for (const [shift, mask] of [[16, 0x0000ffff], [8, 0x00ff00ff], [4, 0x0f0f0f0f], [2, 0x33333333], [1, 0x55555555]] as const) {
    for (let a = 0; a < 32; a++) {
      if (a & shift) continue;
      const b = a + shift;
      lines.push(`  t = ((a${a} >> ${shift}u) ^ a${b}) & 0x${mask.toString(16)}u;`,
        `  a${a} ^= t << ${shift}u;`, `  a${b} ^= t;`);
    }
  }
  for (let ch = 0; ch < 32; ch++) lines.push(`  channelData[${ch}u * words + tile] = a${ch};`);
  lines.push('}');
  return lines.join('\n');
}

export interface WebGPUTransposeOptions {

  maxSamples?: number;

  timestamps?: boolean;

  buffers?: number;
}

export interface WebGPUTransposeTiming {
  uploadCpuMs: number;
  encodeSubmitCpuMs: number;
  readbackWaitMs: number;
  consumeCpuMs: number;

  gpuComputeMs: number | null;
}

interface GPUSlot {
  input: GPUBuffer; output: GPUBuffer; readback: GPUBuffer; params: GPUBuffer;
  paramsData: Uint32Array; bindings: GPUBindGroup; busy: boolean;
  queries: GPUQuerySet | null; queryResolve: GPUBuffer | null; queryReadback: GPUBuffer | null;
}
export interface WebGPUReadback32 {

  planes: readonly Uint32Array[];
  timing: WebGPUTransposeTiming;
  release(): void;
}

export class WebGPUTranspose32 {
  readonly backend = 'webgpu' as const;
  readonly adapterInfo;
  readonly maxSamples: number;
  readonly scratchBytes: number;
  readonly timestamps: boolean;
  readonly buffers: number;
  lastTiming: WebGPUTransposeTiming | null = null;
  private closed = false;
  private failure: Error | null = null;
  private readonly slots: GPUSlot[] = [];

  static async create(options: WebGPUTransposeOptions = {}): Promise<WebGPUTranspose32> {
    if (!globalThis.navigator?.gpu) throw new Error('WebGPU is unavailable in this browser/context');
    const maxSamples = options.maxSamples ?? 4_194_304, buffers = options.buffers ?? 1;
    if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0 || maxSamples % 32 !== 0) {
      throw new Error('WebGPU maxSamples must be a positive multiple of 32');
    }
    if (!Number.isInteger(buffers) || buffers < 1 || buffers > 8) throw new Error('WebGPU buffers must be between 1 and 8');
    const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
    if (!adapter) throw new Error('WebGPU did not provide an adapter');
    const byteLength = maxSamples * 4;
    if (byteLength > adapter.limits.maxStorageBufferBindingSize || byteLength > adapter.limits.maxBufferSize) {
      throw new Error('WebGPU capacity exceeds adapter buffer limits');
    }
    const timestamps = options.timestamps === true && adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice({
      requiredFeatures: timestamps ? ['timestamp-query'] : [],
      requiredLimits: {maxStorageBufferBindingSize: Math.max(128 * 1024 * 1024, byteLength),
        maxBufferSize: Math.max(256 * 1024 * 1024, byteLength)},
    });
    try {
      if (Math.ceil(maxSamples / 32 / 64) > device.limits.maxComputeWorkgroupsPerDimension) {
        throw new Error('WebGPU capacity exceeds dispatch limits');
      }
      const shader = device.createShaderModule({label: '32-channel delta swap', code: deltaSwapShader()});
      const info = await shader.getCompilationInfo(), errors = info.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(message => message.message).join('\n'));
      const pipeline = await device.createComputePipelineAsync({
        label: '32-channel transpose', layout: 'auto', compute: {module: shader, entryPoint: 'main'},
      });
      return new WebGPUTranspose32(device, pipeline, adapter, maxSamples, timestamps, buffers);
    } catch (error) {device.destroy(); throw error;}
  }

  private constructor(private readonly device: GPUDevice, private readonly pipeline: GPUComputePipeline,
    adapter: GPUAdapter, maxSamples: number, timestamps: boolean, buffers: number) {
    const info = adapter.info;
    this.adapterInfo = {vendor: info.vendor, architecture: info.architecture, device: info.device,
      description: info.description, isFallbackAdapter: info.isFallbackAdapter};
    this.maxSamples = maxSamples; this.timestamps = timestamps; this.buffers = buffers;
    const size = maxSamples * 4;
    for (let i = 0; i < buffers; i++) {
      const input = device.createBuffer({label: `sample upload ${i}`, size, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST});
      const output = device.createBuffer({label: `channel output ${i}`, size, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC});
      const readback = device.createBuffer({label: `channel readback ${i}`, size, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST});
      const params = device.createBuffer({label: `word count ${i}`, size: 16, usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST});
      const bindings = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer: input}}, {binding: 1, resource: {buffer: output}}, {binding: 2, resource: {buffer: params}},
      ]});
      this.slots.push({input, output, readback, params, bindings, paramsData: new Uint32Array(4), busy: false,
        queries: timestamps ? device.createQuerySet({type: 'timestamp', count: 2}) : null,
        queryResolve: timestamps ? device.createBuffer({size: 16, usage: BUFFER_USAGE.QUERY_RESOLVE | BUFFER_USAGE.COPY_SRC}) : null,
        queryReadback: timestamps ? device.createBuffer({size: 16, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST}) : null});
    }
    this.scratchBytes = buffers * (size * 3 + 16 + (timestamps ? 32 : 0));
    device.addEventListener('uncapturederror', event => {this.failure = new Error(event.error.message);});
    void device.lost.then(info => {if (!this.closed) this.failure = new Error(`WebGPU device lost: ${info.message}`);});
  }

  async dispatch(source: Uint32Array): Promise<WebGPUReadback32> {
    if (this.closed) throw new Error('WebGPU transpose has been disposed');
    if (this.failure) throw this.failure;
    if (source.length === 0 || source.length > this.maxSamples || source.length % 32 !== 0) {
      throw new Error('WebGPU input must contain 32-aligned samples within capacity');
    }
    const slot = this.slots.find(value => !value.busy);
    if (!slot) throw new Error('WebGPU buffers are full; single-buffer transpose calls must be sequential');
    slot.busy = true;
    let released = false;
    const release = (): void => {
      if (released) return; released = true;
      slot.readback.unmap(); slot.queryReadback?.unmap(); slot.busy = false;
    };
    try {
      const words = source.length / 32, bytes = source.byteLength, start = performance.now();
      this.device.queue.writeBuffer(slot.input, 0, source.buffer, source.byteOffset, bytes);
      slot.paramsData[0] = words; this.device.queue.writeBuffer(slot.params, 0, slot.paramsData);
      const uploaded = performance.now(), encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass(slot.queries ? {timestampWrites: {
        querySet: slot.queries, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1,
      }} : {});
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, slot.bindings);
      pass.dispatchWorkgroups(Math.ceil(words / 64)); pass.end();
      encoder.copyBufferToBuffer(slot.output, 0, slot.readback, 0, bytes);
      if (slot.queries) {
        encoder.resolveQuerySet(slot.queries, 0, 2, slot.queryResolve!, 0);
        encoder.copyBufferToBuffer(slot.queryResolve!, 0, slot.queryReadback!, 0, 16);
      }
      this.device.queue.submit([encoder.finish()]);
      const submitted = performance.now();
      await Promise.all([slot.readback.mapAsync(MAP_READ, 0, bytes),
        ...(slot.queryReadback ? [slot.queryReadback.mapAsync(MAP_READ, 0, 16)] : [])]);
      if (this.failure) throw this.failure;
      const mapped = performance.now(), output = new Uint32Array(slot.readback.getMappedRange(0, bytes));
      const planes = Array.from({length: 32}, (_, ch) => output.subarray(ch * words, (ch + 1) * words));
      let gpuComputeMs: number | null = null;
      if (slot.queryReadback) {
        const times = new BigUint64Array(slot.queryReadback.getMappedRange(0, 16));
        gpuComputeMs = Number(times[1]! - times[0]!) / 1e6;
      }
      return {planes, release, timing: {uploadCpuMs: uploaded - start, encodeSubmitCpuMs: submitted - uploaded,
        readbackWaitMs: mapped - submitted, consumeCpuMs: 0, gpuComputeMs}};
    } catch (error) {release(); throw error;}
  }

  async transpose(source: Uint32Array, consume: (planes: readonly Uint32Array[]) => void): Promise<void> {
    this.lastTiming = null;
    const result = await this.dispatch(source);
    try {
      const start = performance.now(); consume(result.planes);
      this.lastTiming = {...result.timing, consumeCpuMs: performance.now() - start};
    } finally {result.release();}
  }

  dispose(): void {
    if (this.slots.some(slot => slot.busy)) throw new Error('Cannot dispose an active WebGPU transpose');
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.slots) {
      for (const buffer of [slot.input, slot.output, slot.readback, slot.params, slot.queryResolve, slot.queryReadback]) buffer?.destroy();
      slot.queries?.destroy();
    }
    this.device.destroy();
  }
}
