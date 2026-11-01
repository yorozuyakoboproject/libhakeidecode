import { app } from '../src/web/app.ts';
import { decoderDefinitions } from '../src/decoders/index.ts';
import { driverDefinitions } from '../src/drivers/index.ts';
import { USB_VID, USB_PID } from '../src/drivers/ch32h417/descriptor.ts';
import { importCapture } from '../src/web/capture.ts';
import { DecodeClient } from '../src/web/decode-client.ts';
import { getLocale, setLocale, t, translateDOM } from '../src/web/i18n.ts';

function check(condition, message) {
  if (!condition) throw new Error(message);
}
function change(id, value) {
  const input = document.getElementById(id);
  input.value = String(value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function deadline(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Hardware operation timed out')), 30_000);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function uiModuleGraph() {
  const modules = new Set(),
    pending = [new URL('../src/web/app.ts', import.meta.url).href];
  while (pending.length) {
    const url = pending.pop();
    if (modules.has(url)) continue;
    modules.add(url);
    const response = await fetch(url);
    check(response.ok, 'UI module could not be read: ' + url);
    const source = await response.text();
    const imports = [
      ...source.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ];
    for (const match of imports)
      if (match[1].startsWith('.') || match[1].startsWith('/src/')) pending.push(new URL(match[1], url).href);
  }
  return [...modules];
}

function requireChrome() {
  check(/Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent), 'Run this check in Google Chrome');
  check(crossOriginIsolated, 'Cross-origin isolation is required');
}

async function waitForView() {
  let timer;
  try {
    await deadline(
      new Promise((resolve) => {
        const poll = () => {
          if (app.renderer.viewReady && !app.renderer.viewRefresh && !app.renderer.pending) resolve();
          else timer = setTimeout(poll, 10);
        };
        poll();
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function runDemoChecks() {
  requireChrome();
  change('device-select', 'demo');
  await deadline(app.deviceControls.refreshCapabilities());
  change('sample-rate', 200000);
  change('sample-limit', 200000);
  change('device-channel-count', 8);
  change('device-analog-count', 2);
  change('device-option-frequencyHz', 1000);
  const results = [];
  for (const [pattern, amplitude, offset, min, max] of [
    ['sine', 20, -10, -10, 10],
    ['constant', 0, 7.5, 7.5, 7.5],
    ['constant', 0, 0, 0, 0],
  ]) {
    change('device-option-analogPattern', pattern);
    change('device-option-amplitude', amplitude);
    change('device-option-offset', offset);
    await deadline(app.deviceControls.refreshCapabilities());
    await deadline(app.startCapture());
    const capture = app.capture;
    check(capture.store.length === 200000n && capture.acquisition.stopReason === 'complete', 'Demo capture failed');
    check(
      capture.acquisition.worker &&
        capture.diagnostics.mainThreadAppend.calls === 0 &&
        capture.diagnostics.mainThreadPublish.calls === 0,
      'Demo data escaped Worker processing',
    );
    check(
      capture.store.analogMetadata.length === 2 &&
        capture.store.analogMetadata.every((item) => item.range?.min === min && item.range?.max === max),
      'Demo amplitude range differs',
    );
    const draw = async (span) => {
      app.renderer.setViewport(0n, BigInt(span));
      await waitForView();
      const context = document.createElement('canvas').getContext('2d'),
        points = [],
        labels = [],
        arc = context.arc,
        text = context.fillText;
      context.arc = function (x, y, ...args) {
        points.push(y);
        return arc.call(this, x, y, ...args);
      };
      context.fillText = function (value, ...args) {
        if (this.textAlign === 'right') labels.push(Number(value));
        return text.call(this, value, ...args);
      };
      app.renderer.drawAnalog(context, 0, 0, app.renderer.width - app.renderer.gutter - 16);
      check(points.length === span && points.every(Number.isFinite), 'Demo curve contains missing or invalid points');
      check(labels.length === 2 && labels[0] > max && labels[1] < min, 'Analog axis has no padding or zero span');
      return { points, labels };
    };
    const narrow = await draw(32),
      wide = await draw(64);
    check(
      narrow.points.every((y, i) => Math.abs(y - wide.points[i]) < 1e-9) &&
        String(narrow.labels) === String(wide.labels),
      'Horizontal zoom changed the vertical scale',
    );
    if (pattern === 'sine') check(Math.abs(wide.points[25] - wide.points[31]) > 1, 'Values above +1 were flattened');
    else
      check(
        wide.points.every((y) => y === wide.points[0]),
        'Constant signal was distorted',
      );
    results.push({ pattern, range: { min, max }, axis: wide.labels });
  }
  app.renderer.fit();
  await waitForView();
  return { samples: '200000', sampleRate: 200000, cases: results };
}

export async function runZoomChecks() {
  requireChrome();
  const renderer = app.renderer,
    canvas = renderer.canvas,
    parent = canvas.parentElement,
    context = canvas.getContext('2d'),
    row = renderer.rowLayout().find((item) => item.entry.kind === 'analog');
  check(row && app.capture, 'Load an analog recording before checking zoom');
  renderer.setViewport(0n, 2000n);
  await waitForView();
  const swatch = document.createElement('canvas').getContext('2d');
  swatch.fillStyle = renderer.analogSettings[row.entry.id].color;
  swatch.fillRect(0, 0, 1, 1);
  const rgb = swatch.getImageData(0, 0, 1, 1).data,
    report = { frames: 0, presentations: 0, blankFrames: 0, cacheMisses: 0, axisChanges: 0 },
    present = renderer.presentFrame,
    text = renderer.frameContext.fillText,
    queries = [];
  let labels = [],
    expectedLabels;
  renderer.frameContext.fillText = function (value, x, ...args) {
    if (this.textAlign === 'right' && x === renderer.gutter - 16) labels.push(value);
    return text.call(this, value, x, ...args);
  };
  renderer.presentFrame = function () {
    present.call(this);
    report.presentations++;
    const axis = JSON.stringify(labels);
    if (labels.length) {
      if (expectedLabels === undefined) expectedLabels = axis;
      else if (axis !== expectedLabels) report.axisChanges++;
    }
    labels = [];
  };
  for (const { store } of app.capture.analogChannels) {
    const query = store.query;
    queries.push(() => delete store.query);
    store.query = function (...args) {
      const view = query.apply(this, args);
      if (view !== this.cache?.view) report.cacheMisses++;
      return view;
    };
  }
  try {
    for (let i = 0; i < 120; i++) {
      const rect = parent.getBoundingClientRect();
      parent.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: i % 60 < 30 ? -60 : 60,
          clientX: rect.left + renderer.gutter + (renderer.width - renderer.gutter - 16) * (i % 2 ? 0.25 : 0.75),
          clientY: rect.top + 30,
          bubbles: true,
          cancelable: true,
        }),
      );
      if (i % 12 === 0) renderer.pan(i % 24 ? 500n : -500n);
      await deadline(new Promise((resolve) => requestAnimationFrame(resolve)));
      const dpr = devicePixelRatio,
        x = Math.floor(renderer.gutter * dpr),
        pixels = context.getImageData(
          x,
          Math.floor((row.top + 1) * dpr),
          canvas.width - x - Math.ceil(16 * dpr),
          Math.ceil(46 * dpr),
        ).data;
      let colored = false;
      for (let p = 0; p < pixels.length; p += 4) {
        if (
          Math.abs(pixels[p] - rgb[0]) < 20 &&
          Math.abs(pixels[p + 1] - rgb[1]) < 20 &&
          Math.abs(pixels[p + 2] - rgb[2]) < 20
        ) {
          colored = true;
          break;
        }
      }
      if (!colored) report.blankFrames++;
      report.frames++;
    }
    await waitForView();
    check(
      report.presentations > 0 && report.blankFrames === 0 && report.cacheMisses === 0 && report.axisChanges === 0,
      'Zoom introduced a blank frame, stale data or changing vertical scale: ' + JSON.stringify(report),
    );
    return report;
  } finally {
    renderer.presentFrame = present;
    delete renderer.frameContext.fillText;
    for (const restore of queries) restore();
  }
}

export async function runInteractionChecks() {
  requireChrome();
  change('device-select', 'demo');
  await deadline(app.deviceControls.refreshCapabilities());
  change('sample-rate', 200000);
  change('sample-limit', 200000);
  change('device-channel-count', 8);
  change('device-analog-count', 2);
  change('device-option-analogPattern', 'constant');
  change('device-option-amplitude', 0);
  change('device-option-offset', -0.625);
  await deadline(app.deviceControls.refreshCapabilities());
  await deadline(app.startCapture());
  const capture = app.capture,
    renderer = app.renderer,
    context = renderer.canvas.getContext('2d'),
    text = context.fillText,
    readouts = [];
  context.fillText = function (value, ...args) {
    if (value.startsWith('[ ')) readouts.push(value);
    return text.call(this, value, ...args);
  };
  try {
    await waitForView();
    const rect = renderer.canvas.getBoundingClientRect();
    for (let i = 0; i < 30; i++)
      renderer.canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: rect.left + renderer.gutter + 10 + i * 3,
          clientY: rect.top + 100,
          bubbles: true,
        }),
      );
    let timer;
    try {
      await deadline(
        new Promise((resolve) => {
          const poll = () => {
            if (
              !renderer.hoverPending &&
              renderer.hoverFrame === 0 &&
              renderer.hoverResult?.sample === renderer.hoverSample
            )
              resolve();
            else timer = setTimeout(poll, 10);
          };
          poll();
        }),
      );
    } finally {
      clearTimeout(timer);
    }
    check(
      renderer.hoverX !== null && renderer.hoverResult.values.every((value) => value === -0.625),
      'Hover probe returned stale or wrong sample values',
    );
    check(
      readouts.some((value) => value === '[ -625 mV ] 2 V/div'),
      'Voltage readout or division scale differs',
    );
    renderer.canvas.dispatchEvent(new PointerEvent('pointerleave'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    check(renderer.hoverX === null && renderer.hoverSample === null, 'Hover line remained after leaving the waveform');
    for (const [selector, value] of [
      ['.channel-chip:not(.analog-chip) .channel-name', '主时钟'],
      ['.analog-chip .channel-name', '电源监测'],
    ]) {
      const input = document.querySelector(selector);
      check(!input.disabled, 'Channel names stayed disabled after capture');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      check(input.closest('.channel-chip').querySelector('input[type="checkbox"]').checked, 'Renaming hid the channel');
    }
    const blob = await deadline(
        capture.store.exportSR(app.workspaceSettings(), capture.triggerSample, capture.acquisition),
      ),
      imported = await deadline(importCapture(new File([blob], 'renamed.sr'), 200000, 8));
    try {
      check(
        imported.labels[0] === '主时钟' && imported.analogChannels[0].name === '电源监测',
        'Channel names did not survive SR export and import',
      );
      check(
        (await imported.store.readAnalogProbe(0n)).every((value) => value === -0.625),
        'Renaming changed analog samples',
      );
    } finally {
      imported.store.dispose();
    }
    return {
      readout: '[ -625 mV ] 2 V/div',
      digitalName: capture.labels[0],
      analogName: capture.analogChannels[0].name,
    };
  } finally {
    delete context.fillText;
  }
}

async function requireRealH417() {
  requireChrome();
  check(navigator.usb, 'WebUSB is required');
  const devices = (await navigator.usb.getDevices()).filter(
    (device) => device.vendorId === USB_VID && device.productId === USB_PID && device.serialNumber?.startsWith('H417-'),
  );
  check(devices.length > 0, 'No authorized real H417 device; stop without testing');
}

async function inspectAnalogSR(
  { file, exported },
  { readZip, importSR, AnalogSampleStore, AnalogConversion, defaultAnalogSettings },
) {
  const members = await readZip(file),
    capture = await importSR(new File([exported], 'roundtrip.sr')),
    ranges = [];
  try {
    for (let channel = 0; channel < 5; channel++) {
      const chunks = [...members.values()]
        .filter((member) => member.name.startsWith(`analog-1-${channel + 9}-`))
        .sort((a, b) => Number(a.name.split('-').at(-1)) - Number(b.name.split('-').at(-1)));
      const bytes = new Uint8Array(
          await new Blob(await Promise.all(chunks.map((chunk) => chunk.read()))).arrayBuffer(),
        ),
        expected = new Float32Array(bytes.buffer),
        expectedBits = new Uint32Array(bytes.buffer),
        store = capture.analogChannels[channel].store,
        actual = store.copyRange(0n, store.length),
        actualBits = new Uint32Array(actual.buffer),
        replay = new AnalogSampleStore(capture.store.samplerate);
      check(expected.length === 711600 && actual.length === expected.length, 'Analog sample count differs');
      check(replay.range === null, 'Empty analog channel has an amplitude range');
      let min = Infinity,
        max = -Infinity;
      try {
        for (let start = 0; start < expected.length;) {
          const end = Math.min(expected.length, start ? start + 65536 : 1);
          for (let sample = start; sample < end; sample++) {
            check(actualBits[sample] === expectedBits[sample], `Analog value changed: A${channel}/${sample}`);
            min = Math.min(min, expected[sample]);
            max = Math.max(max, expected[sample]);
          }
          replay.append(expected.subarray(start, end));
          check(replay.range.min === min && replay.range.max === max, 'Streaming analog range differs');
          start = end;
        }
      } finally {
        replay.dispose();
      }
      check(replay.range === null, 'Disposed analog channel retained its amplitude range');
      check(store.range.min === min && store.range.max === max, 'Full analog range differs');
      if (channel === 1) {
        const mean = expected.reduce((sum, value) => sum + value, 0) / expected.length;
        check(store.mean === mean, 'Signal average differs from the original recording');
        for (const [mode, preset, low, high] of [
          ['threshold', '1.8', 1.8, 1.8],
          ['threshold', 'average', mean, mean],
          ['schmitt', '0.7/2.5', 0.7, 2.5],
          ['schmitt', 'average', mean - 3, mean + 3],
        ]) {
          const conversion = new AnalogConversion(),
            settings = { ...defaultAnalogSettings(), conversion: mode, threshold: preset },
            states = new Uint8Array(expected.length);
          let state = expected[0] >= (low + high) / 2 ? 1 : 0;
          for (let sample = 0; sample < expected.length; sample++) {
            if (expected[sample] >= high) state = 1;
            else if (expected[sample] <= low) state = 0;
            states[sample] = state;
          }
          try {
            for (const start of [0, 65500, expected.length - 128]) {
              const view = conversion.prepare(store, settings, [], BigInt(start), BigInt(start + 128), 128);
              check(
                view.points?.every((value, index) => value === states[start + index]),
                'Converted trace changed with viewport: ' + mode + '/' + preset,
              );
            }
          } finally {
            conversion.dispose();
          }
        }
      }
      const view = store.query(0n, store.length, 1024);
      for (let bin = 0; bin < view.bins; bin++) {
        const start = Math.floor((expected.length * bin) / view.bins),
          end = Math.floor((expected.length * (bin + 1)) / view.bins);
        let low = Infinity,
          high = -Infinity;
        for (let sample = start; sample < end; sample++) {
          low = Math.min(low, expected[sample]);
          high = Math.max(high, expected[sample]);
        }
        check(view.low[bin] === low && view.high[bin] === high, 'Analog overview lost a peak or trough');
      }
      ranges.push({ min, max });
    }
    check(
      ranges.some(({ min, max }) => min < -1 && max > 1),
      'The supplied recording does not cover clipping',
    );
    return ranges;
  } finally {
    capture.store.dispose();
    for (const channel of capture.analogChannels) channel.store.dispose();
  }
}

export async function runSRChecks(file) {
  requireChrome();
  const capture = await deadline(importCapture(file, 200000, 8));
  app.setCapture(capture);
  check(
    capture.logicChannelCount === 8 &&
      capture.analogChannels.length === 5 &&
      capture.store.samplerate === 200000 &&
      capture.store.length === 711600n &&
      Number(capture.store.length) / capture.store.samplerate === 3.558,
    'sample.sr channel counts, sample rate or timeline differ from PulseView',
  );
  const exported = await deadline(capture.store.exportSR(undefined, capture.triggerSample)),
    roundtrip = await deadline(importCapture(new File([exported], 'roundtrip.sr'), 200000, 8)),
    workerUrl = URL.createObjectURL(
      new Blob(
        [
          `import { readZip } from ${JSON.stringify(new URL('../src/web/zip.ts', import.meta.url).href)};
        import { importSR } from ${JSON.stringify(new URL('../src/web/sr.ts', import.meta.url).href)};
        import { AnalogSampleStore } from ${JSON.stringify(new URL('../src/web/data/analogStore.ts', import.meta.url).href)};
        import { AnalogConversion } from ${JSON.stringify(new URL('../src/web/analog-conversion.ts', import.meta.url).href)};
        import { defaultAnalogSettings } from ${JSON.stringify(new URL('../src/web/analog-settings.ts', import.meta.url).href)};
        const check = ${check}; onmessage = ({data}) => (${inspectAnalogSR})(data, {readZip, importSR, AnalogSampleStore, AnalogConversion, defaultAnalogSettings}).then(
        ranges => postMessage({ranges}), error => postMessage({error: error.message}));`,
        ],
        { type: 'text/javascript' },
      ),
    ),
    worker = new Worker(workerUrl, { type: 'module' });
  try {
    const ranges = await deadline(
      new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data.ranges));
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({ file, exported });
      }),
    );
    const checkRanges = () => {
      for (const store of [capture.store, roundtrip.store])
        check(
          JSON.stringify(store.analogMetadata.map((item) => item.range)) === JSON.stringify(ranges),
          'Worker amplitude metadata differs from the original samples',
        );
    };
    checkRanges();
    app.renderer.setViewport(0n, 32n);
    checkRanges();
    app.renderer.pan(100000n);
    checkRanges();
    app.renderer.fit();
    return { samples: String(capture.store.length), sampleRate: capture.store.samplerate, duration: 3.558, ranges };
  } finally {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    roundtrip.store.dispose();
  }
}

export async function runHardwareChecks() {
  await requireRealH417();
  check(
    driverDefinitions.some((definition) => definition.descriptor.id === 'ch32h417'),
    'Hardware driver is missing from the generated manifest',
  );
  if (app.deviceControls.device.descriptor.id !== 'ch32h417') change('device-select', 'ch32h417');
  const device = app.deviceControls.device;
  check(await deadline(device.restore()), 'Real H417 device could not be restored');
  check(device.connected, 'Real H417 device is disconnected');
  check(
    !document.getElementById('device-sampling').hidden && !document.getElementById('device-options').hidden,
    'Device sampling and options stayed hidden while the real device was connected',
  );
  const samples = 200_000n;
  const rates = device.descriptor.capabilities.sampleRate.values;
  change('sample-rate', rates[0]);
  check(
    !app.deviceControls.ready && document.getElementById('run-capture').disabled,
    'Capture stayed enabled while Worker configuration was pending',
  );
  change('sample-rate', device.descriptor.capabilities.sampleRate.default);
  change('sample-limit', samples);
  change('device-channel-count', 8);
  await deadline(app.deviceControls.refreshCapabilities());
  check(app.deviceControls.ready, 'Worker configuration did not become ready');
  const configuration = app.deviceControls.configuration();
  const settings = await deadline(device.configure(configuration));
  check(
    settings.configuration.sampleRate === configuration.sampleRate &&
      BigInt(settings.configuration.sampleCount) === samples &&
      settings.capabilities.sampleRate.values.includes(configuration.sampleRate),
    'Worker configuration differs from the real device capabilities',
  );
  check(
    app.deviceControls.configuration().sampleRate === device.descriptor.capabilities.sampleRate.default,
    'An old Worker response overwrote the latest configuration',
  );
  const unsupportedConfiguration = { ...configuration, analogChannels: 1 };
  const adjusted = await deadline(device.configure(unsupportedConfiguration));
  check(
    adjusted.configuration.analogChannels === 0 && adjusted.capabilities.analogChannels.values.includes(0),
    'Worker did not normalize unsupported real-device channels',
  );
  let invalidConfigurationError;
  try {
    await deadline(device.prepare(unsupportedConfiguration));
  } catch (error) {
    invalidConfigurationError = error;
  }
  check(
    invalidConfigurationError?.message.includes('analogChannels'),
    'Capture preparation did not revalidate the configuration in the Worker',
  );
  const description = await deadline(device.prepare(configuration));
  check(
    description.layout === 'packed-logic' &&
      description.worker.driverId === device.descriptor.id &&
      !('managedBuffers' in description),
    'Worker acquisition contract differs',
  );
  const protocols = decoderDefinitions.map(
    (definition) =>
      app.protocols.find((item) => item.decoder === definition.descriptor.id) ??
      app.addProtocol(definition.descriptor.id, false),
  );
  for (const protocol of protocols) {
    const definition = decoderDefinitions.find((item) => item.descriptor.id === protocol.decoder);
    protocol.mapping = Object.fromEntries(
      definition.ui.inputs.filter((input) => !input.optional).map((input) => [input.key, 0]),
    );
    if (!Object.keys(protocol.mapping).length) protocol.mapping[definition.ui.inputs[0].key] = 0;
  }
  app.selectProtocol(protocols[0].id, false);
  await deadline(app.startCapture());
  const capture = app.capture;
  check(capture?.store.length === samples, 'Real capture sample count differs');
  check(
    capture.acquisition?.worker && capture.acquisition.stopReason === 'complete',
    'Real acquisition did not complete in a Worker',
  );
  check(
    capture.diagnostics.mainThreadAppend.calls === 0 && capture.diagnostics.mainThreadPublish.calls === 0,
    'Main thread processed sample data',
  );
  check(capture.diagnostics.driver['transport.receivedBytes'] > 0, 'No real USB data was received');
  check(
    !('h417Transport' in capture.diagnostics) && !('h417Worker' in capture.diagnostics),
    'Device-specific diagnostics leaked into the framework',
  );
  for (const protocol of protocols) {
    check(
      protocol.state === 'done' && protocol.result?.stats.samples === samples,
      'Worker decode failed: ' + protocol.decoder,
    );
    check(!('binaries' in protocol.result.result), 'Full binary results escaped Worker storage');
    check(
      Object.values(protocol.result.result.previews).every((preview) => preview.length <= 100),
      'UI preview exceeds its bound',
    );
    const csv = await deadline(protocol.client.readCsv(0, 8, capture.store.samplerate, capture.triggerSample, true));
    check(csv.includes('start_sample'), 'Worker CSV export is missing: ' + protocol.decoder);
    await deadline(protocol.client.queryAnnotations(0n, samples, 100));
    const frames = await deadline(protocol.client.readFrames(0, 8));
    check(frames.length <= 8, 'Worker frame pagination exceeded its request');
    const definition = decoderDefinitions.find((item) => item.descriptor.id === protocol.decoder);
    for (const output of definition.ui.binaryOutputs ?? []) {
      const blob = await deadline(protocol.client.readBinary(output.key));
      const bytes = protocol.result.result.binarySizes[output.key];
      check(
        bytes === undefined ? blob === null : blob?.size === bytes,
        'Worker binary export differs: ' + protocol.decoder + '/' + output.key,
      );
    }
  }
  const blob = await deadline(
    capture.store.exportSR(app.workspaceSettings(), capture.triggerSample, capture.acquisition),
  );
  check(blob.size > 0, 'Real capture export is empty');
  const imported = await deadline(importCapture(new File([blob], 'hardware.sr'), capture.store.samplerate, 8));
  const importedProtocols = [];
  try {
    check(
      imported.store.length === samples && imported.store.samplerate === capture.store.samplerate,
      'Real capture round trip differs',
    );
    for (const protocol of protocols) {
      const client = new DecodeClient();
      try {
        const result = await deadline(client.run(imported, protocol.options, protocol.mapping, protocol.decoder));
        check(
          result.stats.samples === samples &&
            result.stats.frames === protocol.frameCount &&
            result.stats.annotations === protocol.annotationCount,
          'Imported real capture decode differs: ' + protocol.decoder,
        );
        importedProtocols.push({
          decoder: protocol.decoder,
          frames: result.stats.frames,
          annotations: result.stats.annotations,
        });
      } finally {
        client.cancel();
      }
    }
  } finally {
    imported.store.dispose();
  }
  const locale = getLocale();
  try {
    for (const language of ['en', 'zh-CN']) {
      setLocale(language);
      translateDOM();
      for (const definition of [...decoderDefinitions, ...driverDefinitions]) {
        for (const key of Object.keys(definition.messages.en))
          check(t(key) !== key, 'Component translation is missing: ' + language + '/' + key);
      }
    }
  } finally {
    setLocale(locale);
    translateDOM();
  }
  let disconnectedError;
  await device.disconnect();
  try {
    check(
      !app.deviceControls.ready && document.getElementById('run-capture').disabled,
      'Capture stayed enabled after the real device disconnected',
    );
    check(
      document.getElementById('device-sampling').hidden && document.getElementById('device-options').hidden,
      'Device sampling and options remained visible after the real device disconnected',
    );
    await deadline(app.deviceControls.refreshCapabilities());
    check(
      document.getElementById('device-connection-status').textContent === t('device.disconnected'),
      'Disconnecting the real device surfaced a configuration error',
    );
    try {
      await device.prepare(app.deviceControls.configuration());
    } catch (error) {
      disconnectedError = error;
    }
    check(
      disconnectedError?.key === 'driver.ch32h417.error.disconnected',
      'Worker component error lost its translation key',
    );
  } finally {
    check(await deadline(device.restore()), 'Real H417 device could not be restored after disconnect');
    await deadline(app.deviceControls.refreshCapabilities());
    check(
      !document.getElementById('device-sampling').hidden && !document.getElementById('device-options').hidden,
      'Device sampling and options stayed hidden after the real device reconnected',
    );
  }
  for (const protocol of protocols) {
    const frames = await deadline(protocol.client.readFrames(0, 1));
    check(
      frames.length === Math.min(1, protocol.frameCount),
      'Connection-only changes discarded Worker decode storage',
    );
  }
  const runtimeResources = (await uiModuleGraph()).filter((name) =>
    /\/src\/(?:decoders|drivers)\/[^/]+\/(?:index|runtime|worker|transport|engine)\.[jt]s(?:\?|$)/.test(name),
  );
  check(runtimeResources.length === 0, 'UI imported Worker implementations: ' + runtimeResources.join(', '));
  return {
    device: 'ch32h417',
    samples: String(samples),
    sampleRate: capture.store.samplerate,
    protocols: importedProtocols,
    exportBytes: blob.size,
    mainThreadAppend: capture.diagnostics.mainThreadAppend.calls,
    mainThreadPublish: capture.diagnostics.mainThreadPublish.calls,
    driverDiagnostics: capture.diagnostics.driver,
    binarySizes: Object.fromEntries(
      protocols.map((protocol) => [protocol.decoder, protocol.result.result.binarySizes]),
    ),
    uiRuntimeImports: runtimeResources,
    disconnectedErrorKey: disconnectedError.key,
  };
}

export async function runAnalogSettingsChecks() {
  requireChrome();
  const capture = app.capture,
    renderer = app.renderer;
  check(capture?.analogChannels.length >= 2, 'Import a recording with analog channels first');
  renderer.setViewport(0n, 256n);
  await waitForView();
  document.querySelector('.channel-settings').click();
  const form = document.querySelector('dialog.analog-settings form');
  const set = (name, value) => {
    const input = form.elements.namedItem(name);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = String(value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  try {
    set('name', '可配置模拟通道');
    set('color', '#d35f55');
    set('negativeDivs', 1);
    set('divHeight', 80);
    set('autorange', false);
    set('resolution', 5);
    set('conversion', 'schmitt');
    set('threshold', '0.7/2.5');
    for (const traces of ['analog', 'converted', 'both']) {
      set('traces', traces);
      await waitForView();
      const row = renderer.rowLayout().find((row) => row.entry.kind === 'analog' && row.entry.id === 0);
      check(row.height === (traces === 'both' ? 194 : 170), 'Analog division or trace height differs');
      check(
        capture.analogChannels[0].store.query(0n, 256n, 256).logic?.points.length === 256,
        'Worker conversion is missing',
      );
    }
    set('autorange', true);
    check(Number(form.elements.resolution.value) === 11, 'Autoranging did not update V/div');
    set('positiveDivs', 0);
    set('negativeDivs', 0);
    check(document.querySelector('.analog-settings-error').textContent, 'Zero divisions were accepted');
    set('positiveDivs', 1);
    set('negativeDivs', 1);
    form.querySelector('button[type="submit"]').click();
    await waitForView();
    const before = renderer.getRowOrder(),
      analog = before.find((row) => row.kind === 'analog' && row.id === 0);
    renderer.rowOrder = [analog, ...before.filter((row) => row !== analog)];
    const hidden = document.querySelectorAll('.analog-chip input[type="checkbox"]')[1];
    hidden.checked = false;
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    const workspace = app.workspaceSettings(),
      blob = await deadline(capture.store.exportSR(workspace, capture.triggerSample)),
      imported = await deadline(importCapture(new File([blob], 'configured.sr'), capture.store.samplerate, 8));
    try {
      check(
        imported.workspace.rowOrder[0].kind === 'analog' && imported.workspace.rowOrder[0].id === 0,
        'Mixed row order was not saved',
      );
      check(!imported.workspace.analogChannels.includes(1), 'Hidden analog visibility was not saved');
      check(
        JSON.stringify(imported.workspace.analogSettings) === JSON.stringify(renderer.analogSettings),
        'Analog settings did not survive export',
      );
      check(imported.analogChannels[0].name === '可配置模拟通道', 'Configured name was not saved');
      await imported.analogChannels[0].store.prepareView(0n, 128n, 128, imported.workspace.analogSettings[0]);
      check(
        imported.analogChannels[0].store.query(0n, 128n, 128).logic?.points.length === 128,
        'Imported conversion failed',
      );
    } finally {
      imported.store.dispose();
    }
    hidden.checked = true;
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    const settings = { ...renderer.analogSettings[0] };
    renderer.setAnalogSettings(0, {
      ...settings,
      positiveDivs: 1,
      negativeDivs: 0,
      divHeight: 44,
      conversion: 'none',
      threshold: 'average',
    });
    return { settings, firstRow: renderer.getRowOrder()[0], exportBytes: blob.size };
  } finally {
    document.querySelector('dialog.analog-settings')?.remove();
  }
}
