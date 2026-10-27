const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshot = (value) =>
  JSON.parse(JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item)));

async function ready(renderer) {
  const started = performance.now();
  while (!renderer.viewReady || renderer.viewRefresh || renderer.pending) {
    check(performance.now() - started < 30000, 'Viewport timed out');
    await sleep(5);
  }
}

function setControl(id, value) {
  const input = document.getElementById(id);
  check(input, 'Missing control: ' + id);
  if (input instanceof HTMLSelectElement && ![...input.options].some((option) => option.value === String(value)))
    input.add(new Option(String(value), String(value)));
  input.value = String(value);
}

async function configure(app, config) {
  if (app.deviceControls.device.descriptor.id !== 'demo') {
    setControl('device-select', 'demo');
    document.getElementById('device-select').dispatchEvent(new Event('change', { bubbles: true }));
  }
  app.deviceControls.logicSelection = Array.from({ length: 8 }, (_, index) => index);
  app.deviceControls.analogSelection = [];
  setControl('sample-rate', 1000000);
  setControl('sample-limit', config.samples);
  for (const [key, value] of Object.entries({
    logicPattern: config.pattern ?? 'square',
    analogPattern: 'sine',
    frequencyHz: config.frequency ?? 50000,
    amplitude: 1,
    offset: 0,
    seed: 12345,
  }))
    setControl('device-option-' + key, value);
  await app.deviceControls.refreshCapabilities();
  check(app.deviceControls.ready, 'Demo configuration is not ready');
}

async function verifyPages(protocol, samples) {
  const count = protocol.frameCount;
  for (const offset of [0, Math.floor(count / 2), Math.max(0, count - 8)]) {
    const frames = await protocol.client.readFrames(offset, Math.min(8, count - offset));
    check(frames.length === Math.min(8, count - offset), 'Frame page length differs');
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      check(typeof frame.ss === 'bigint' && frame.es > frame.ss, 'Frame positions changed');
      if (index) check(frame.ss >= frames[index - 1].ss, 'Frames are not ordered');
    }
  }
  const annotations = await protocol.client.queryAnnotations(0n, BigInt(samples), 100);
  check(annotations.length > 0 && annotations.length <= 100, 'Annotation query limit differs');
  const csv = await protocol.client.readCsv(0, 8, 1000000, 0n, true);
  check(csv.includes('start_sample') && csv.trim().split('\n').length === 9, 'CSV page differs');
  const memory = protocol.result.stats.memory;
  check(
    memory.totalBytes === memory.annotationsBytes + memory.framesBytes + memory.binaryBytes,
    'Memory categories do not add up',
  );
  check(protocol.resultBytes === memory.totalBytes, 'UI replaced Worker memory with viewport memory');
  check(memory.framesBytes > 0, 'Frame storage was not counted');
  if (protocol.decoder === 'uart') check(memory.annotationsBytes > 0, 'Annotation storage was not counted');
  else check(memory.annotationsBytes === 0, 'Derived PWM annotations were counted as stored data');
  const binaryBuffers = {};
  for (const [key, bytes] of Object.entries(protocol.result.result.binarySizes)) {
    const blob = await protocol.client.readBinary(key);
    check(blob?.size === bytes, 'Binary export length differs');
    binaryBuffers[key] = await blob.arrayBuffer();
  }
  check(
    memory.binaryBytes === Object.values(binaryBuffers).reduce((sum, data) => sum + data.byteLength, 0),
    'Binary storage was missed or counted twice',
  );
  check((await protocol.client.readBinary('missing-output')) === null, 'Missing binary output is not null');
  check(!('binaries' in protocol.result.result), 'Full binaries escaped Worker storage');
  return { frames: await protocol.client.readFrames(0, 8), annotations, binaryBuffers };
}

async function verifyColumns(evidence) {
  const url = URL.createObjectURL(
    new Blob(
      [
        `
    import { DecodeResultStore } from ${JSON.stringify(new URL('../src/web/decode-result-store.ts', import.meta.url).href)};
    import { resultMemory } from ${JSON.stringify(new URL('../src/decoders/definition.ts', import.meta.url).href)};
    import { BinaryStore } from ${JSON.stringify(new URL('../src/decoders/binary-store.ts', import.meta.url).href)};
    self.onmessage = async ({data}) => {
      try {
        const compare = (a,b) => a.ss < b.ss ? -1 : a.ss > b.ss ? 1 : 0;
        const store = new DecodeResultStore(compare), frames = [], annotations = [];
        for (const shift of [1n << 80n, 1n << 40n, 0n]) {
          frames.push(...data.frames.map(frame => ({...frame,ss:frame.ss+shift,es:frame.es+shift,label:String(frame.value),metadata:{value:frame.value},optional:shift===0n?undefined:frame.value})));
          annotations.push(...data.annotations.map(item => ({...item,ss:item.ss+shift,es:item.es+shift})));
        }
        store.append({type:'batch',progress:1,frames,annotations});
        const binary = new Uint8Array(data.binary), binaries = {rx:binary, alias:binary.subarray(1)};
        store.finish(binaries);
        const expected = frames.sort(compare), actual = store.readFrames(0,expected.length);
        const text = value => JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);
        if (text(actual)!==text(expected)) throw new Error('Frame columns lost values, ordering or wide positions');
        if(actual.some(frame=>!Object.hasOwn(frame,'optional'))) throw new Error('Explicit undefined fields were lost');
        const indexed = store.annotations.query(0n, (1n<<80n)+1000000n,10000);
        annotations.sort((a,b)=>compare(a,b)||(a.es<b.es?-1:a.es>b.es?1:0));
        if(text(indexed)!==text(annotations)) throw new Error('Annotation columns lost values or wide positions');
        const memory=store.memory(resultMemory());
        if(memory.binaryBytes!==binary.byteLength) throw new Error('Aliased binary buffers counted twice');
        if(store.readBinary('toString')!==null) throw new Error('Unknown binary key resolved an inherited property');
        if((await store.readBinary('alias').arrayBuffer()).byteLength!==binary.byteLength-1) throw new Error('Binary view export differs');
        if(store.readFrames(1000000,8).length) throw new Error('Out of range frame page is not empty');
        const bytes=new BinaryStore();
        for(let repeat=0;repeat<3;repeat++) for(let offset=0;offset<binary.length;offset+=4093)
          bytes.append('rx',binary.subarray(offset,Math.min(binary.length,offset+4093)));
        const binaryCapacity=bytes.reservedBytes, joined=bytes.finish().rx;
        if(joined.length!==binary.length*3 || bytes.reservedBytes!==0) throw new Error('Binary pages were not transferred or released');
        for(let index=0;index<joined.length;index++) if(joined[index]!==binary[index%binary.length]) throw new Error('Binary bytes changed across pages');
        bytes.append('empty',new Uint8Array(0));
        if(bytes.finish().empty.length!==0) throw new Error('Empty binary output was lost');
        self.postMessage({ok:true,frames:actual.length,annotations:indexed.length,memory,binaryBytesVerified:joined.length,binaryCapacity});
      } catch(error) {self.postMessage({ok:false,error:String(error),stack:error.stack});}
    };
  `,
      ],
      { type: 'text/javascript' },
    ),
  );
  const worker = new Worker(url, { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => (data.ok ? resolve(data) : reject(new Error(data.error)));
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ frames: evidence.frames, annotations: evidence.annotations, binary: evidence.binary });
    });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

export async function runDecodeStorageChecks() {
  check(/Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent), 'Run in Google Chrome');
  check(crossOriginIsolated, 'Cross-origin isolation is required');
  const { app } = await import(document.querySelector('script[src*="/src/web/app.ts"]').src);
  const report = (globalThis.decodeStorageReport = { status: 'running', cases: [], progress: [], errors: [] });
  const originalUpdate = app.updateMemoryUsage;
  app.updateMemoryUsage = function () {
    originalUpdate.call(this);
    for (const protocol of this.protocols)
      if (protocol.state === 'decoding' && protocol.resultBytes > 0)
        report.progress.push({
          decoder: protocol.decoder,
          bytes: protocol.resultBytes,
          frames: protocol.frameCount,
          annotations: protocol.annotationCount,
          capturing: !!this.captureAbort,
        });
  };
  const evidence = { frames: [], annotations: [], binary: null };
  try {
    for (const config of [
      {
        name: 'uart-square-4M',
        samples: 4000000,
        protocols: [{ decoder: 'uart' }],
        frames: 40000,
        annotations: 439999,
      },
      {
        name: 'uart-dual-2M',
        samples: 2000000,
        protocols: [{ decoder: 'uart', mapping: { rx: 0, tx: 1 } }],
        frames: 40000,
      },
      {
        name: 'uart-random-4M',
        samples: 4000000,
        pattern: 'random',
        protocols: [{ decoder: 'uart' }],
        frames: 76449,
        annotations: 476261,
      },
      { name: 'pwm-low-1M', samples: 1000000, frequency: 1000, protocols: [{ decoder: 'pwm' }], frames: 998 },
      { name: 'pwm-high-4M', samples: 4000000, frequency: 100000, protocols: [{ decoder: 'pwm' }], frames: 399998 },
      {
        name: 'multi-1M',
        samples: 1000000,
        protocols: [
          { decoder: 'pwm' },
          { decoder: 'pwm', mapping: { data: 1 } },
          { decoder: 'uart' },
          { decoder: 'uart', mapping: { rx: 1 } },
        ],
      },
    ]) {
      report.status = config.name;
      for (const protocol of [...app.protocols]) app.removeProtocol(protocol.id);
      await configure(app, config);
      for (const spec of config.protocols) {
        const protocol = app.addProtocol(spec.decoder, false);
        protocol.mapping = spec.mapping ?? (spec.decoder === 'uart' ? { rx: 0 } : { data: 0 });
        if (spec.decoder === 'uart') protocol.options.baudrate = 100000;
        app.selectProtocol(protocol.id, false);
      }
      const started = performance.now();
      await app.startCapture();
      check(app.capture?.store.length === BigInt(config.samples), 'Capture length differs');
      check(app.capture.acquisition.stopReason === 'complete', 'Capture did not complete');
      check(
        app.capture.diagnostics.mainThreadAppend.calls === 0 && app.capture.diagnostics.mainThreadPublish.calls === 0,
        'Main thread processed samples',
      );
      for (const protocol of app.protocols) {
        check(protocol.state === 'done', 'Decode failed: ' + protocol.decoder + ' ' + JSON.stringify(protocol.error));
        if (config.frames) check(protocol.frameCount === config.frames, 'Frame count changed: ' + config.name);
        if (config.annotations)
          check(protocol.annotationCount === config.annotations, 'Annotation count changed: ' + config.name);
        const data = await verifyPages(protocol, config.samples);
        if (config.name === 'uart-square-4M') {
          evidence.frames = data.frames;
          evidence.annotations = data.annotations.slice(0, 8);
          evidence.binary = data.binaryBuffers.rx;
        } else if (protocol.decoder === 'uart') evidence.frames.push(...data.frames);
        if (protocol.decoder === 'pwm') evidence.annotations.push(...data.annotations.slice(0, 3));
      }
      await ready(app.renderer);
      const expected =
        app.capture.store.memory().totalBytes +
        app.protocols.reduce(
          (sum, p) =>
            sum +
            p.resultBytes +
            p.annotations.reservedBytes +
            Object.values(p.result.result.previews).reduce((bytes, value) => bytes + value.byteLength, 0),
          0,
        );
      check(app.retainedDataBytes() === expected, 'UI result storage counted twice');
      report.cases.push(
        snapshot({
          name: config.name,
          elapsedMs: performance.now() - started,
          protocols: app.protocols.map((p) => ({
            decoder: p.decoder,
            frames: p.frameCount,
            annotations: p.annotationCount,
            memory: p.result.stats.memory,
            decodeMs: p.result.stats.elapsedMs,
          })),
        }),
      );
      if (config.name === 'uart-square-4M') {
        report.status = 'uart-memory';
        report.uartMemory = await performance.measureUserAgentSpecificMemory();
        await app.decodeAll();
        for (const protocol of app.protocols) await verifyPages(protocol, config.samples);
        report.redecode = true;
      }
    }
    report.columns = await verifyColumns(evidence);
    check(
      report.progress.some((p) => p.decoder === 'uart' && p.annotations > 10000 && p.bytes > 1000000),
      'Live progress missed annotation storage',
    );
    report.status = 'done';
    return snapshot(report);
  } catch (error) {
    report.status = 'failed';
    report.errors.push({ error: String(error), stack: error.stack });
    throw error;
  } finally {
    app.updateMemoryUsage = originalUpdate;
  }
}
