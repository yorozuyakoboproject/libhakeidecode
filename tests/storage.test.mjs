import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PlanarSampleStore } from '../dist/src/web/data/planarStore.js';
import { RleSampleStore } from '../dist/src/web/data/rleStore.js';
import { createTranspose32 } from '../dist/src/web/data/transpose32-wasm.js';
import { MemoryBudget } from '../dist/src/web/memory.js';
import { importCapture, parseCapture } from '../dist/src/web/capture.js';
import { serializeSR, importSR } from '../dist/src/web/sr.js';
import { AnnotationIndex } from '../dist/src/web/event-index.js';

function fixture(length) { const bytes = new Uint8Array(length); for (let i = 0; i < length; i++) bytes[i] = (i * 37) ^ (i >>> 3); return bytes; }
test('planar and RLE stores preserve exact levels, column transitions and chunk boundaries', () => {
  const bytes = fixture(1031), planar = new PlanarSampleStore({ channelCount: 8, samplerate: 1_000_000 });
  for (let start = 0; start < bytes.length; start += 37) planar.append(bytes.subarray(start, start + 37));
  const rle = RleSampleStore.fromStore(planar);
  for (const store of [planar, rle]) {
    for (let channel = 0; channel < 8; channel++) {
      for (let i = 0; i < bytes.length; i++) assert.equal(store.sampleAt(channel, i), (bytes[i] >>> channel) & 1);
      for (const [start, end, bins] of [[0,1031,17],[33,729,33],[20,31,24],[1000,1031,9]]) {
        const view = store.query(channel, start, end, bins);
        for (let column = 0; column < bins; column++) {
          const a = start + Math.floor((end - start) * column / bins), b = start + Math.floor((end - start) * (column + 1) / bins);
          let low = 1, high = 0, edge = 0;
          for (let i = a; i < Math.max(a + 1, b); i++) { const value = (bytes[i] >>> channel) & 1; low = Math.min(low,value); high = Math.max(high,value); }
          for (let i = Math.max(1,a); i < b; i++) if (((bytes[i] ^ bytes[i-1]) >>> channel) & 1) edge = 1;
          assert.equal(view.low[column], low, `${store.constructor.name} low c${channel} bin${column}`);
          assert.equal(view.high[column], high, `${store.constructor.name} high c${channel} bin${column}`);
          if (b > a) assert.equal(view.edge[column], edge, `${store.constructor.name} edge c${channel} bin${column}`);
        }
      }
    }
  }
});

test('single-sample pulses and transitions exactly at pixel boundaries remain visible', () => {
  const store = new PlanarSampleStore({ channelCount: 4, samplerate: 1000 });
  const bytes = new Uint8Array(1024); bytes[256] = 1; bytes.fill(2,512); store.append(bytes);
  const pulse = store.query(0,0,1024,4); assert.equal(pulse.high[1],1); assert.equal(pulse.low[1],0); assert.equal(pulse.edge[1],1);
  const boundary = store.query(1,0,1024,4); assert.equal(boundary.low[2],1); assert.equal(boundary.high[2],1); assert.equal(boundary.edge[2],1);
});

test('deferred planar summaries rebuild correctly and resume incremental updates after finalization', () => {
  const bytes = fixture(1031), expected = new PlanarSampleStore({ channelCount: 8, samplerate: 1_000_000 });
  const actual = new PlanarSampleStore({ channelCount: 8, samplerate: 1_000_000, deferPyramid: true });
  for (let start = 0; start < bytes.length; start += 37) {
    const chunk = bytes.subarray(start, start + 37);
    expected.append(chunk); actual.append(chunk);
  }
  actual.finalizePyramid();
  for (let channel = 0; channel < 8; channel++) {
    assert.deepEqual(actual.query(channel, 0, bytes.length, 73).packed, expected.query(channel, 0, bytes.length, 73).packed);
  }
  const tail = Uint8Array.of(1, 3, 7, 15);
  expected.append(tail); actual.append(tail);
  for (let channel = 0; channel < 8; channel++) {
    assert.deepEqual(actual.query(channel, 0, bytes.length + tail.length, 73).packed,
      expected.query(channel, 0, bytes.length + tail.length, 73).packed);
  }
});

test('staged packed capture converts bounded blocks and releases raw memory', async () => {
  const bytes = fixture(4 * 1024 * 1024 + 37), budget = new MemoryBudget(20 * 1024 * 1024);
  const expected = new PlanarSampleStore({ channelCount: 8, samplerate: 200_000_000 });
  const actual = new PlanarSampleStore({ channelCount: 8, samplerate: 200_000_000, deferPyramid: true, stagePacked: true, budget });
  expected.append(bytes);
  for (let start = 0; start < bytes.length; start += 1024 * 1024) actual.append(bytes.subarray(start, start + 1024 * 1024));
  assert.equal(budget.snapshot().usedBytes, 8 * 1024 * 1024);
  await actual.finalizePyramidAsync();
  assert.equal(actual.length, BigInt(bytes.length));
  assert.deepEqual(actual.memory(), expected.memory());
  assert.equal(budget.snapshot().usedBytes, actual.memory().totalBytes);
  for (const sample of [0, 31, 1024, 4 * 1024 * 1024 - 1, 4 * 1024 * 1024, bytes.length - 1]) {
    for (let channel = 0; channel < 8; channel++) assert.equal(actual.sampleAt(channel, sample), (bytes[sample] >>> channel) & 1);
  }
  for (let channel = 0; channel < 8; channel++) {
    assert.deepEqual(actual.query(channel, 17, bytes.length, 73).packed, expected.query(channel, 17, bytes.length, 73).packed);
  }
  actual.dispose();
  assert.equal(budget.snapshot().usedBytes, 0);
});

test('live packed capture summaries answer exact levels, edges and decoder channel windows', () => {
  const bytes = fixture(8193), expected = new PlanarSampleStore({ channelCount: 8, samplerate: 200_000_000 });
  const live = new PlanarSampleStore({ channelCount: 8, samplerate: 200_000_000, stagePacked: true, keepPacked: true, deferPyramid: true });
  expected.append(bytes);
  for (let start = 0; start < bytes.length; start += 701) live.append(bytes.subarray(start, start + 701));
  expected.noteGap(2048, 2300);
  live.noteGap(2048, 2300);
  for (let channel = 0; channel < 8; channel++) {
    assert.equal(live.sampleAt(channel, 8192), (bytes[8192] >>> channel) & 1);
    assert.equal(live.edgeCount(channel, 0, 8193), expected.edgeCount(channel, 0, 8193) - expected.edgeCount(channel, 2048, 2300));
    assert.deepEqual(live.edges(channel, 2300, 8193), expected.edges(channel, 2300, 8193));
    assert.deepEqual(live.query(channel, 31, 8193, 37).packed, expected.query(channel, 31, 8193, 37).packed);
    assert.deepEqual(live.channelRange(channel, 101, 8193), Uint8Array.from(bytes.subarray(101), value => (value >>> channel) & 1));
  }
  live.dispose();
});

test('binary file import uses bit0 D0, little endian words and exact bytes', async () => {
  const file = new File([new Uint8Array([1,128,2,64,255,255])], 'test.bin');
  const capture = await importCapture(file, 1000,16); assert.equal(capture.store.length, 3n);
  assert.equal(capture.store.sampleAt(0,0),1); assert.equal(capture.store.sampleAt(15,0),1); assert.equal(capture.store.sampleAt(14,1),1);
  await assert.rejects(importCapture(new File([new Uint8Array([1])],'bad.bin'),1000,16));
  const abort = new AbortController(); abort.abort(); await assert.rejects(importCapture(file,1000,16,()=>{},abort.signal), {name:'AbortError'});
});

test('annotation index includes long intervals and late output from upper layers', () => {
  const index = new AnnotationIndex(), long = {ss:0n,es:10000n,classIndex:0,texts:['long']}, short = {ss:100n,es:101n,classIndex:0,texts:['short']};
  index.append([short,long]); assert.deepEqual(index.query(500,600),[long]);
  index.append([{ss:550n,es:560n,classIndex:1,texts:['late']}]); assert.equal(index.query(500,600).length,2);
  index.clear(); assert.deepEqual(index.query(0,1000),[]);
});

test('annotation view query samples dense intervals without changing stored results', () => {
  const index = new AnnotationIndex(), records = Array.from({length: 1000}, (_, i) => ({ss: BigInt(i), es: BigInt(i + 1), classIndex: 0, texts: [String(i)]}));
  index.append(records);
  const compact = index.query(0n, 1000n, 10);
  assert.equal(compact.length, 10); assert.equal(compact[0].ss, 50n); assert.equal(compact.at(-1).ss, 950n);
  assert.equal(index.query(0n, 1000n).length, 1000);
});
test('session round trip retains gaps, trigger, names and multiple protocol settings', async () => {
  const capture = parseCapture(JSON.stringify({ format: 'libhakei.capture/v1', sampleRate: 1000000, channelCount: 4, length: 40, triggerSample: 12,
    channels: [{ name: ' RX\n\\line ', initial: 1, edges: [4, 8, 12, 18, 25] }, ...Array.from({ length: 3 }, (_, i) => ({ name: `D${i+1}`, initial: i % 2, edges: [11, 24] }))], gaps: [{ startSample: 10, endSample: 20 }] }));
  const workspace = { protocols: [{ id: 'a', decoder: 'uart', name: '串口 A', color: '#123abc', options: { baudrate: '115200' }, mapping: { rx: 0, tx: 1 } }, { id: 'b', decoder: 'pwm', name: 'PWM B', color: '#ecbf12', options: { polarity: 'active-low' }, mapping: { data: 2 } }], selectedId: 'b', cursor: 7n, viewport: [2n, 38n], channels: [0, 2] };
  const saved = await serializeSR(capture, workspace), restored = await importSR(new File([saved], 'workspace.sr'));
  assert.deepEqual(restored.workspace, workspace); assert.deepEqual(restored.store.gaps(), capture.store.gaps()); assert.equal(restored.triggerSample, 12n); assert.equal(restored.labels[0], capture.labels[0]);
});

for (const backend of ['js', 'wasm-scalar', 'wasm-simd']) {
  test(`${backend}: every transpose bit preserves sample/channel order and destination offsets`, () => {
    const transpose = createTranspose32(backend), src = new Uint32Array(134);
    const blocks = Array.from({length:32}, () => new Uint32Array(8).fill(0x12345678));
    for(let sample=0; sample<128; sample++) for(let channel=0; channel<32; channel++) {
      src.fill(0);src[3+sample]=(1<<channel)>>>0;
      transpose.transpose(src,3,4,blocks,2);
      for(let ch=0; ch<32; ch++) {
        const expected=new Uint32Array(8).fill(0x12345678);expected.fill(0,2,6);
        if(ch===channel)expected[2+(sample>>>5)]=(1<<(sample&31))>>>0;
        assert.deepEqual(blocks[ch],expected);
      }
    }
  });
}

const output = new URL('../dist/', import.meta.url);
for (const prefix of ['/', '/tools/hakei/']) {
  test(`built site contains its page, module and Worker dependencies when deployed at ${prefix}`, async () => {
    const base = new URL(prefix, 'https://static.example');
    const pending = [new URL('index.html', base)], visited = new Set();
    while (pending.length) {
      const url = pending.shift();
      assert.equal(url.origin, base.origin, `External runtime dependency: ${url}`);
      assert.ok(url.pathname.startsWith(base.pathname), `Asset escapes deployment directory: ${url}`);
      const path = url.pathname.slice(base.pathname.length) || 'index.html';
      if (visited.has(path)) continue;
      visited.add(path);
      const content = await readFile(new URL(path, output), 'utf8');
      const references = path.endsWith('.html')
        ? [...content.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1])
        : path.endsWith('.js')
          ? [...content.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew\s+URL\(\s*)['"]([^'"]+)['"]/g)].map(match => match[1])
          : [];
      for (const reference of references) pending.push(new URL(reference, url));
    }
    for (const required of ['index.html', 'styles.css', 'preferences.js',
      'src/web/app.js', 'src/web/preferences.js', 'src/web/acquisition-worker.js', 'src/web/decode-worker.js']) {
      assert.ok(visited.has(required), `Site dependency was not reachable: ${required}`);
    }
  });
}
