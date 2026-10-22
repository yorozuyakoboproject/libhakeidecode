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

export async function runHardwareChecks() {
  check(/Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent), 'Run this check in Google Chrome');
  check(crossOriginIsolated && navigator.usb, 'WebUSB and cross-origin isolation are required');
  const devices = (await navigator.usb.getDevices()).filter(
    (device) => device.vendorId === USB_VID && device.productId === USB_PID && device.serialNumber?.startsWith('H417-'),
  );
  check(devices.length > 0, 'No authorized real H417 device; stop without testing');
  check(
    driverDefinitions.some((definition) => definition.descriptor.id === 'ch32h417'),
    'Hardware driver is missing from the generated manifest',
  );
  if (app.deviceControls.device.descriptor.id !== 'ch32h417') change('device-select', 'ch32h417');
  const device = app.deviceControls.device;
  check(await deadline(device.restore()), 'Real H417 device could not be restored');
  check(device.connected, 'Real H417 device is disconnected');
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
