import { availableParallelism, freemem, totalmem } from 'node:os';
import { stat } from 'node:fs/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const DEFAULT_CASE_TIMEOUT_MS = 300_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;
const MIN_PAYLOAD_BITS = 1_048_576;
const root = new URL('../', import.meta.url);

function describe(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item + 'n' : item));
}

function equalExpected(wanted, received) {
  if (wanted !== null && typeof wanted === 'object' && !Array.isArray(wanted)) {
    return (
      typeof received === 'number' && Number.isFinite(received) && Math.abs(received - wanted.value) <= wanted.tolerance
    );
  }
  return describe(wanted) === describe(received);
}

function protocolInputs(descriptor) {
  return (descriptor.inputs ?? []).filter((input) => input !== 'logic');
}

function bindInputs(descriptor, parentId, parentOutputs) {
  return Object.fromEntries(
    protocolInputs(descriptor).map((input) => {
      const protoId = parentOutputs.includes(input) ? input : undefined;
      if (!protoId) throw new Error(`Parent does not provide protocol input ${input}`);
      return [input, { instanceId: parentId, protoId }];
    }),
  );
}

async function runProtocol(protocol) {
  const directory = new URL('dist/src/decoders/' + protocol + '/', root);
  const [{ cases }, { createEncoder }] = await Promise.all([
    import(new URL('generator.js', directory)),
    import(new URL('encoder.js', directory)),
  ]);
  const [{ DecodeGraphRuntime }, { decoderDefinition }, { ensureBuiltinDecoderWorker }, { createEdgesWindow }] =
    await Promise.all([
      import(new URL('dist/src/decoders/graph-runtime.js', root)),
      import(new URL('dist/src/decoders/index.js', root)),
      import(new URL('dist/src/decoders/workers.js', root)),
      import(new URL('dist/src/libhakeidecode/signal.js', root)),
    ]);
  let boundaries = 0,
    longCases = 0;
  for (const inputFormat of ['native', 'edges']) {
    for (const testCase of cases()) {
      const { generate, ...config } = testCase;
      parentPort.postMessage({ type: 'case', config: { ...config, inputFormat } });
      const chain = config.chain ?? [];
      const nodes = [];
      let parentId = null,
        parentOutputs = [];
      for (let index = 0; index < chain.length; index++) {
        const entry = chain[index],
          descriptor = decoderDefinition(entry.decoder).descriptor,
          id = `upstream-${index}`;
        nodes.push({
          id,
          decoder: entry.decoder,
          options: { ...entry.options },
          ...(index === 0 && !protocolInputs(descriptor).length ? { channels: { ...config.channels } } : {}),
          ...(parentId ? { inputs: bindInputs(descriptor, parentId, parentOutputs) } : {}),
        });
        parentId = id;
        parentOutputs = descriptor.outputs ?? [];
      }
      const leafDescriptor = decoderDefinition(protocol).descriptor;
      nodes.push({
        id: 'leaf',
        decoder: protocol,
        options: { ...config.options },
        ...(parentId
          ? { inputs: bindInputs(leafDescriptor, parentId, parentOutputs) }
          : { channels: { ...config.channels } }),
      });

      const pending = [];
      let compared = 0,
        expectedCount = 0,
        declaredAnnotationCount = 0,
        declaredAnnotationBlocks = 0,
        comparedAnnotations = 0,
        actualAnnotationCount = 0,
        pendingAnnotations = [],
        payloadBits = 0,
        waveformBlocks = 0,
        generatedBlocks = 0,
        maximumPending = 0;
      let nextSample = config.startSample;
      const host = {
        async postBatch(instanceId, batch) {
          if (instanceId !== 'leaf') return;
          actualAnnotationCount += batch.annotations.length;
          for (const actual of batch.annotations) {
            const expected = pendingAnnotations[0];
            if (!expected) continue;
            if (Object.entries(expected).every(([key, wanted]) => equalExpected(wanted, actual[key]))) {
              pendingAnnotations.shift();
              comparedAnnotations++;
            }
          }
          for (const actual of batch.frames) {
            const expected = pending.shift();
            if (!expected) throw new Error('frame[' + compared + ']: unexpected frame ' + describe(actual));
            for (const [key, wanted] of Object.entries(expected)) {
              const received = actual[key];
              if (!equalExpected(wanted, received))
                throw new Error(
                  'frame[' +
                    compared +
                    '].' +
                    key +
                    ': expected ' +
                    describe(wanted) +
                    ', received ' +
                    describe(received) +
                    '; frame=' +
                    describe(actual),
                );
            }
            compared++;
          }
        },
        postPaged() {
          throw new Error('Runtime unexpectedly switched to paged output');
        },
      };
      await Promise.all(nodes.map((node) => ensureBuiltinDecoderWorker(node.decoder)));
      const graph = new DecodeGraphRuntime(nodes, {
        sampleRate: config.sampleRate,
        paged: 'never',
        host,
      });
      const encoder = createEncoder(testCase);
      const previousLevels = new Map();
      async function push(windows) {
        for (const window of windows) {
          if (window.startSample !== nextSample || window.length < 1 || window.sampleRate !== config.sampleRate)
            throw new Error('Noncontiguous or invalid waveform block at ' + nextSample);
          nextSample = window.endSample;
          waveformBlocks++;
          let input = window;
          if (inputFormat === 'edges') {
            const channels = {};
            for (const id of window.channelIds) {
              const view = window.channel(id),
                initial = view.at(0),
                edges = [];
              if (previousLevels.has(id) && previousLevels.get(id) !== initial) edges.push(window.startSample);
              for (let cursor = 1; cursor < window.length;) {
                const edge = view.nextEdge(cursor);
                if (edge >= window.length) break;
                edges.push(window.startSample + BigInt(edge));
                cursor = edge + 1;
              }
              previousLevels.set(id, view.at(window.length - 1));
              channels[id] = { initial, edges };
            }
            input = createEdgesWindow(window.startSample, window.endSample, window.sampleRate, channels);
          }
          await graph.push(input, 0);
        }
      }
      for (const block of generate.call(testCase)) {
        if (
          !Number.isSafeInteger(block.payloadBits) ||
          block.payloadBits <= 0 ||
          !block.data.length ||
          (!block.expected.length && !block.expectedAnnotations?.length)
        )
          throw new Error('Generator produced an empty block, observation or invalid payload bit count');
        pending.push(...block.expected);
        if (block.expectedAnnotations) {
          pendingAnnotations.push(...block.expectedAnnotations);
        }
        if (block.annotationCount !== undefined) {
          if (!Number.isSafeInteger(block.annotationCount) || block.annotationCount < 0)
            throw new Error('Generator produced an invalid annotation count');
          declaredAnnotationCount += block.annotationCount;
          declaredAnnotationBlocks++;
        }
        expectedCount += block.expected.length;
        payloadBits += block.payloadBits;
        maximumPending = Math.max(maximumPending, pending.length);
        if (maximumPending > 4096)
          throw new Error('Expected frames are accumulating without bounded streaming progress');
        generatedBlocks++;
        await push(encoder.push(block.data));
      }
      await push(encoder.finish());
      const results = await graph.finish(1);
      const result = results.find((item) => item.id === 'leaf')?.result;
      if (!result) throw new Error('Leaf decoder produced no result');
      if (pending.length) throw new Error('frame[' + compared + ']: missing frame; expected ' + describe(pending[0]));
      if (pendingAnnotations.length) throw new Error('Missing annotation; expected ' + describe(pendingAnnotations[0]));
      if (declaredAnnotationBlocks && declaredAnnotationCount !== actualAnnotationCount)
        throw new Error(
          'Annotation count differs: expected=' +
            declaredAnnotationCount +
            ', received=' +
            actualAnnotationCount +
            ', matched=' +
            comparedAnnotations,
        );
      if (
        !expectedCount ||
        result.frames !== expectedCount ||
        compared !== expectedCount ||
        result.truncated ||
        result.binaryTruncated
      )
        throw new Error(
          'Frame count or completeness differs: expected=' +
            expectedCount +
            ', compared=' +
            compared +
            ', result=' +
            describe({
              frames: result.frames,
              truncated: result.truncated,
              binaryTruncated: result.binaryTruncated,
            }),
        );
      if (config.kind === 'long') {
        if (
          payloadBits < MIN_PAYLOAD_BITS ||
          payloadBits < config.minimumPayloadBits ||
          waveformBlocks < 2 ||
          generatedBlocks < 2
        )
          throw new Error(
            'Long case requires at least ' +
              Math.max(MIN_PAYLOAD_BITS, config.minimumPayloadBits) +
              ' payload bits across multiple data and waveform blocks',
          );
        longCases++;
      } else if (config.kind === 'boundary') boundaries++;
      else throw new Error('Unknown roundtrip case kind: ' + config.kind);
      parentPort.postMessage({
        type: 'pass',
        name: config.name + '/' + inputFormat,
        payloadBits,
        frames: compared,
        generatedBlocks,
        waveformBlocks,
        maximumPending,
      });
    }
  }
  if (!boundaries || !longCases) throw new Error('Protocol requires both fixed boundary and seeded long cases');
  parentPort.postMessage({ type: 'done' });
}

function caseLabel(config) {
  return (config.name ?? config.phase ?? 'load') + (config.inputFormat ? '/' + config.inputFormat : '');
}

function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(1) + 's';
}

async function runWorker(protocol, position, total, active, emit) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { protocol } });
  let config = { phase: 'load', seed: null };
  const status = {
    protocol,
    config,
    startedAt: performance.now(),
    caseStartedAt: performance.now(),
  };
  active.add(status);
  emit('[decoder roundtrip] RUN ' + protocol + ' (' + position + '/' + total + ')');
  let timer;
  try {
    await new Promise((resolve, reject) => {
      const timeout = Number(process.env.DECODER_CASE_TIMEOUT_MS ?? DEFAULT_CASE_TIMEOUT_MS),
        deadline = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () => reject(new Error('Timed out after ' + timeout + ' ms')),
            Number.isSafeInteger(timeout) && timeout > 0 ? timeout : DEFAULT_CASE_TIMEOUT_MS,
          );
        };
      deadline();
      worker.on('message', (message) => {
        if (message.type === 'case') {
          config = message.config;
          status.config = config;
          status.caseStartedAt = performance.now();
          deadline();
        } else if (message.type === 'pass') {
          emit(
            '[decoder roundtrip] PASS ' +
              protocol +
              '/' +
              message.name +
              ' seed=' +
              config.seed +
              ' payload=' +
              message.payloadBits +
              ' bit frames=' +
              message.frames +
              ' dataBlocks=' +
              message.generatedBlocks +
              ' waveformBlocks=' +
              message.waveformBlocks +
              ' pending<=' +
              message.maximumPending,
          );
        } else if (message.type === 'done') resolve();
        else reject(new Error('Unknown roundtrip worker message'));
      });
      worker.on('error', reject);
      worker.on('exit', (code) => reject(new Error('Worker exited before completion, code=' + code)));
    });
  } catch (error) {
    emit(
      '[decoder roundtrip] FAIL protocol=' + protocol + ' config=' + describe(config) + '\n' + (error.stack ?? error),
    );
    return { protocol, failed: true, error };
  } finally {
    clearTimeout(timer);
    active.delete(status);
    await worker.terminate();
  }
  return { protocol, failed: false };
}

async function runBranchRoundtrip(emit) {
  const protocol = 'nunchuk';
  const directory = new URL('dist/src/decoders/' + protocol + '/', root);
  const [{ cases }, { createEncoder }] = await Promise.all([
    import(new URL('generator.js', directory)),
    import(new URL('encoder.js', directory)),
  ]);
  const [{ DecodeGraphRuntime }, { decoderDefinition }, { ensureBuiltinDecoderWorker }, { createEdgesWindow }] =
    await Promise.all([
      import(new URL('dist/src/decoders/graph-runtime.js', root)),
      import(new URL('dist/src/decoders/index.js', root)),
      import(new URL('dist/src/decoders/workers.js', root)),
      import(new URL('dist/src/libhakeidecode/signal.js', root)),
    ]);
  const testCase = [...cases({ minimumPayloadBits: 0 })].find((item) => item.kind === 'boundary' && item.chain?.length);
  if (!testCase) throw new Error('Branch test requires a downstream boundary case');
  const config = testCase;
  const chain = config.chain ?? [];
  const nodes = [];
  let parentId = null,
    parentOutputs = [];
  for (let index = 0; index < chain.length; index++) {
    const entry = chain[index],
      descriptor = decoderDefinition(entry.decoder).descriptor,
      id = `branch-parent-${index}`;
    nodes.push({
      id,
      decoder: entry.decoder,
      options: { ...entry.options },
      ...(index === 0 && !protocolInputs(descriptor).length ? { channels: { ...config.channels } } : {}),
      ...(parentId ? { inputs: bindInputs(descriptor, parentId, parentOutputs) } : {}),
    });
    parentId = id;
    parentOutputs = descriptor.outputs ?? [];
  }
  if (!parentId) throw new Error('Branch test requires a protocol parent');
  const leafDescriptor = decoderDefinition(protocol).descriptor;
  for (const id of ['branch-left', 'branch-right'])
    nodes.push({
      id,
      decoder: protocol,
      options: { ...config.options },
      inputs: bindInputs(leafDescriptor, parentId, parentOutputs),
    });
  await Promise.all(nodes.map((node) => ensureBuiltinDecoderWorker(node.decoder)));
  for (const inputFormat of ['native', 'edges']) {
    const hostFrames = { 'branch-left': 0, 'branch-right': 0 };
    const hostAnnotations = { 'branch-left': 0, 'branch-right': 0 };
    const graph = new DecodeGraphRuntime(nodes, {
      sampleRate: config.sampleRate,
      paged: 'never',
      host: {
        async postBatch(instanceId, batch) {
          if (instanceId === 'branch-left' || instanceId === 'branch-right') {
            hostFrames[instanceId] += batch.frames.length;
            hostAnnotations[instanceId] += batch.annotations.length;
          }
        },
        postPaged() {
          throw new Error('Runtime unexpectedly switched to paged output');
        },
      },
    });
    const previousLevels = new Map();
    async function push(windows) {
      for (const window of windows) {
        let input = window;
        if (inputFormat === 'edges') {
          const channels = {};
          for (const id of window.channelIds) {
            const view = window.channel(id),
              initial = view.at(0),
              edges = [];
            if (previousLevels.has(id) && previousLevels.get(id) !== initial) edges.push(window.startSample);
            for (let cursor = 1; cursor < window.length;) {
              const edge = view.nextEdge(cursor);
              if (edge >= window.length) break;
              edges.push(window.startSample + BigInt(edge));
              cursor = edge + 1;
            }
            previousLevels.set(id, view.at(window.length - 1));
            channels[id] = { initial, edges };
          }
          input = createEdgesWindow(window.startSample, window.endSample, window.sampleRate, channels);
        }
        await graph.push(input, 0);
      }
    }
    const encoder = createEncoder(testCase);
    for (const block of testCase.generate()) await push(encoder.push(block.data));
    await push(encoder.finish());
    const results = await graph.finish(1);
    const left = results.find((item) => item.id === 'branch-left')?.result,
      right = results.find((item) => item.id === 'branch-right')?.result;
    if (!left || !right) throw new Error('Branch graph did not return both downstream results');
    if (!left.frames || !right.frames) throw new Error('Branch graph produced an empty downstream result');
    if (
      left.frames !== right.frames ||
      left.annotations !== right.annotations ||
      hostFrames['branch-left'] !== hostFrames['branch-right'] ||
      hostAnnotations['branch-left'] !== hostAnnotations['branch-right']
    )
      throw new Error(
        'Branched downstream results differ: ' +
          describe({
            left: { frames: left.frames, annotations: left.annotations, host: hostFrames['branch-left'] },
            right: { frames: right.frames, annotations: right.annotations, host: hostFrames['branch-right'] },
          }),
      );
    emit(
      '[decoder roundtrip] PASS branch i2c->nunchuk*2/' +
        inputFormat +
        ' frames=' +
        left.frames +
        ' annotations=' +
        left.annotations,
    );
  }
  return { protocol: 'branch:i2c->nunchuk*2', failed: false };
}

export async function runDecoderRoundtrips(components) {
  const protocols = [];
  for (const { kind, name } of components) {
    if (kind !== 'decoder') continue;
    const entries = await Promise.all(
      ['generator', 'encoder'].map(async (entry) => {
        try {
          return (await stat(new URL('src/decoders/' + name + '/' + entry + '.ts', root))).isFile();
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      }),
    );
    if (!entries[0] && !entries[1]) continue;
    else if (!entries.every(Boolean))
      throw new Error(
        '[decoder roundtrip] FAIL protocol=' + name + ': generator.ts and encoder.ts must be provided together',
      );
    else protocols.push(name);
  }
  protocols.sort();
  const configured = Number(process.env.DECODER_TEST_CONCURRENCY ?? availableParallelism());
  const memoryLimited = freemem() < totalmem() * 0.25;
  const concurrency = Math.max(
    1,
    Math.min(
      protocols.length,
      Number.isSafeInteger(configured) && configured > 0 ? configured : availableParallelism(),
      memoryLimited ? 4 : Infinity,
    ),
  );
  const emit = (line) => console.log(line);
  const configuredProgress = Number(process.env.DECODER_PROGRESS_INTERVAL_MS ?? DEFAULT_PROGRESS_INTERVAL_MS);
  const progressInterval =
    Number.isSafeInteger(configuredProgress) && configuredProgress > 0
      ? configuredProgress
      : DEFAULT_PROGRESS_INTERVAL_MS;
  const configuredTimeout = Number(process.env.DECODER_CASE_TIMEOUT_MS ?? DEFAULT_CASE_TIMEOUT_MS);
  const timeout =
    Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_CASE_TIMEOUT_MS;
  emit(
    '[decoder roundtrip] protocols=' +
      protocols.length +
      ' concurrency=' +
      concurrency +
      ' timeout=' +
      seconds(timeout) +
      ' progress=' +
      seconds(progressInterval) +
      (memoryLimited ? ' (memory-limited)' : ''),
  );
  const results = new Array(protocols.length);
  const active = new Set();
  let next = 0;
  const progressTimer = setInterval(() => {
    if (!active.size) return;
    const now = performance.now();
    const running = [...active].sort((left, right) => right.caseStartedAt - left.caseStartedAt);
    const shown = running
      .slice(0, 4)
      .map((status) => status.protocol + '/' + caseLabel(status.config) + ' ' + seconds(now - status.caseStartedAt));
    const hidden = running.length - shown.length;
    emit(
      '[decoder roundtrip] WAIT running=' +
        running.length +
        ' queued=' +
        Math.max(0, protocols.length - next) +
        ' | ' +
        shown.join(' | ') +
        (hidden ? ' | +' + hidden + ' more' : ''),
    );
  }, progressInterval);
  progressTimer.unref();
  async function slot() {
    while (next < protocols.length) {
      const index = next++;
      results[index] = await runWorker(protocols[index], index + 1, protocols.length, active, emit);
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, slot));
  } finally {
    clearInterval(progressTimer);
  }
  if (protocols.includes('nunchuk')) {
    emit('[decoder roundtrip] RUN branch:i2c->nunchuk*2');
    try {
      results.push(await runBranchRoundtrip(emit));
    } catch (error) {
      emit('[decoder roundtrip] FAIL branch:i2c->nunchuk*2\n' + (error.stack ?? error));
      results.push({
        protocol: 'branch:i2c->nunchuk*2',
        failed: true,
      });
    }
  }
  const failed = [];
  for (const result of results) if (result.failed) failed.push(result);
  if (failed.length)
    throw new Error(
      '[decoder roundtrip] ' + failed.length + ' protocol(s) failed: ' + failed.map((item) => item.protocol).join(', '),
    );
  emit('[decoder roundtrip] all ' + (protocols.length + (protocols.includes('nunchuk') ? 1 : 0)) + ' protocols passed');
}

if (!isMainThread) await runProtocol(workerData.protocol);
