import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { DemoDevice, defaultDeviceConfiguration, createSampleChunk } from '../dist/src/libhakei/index.js';
import { deviceCapture, captureSampleSource, captureMemory } from '../dist/src/web/capture.js';
import { MemoryBudget, MemoryBudgetError, SampleAllocationError } from '../dist/src/web/memory.js';
import { PlanarSampleStore } from '../dist/src/web/data/planarStore.js';
import { serializeSR, importSR } from '../dist/src/web/sr.js';
const device = new DemoDevice(), defaults = defaultDeviceConfiguration(device.descriptor);
const config = (overrides = {}) => ({ ...defaults, logicChannels: 4, analogChannels: 2, sampleCount: 200000, ...overrides });
const policy = { worker: 'off', chunkSamples: 65536, decodeReserveBytes: 0, displayReserveBytes: 0 };
const chunk = (startSample = 0, length = 16) => ({ startSample, sampleRate: 1000, channels: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`D${i}`, new Uint8Array(length).fill(i & 1)])) });

test('budget reserves before allocation, rolls back allocator failure and releases exactly once', () => {
  let calls = 0;
  const budget = new MemoryBudget(100, bytes => { calls++; if (bytes === 50) throw new RangeError('injected'); return new ArrayBuffer(bytes); });
  const buffer = budget.allocate(60, 'raw');
  assert.throws(() => budget.allocate(41, 'too large'), MemoryBudgetError); assert.equal(calls, 1);
  budget.release(buffer); budget.release(buffer); assert.equal(budget.snapshot().usedBytes, 0);
  assert.throws(() => budget.allocate(50, 'failure'), SampleAllocationError); assert.equal(budget.snapshot().usedBytes, 0);
  assert.equal(budget.snapshot().peakBytes, 60);
});

test('default finite Demo takes the planar path with exact mixed data capacity', async () => {
  const capture = await deviceCapture(device, defaults);
  assert.ok(capture.store instanceof PlanarSampleStore); assert.equal(capture.acquisition.stopReason, 'complete');
  assert.equal(capture.store.length, defaults.sampleCount); assert.equal(capture.acquisition.worker, false);
  assert.equal(capture.acquisition.memory.usedBytes, captureMemory(capture).totalBytes);
  assert.ok(captureMemory(capture).analogBytes > 0);
});

test('packed acquisition publishes queryable prefixes while the source is still running', async () => {
  const published = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  async function* source() {
    yield { format: 'packed-logic', encoding: 'raw8', data: Uint8Array.of(1, 2, 4, 8), length: 4,
      sampleRate: 1000, channelCount: 4, startSample: 0n };
    await gate;
    yield { format: 'packed-logic', encoding: 'raw8', data: Uint8Array.of(8, 4), length: 2,
      sampleRate: 1000, channelCount: 4, startSample: 4n };
  }
  const capturePromise = captureSampleSource(source(), 'packed test', undefined, {
    configuration: { sampleRate: 1000, sampleCount: 6n, logicChannels: 4, analogChannels: 0, options: {} },
    onCapture(value) { published.push(value); assert.equal(value.store.query(0, 0, 4, 4).high[0], 1); },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(published.length >= 1);
  assert.equal(published[0].store.length, 4n);
  release();
  const capture = await capturePromise;
  assert.equal(capture.store.length, 6n);
  assert.ok(published.length >= 2);
  assert.equal(capture.store.sampleAt(3, 3), 1);
});

test('packed budget stop preserves the committed prefix with live summaries', async () => {
  const budget = new MemoryBudget(12 * 1048576), releaseTransport = budget.reserve(8 * 1048576, 'transport scratch');
  async function* source() {
    for (let start = 0; start < 8 * 1048576; start += 1048576) {
      yield { format: 'packed-logic', encoding: 'raw8', data: new Uint8Array(1048576).fill(start >>> 20), length: 1048576,
        sampleRate: 200_000_000, channelCount: 8, startSample: BigInt(start) };
    }
  }
  const capture = await captureSampleSource(source(), 'packed budget', undefined, {
    budget, chunkSamples: 1048576, trackSourceBuffers: false, beforeFinalize: releaseTransport,
    configuration: { sampleRate: 200_000_000, sampleCount: 8n * 1048576n, logicChannels: 8, analogChannels: 0, options: {} },
  });
  assert.equal(capture.acquisition.stopReason, 'budget');
  assert.equal(capture.store.length, 4n * 1048576n);
  assert.equal(capture.acquisition.actualSamples, capture.store.length);
  assert.equal(capture.acquisition.memory.usedBytes, captureMemory(capture).totalBytes);
  assert.ok(capture.acquisition.memory.peakBytes <= budget.limitBytes);
});

test('failure in a later analog channel rolls back every newly prepared block', async () => {
  let rawAllocations = 0;
  const requested = config({ analogChannels: 4 });
  const capture = await deviceCapture(device, requested, undefined, { ...policy, allocateBuffer(bytes, label) {
    if (label === 'analog block' && ++rawAllocations === 6) throw new RangeError('simulated fragmentation');
    return new ArrayBuffer(bytes);
  } });
  assert.equal(capture.acquisition.stopReason, 'allocation-failed'); assert.equal(capture.store.length, 65536n);
  assert.equal(capture.acquisition.memory.usedBytes, captureMemory(capture).totalBytes);
  for (const channel of capture.analogChannels) assert.equal(channel.store.length, 65536n);
});

test('first-block failures reject without exposing an empty capture', async () => {
  await assert.rejects(deviceCapture(device, config(), undefined, { ...policy, budgetBytes: 1 }), MemoryBudgetError);
  await assert.rejects(deviceCapture(device, config(), undefined, { ...policy, allocateBuffer() { throw new RangeError('allocation failed'); } }), SampleAllocationError);
});

test('driver errors preserve a valid prefix; successful short sources still reject', async () => {
  let closed = false;
  const source = (async function* () { try { yield chunk(); throw new Error('device disconnected'); } finally { closed = true; } })();
  const capture = await captureSampleSource(source, 'failing');
  assert.equal(capture.acquisition.stopReason, 'error'); assert.equal(capture.store.length, 16n); assert.equal(closed, true);
  const stub = { descriptor: device.descriptor, getCapabilities: () => device.descriptor.capabilities, createSource: () => (async function* () { yield chunk(); })() };
  await assert.rejects(deviceCapture(stub, config({ sampleRate: 1000 }), undefined, policy), /does not match/);
});

test('cancellation interrupts a blocked next() and closes the source without waiting indefinitely', async () => {
  const controller = new AbortController(); let closed = false;
  const source = { [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); }, return() { closed = true; return Promise.resolve({ done: true }); } };
  const pending = captureSampleSource(source, 'blocked', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(closed, true);
});

test('aborted stores release all quota and cannot replace a following successful capture', async () => {
  const budget = new MemoryBudget(), controller = new AbortController();
  const source = (async function* () { yield chunk(); yield chunk(16); })();
  await assert.rejects(captureSampleSource(source, 'cancelled', controller.signal, { budget, onProgress() { controller.abort(); } }), { name: 'AbortError' });
  assert.equal(budget.snapshot().usedBytes, 0);
  const fresh = await deviceCapture(device, config({ sampleCount: 32 }), undefined, policy); assert.equal(fresh.store.length, 32n);
});

test('Float32 overflow is rejected at the external input boundary', async () => {
  assert.throws(() => createSampleChunk({ ...chunk(0, 1), analogChannels: { A0: [1e100] } }), /Float32/);
  const source = (async function* () { yield { ...chunk(0, 1), analogChannels: { A0: new Float64Array([1e100]) } }; })();
  await assert.rejects(captureSampleSource(source, 'overflow'), /Float32/);
});

test('automatic Worker startup failure falls back with released buffers; forced Worker reports failure', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = class { constructor() { throw new Error('Worker startup blocked'); } };
  try {
    const requested = config({ sampleCount: 262145 });
    const capture = await deviceCapture(device, requested, undefined, { ...policy, worker: 'auto' });
    assert.equal(capture.store.length, BigInt(requested.sampleCount)); assert.equal(capture.acquisition.worker, false);
    assert.equal(capture.acquisition.buffers, 1);
    assert.equal(capture.acquisition.memory.usedBytes, captureMemory(capture).totalBytes);
    await assert.rejects(deviceCapture(device, requested, undefined, { ...policy, worker: 'on' }), /Worker startup blocked/);
  } finally { globalThis.Worker = previous; }
});

for (const buffers of [2, 3]) {
  test(`real acquisition Worker transfers and recycles ${buffers} bounded buffers with an exact mixed tail`, async () => {
    const previous = globalThis.Worker;
    globalThis.Worker = class {
      constructor(url) {
        this.thread = new NodeWorker("const { parentPort, workerData } = await import('node:worker_threads');\nif (parentPort) {\n  globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);\n  await import(workerData.url);\n  parentPort.on('message', data => globalThis.onmessage({data}));\n}\n", { eval: true, workerData: { url: String(url) } });
        this.thread.on('message', data => this.onmessage?.({ data }));
        this.thread.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
      }
      postMessage(data, transfer) { this.thread.postMessage(data, transfer); }
      terminate() { void this.thread.terminate(); }
    };
    try {
      const requested = config({ sampleCount: 262153, options: { ...defaults.options, logicPattern: 'random' } });
      const capture = await deviceCapture(device, requested, undefined, { ...policy, worker: 'on', buffers });
      const reference = await deviceCapture(device, requested, undefined, policy);
      assert.equal(capture.acquisition.worker, true); assert.equal(capture.acquisition.buffers, buffers);
      assert.ok(capture.acquisition.maxQueued > 0 && capture.acquisition.maxQueued <= buffers);
      assert.equal(capture.acquisition.stopReason, 'complete'); assert.equal(capture.store.length, BigInt(requested.sampleCount));
      for (const index of [0, 31, 65535, 65536, 131071, 262143, 262152]) {
        for (let channel = 0; channel < 4; channel++) assert.equal(capture.store.sampleAt(channel, index), reference.store.sampleAt(channel, index));
        for (let channel = 0; channel < 2; channel++) assert.equal(capture.analogChannels[channel].store.sampleAt(index), reference.analogChannels[channel].store.sampleAt(index));
      }
      assert.equal(capture.acquisition.memory.usedBytes, captureMemory(capture).totalBytes);
    } finally { globalThis.Worker = previous; }
  });
}

test('graceful Stop preserves committed samples, releases transport and round-trips the stop reason', async () => {
  const stop = new AbortController();
  const requested = config({ sampleCount: 200000 });
  const capture = await deviceCapture(device, requested, undefined, { ...policy, stopSignal: stop.signal, onProgress() { stop.abort(); } });
  assert.equal(capture.acquisition.stopReason, 'stopped'); assert.equal(capture.store.length, 65536n);
  assert.equal(capture.acquisition.targetSamples, 200000n);
  assert.ok(capture.analogChannels.every(channel => channel.store.length === capture.store.length));
  assert.equal(capture.acquisition.memory.usedBytes, captureMemory(capture).totalBytes);
  const restored = await importSR(new File([await serializeSR(capture)], 'stopped.sr'));
  assert.deepEqual(restored.acquisition, capture.acquisition);
});

test('graceful Stop interrupts blocked next() after a commit and closes the source', { timeout: 2000 }, async () => {
  const stop = new AbortController(); let calls = 0, closed = false, notifyWaiting;
  const waiting = new Promise(resolve => { notifyWaiting = resolve; });
  const source = { [Symbol.asyncIterator]() { return this; },
    next() { if (!calls++) return Promise.resolve({ done: false, value: chunk() }); notifyWaiting(); return new Promise(() => {}); },
    return() { closed = true; return Promise.resolve({ done: true }); },
  };
  const pending = captureSampleSource(source, 'stopped', undefined, { stopSignal: stop.signal });
  await waiting; stop.abort(); const capture = await pending;
  assert.equal(closed, true); assert.equal(capture.acquisition.stopReason, 'stopped'); assert.equal(capture.store.length, 16n);
});

test('Stop before the first sample does not publish an empty capture', { timeout: 2000 }, async () => {
  const stop = new AbortController(); let closed = false;
  const source = { [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); },
    return() { closed = true; return Promise.resolve({ done: true }); },
  };
  const pending = captureSampleSource(source, 'empty stop', undefined, { stopSignal: stop.signal });
  stop.abort(); await assert.rejects(pending, error => error === stop.signal.reason); assert.equal(closed, true);
});

test('cancellation takes priority over graceful Stop and releases unpublished data', async () => {
  const stop = new AbortController(), cancel = new AbortController(), budget = new MemoryBudget();
  const source = (async function* () { yield chunk(); yield chunk(16); })();
  await assert.rejects(captureSampleSource(source, 'cancelled stop', cancel.signal, { budget, stopSignal: stop.signal,
    onProgress() { stop.abort(); cancel.abort(); },
  }), error => error === cancel.signal.reason);
  assert.equal(budget.snapshot().usedBytes, 0);
});
