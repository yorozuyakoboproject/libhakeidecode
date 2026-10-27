import { stat } from 'node:fs/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const CASE_TIMEOUT_MS = 120_000;
const MIN_PAYLOAD_BITS = 1_048_576;
const root = new URL('../', import.meta.url);

function describe(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item + 'n' : item));
}

async function runProtocol(protocol) {
  const directory = new URL('dist/src/decoders/' + protocol + '/', root);
  const [{ cases }, { createEncoder }, { worker }] = await Promise.all([
    import(new URL('generator.js', directory)),
    import(new URL('encoder.js', directory)),
    import(new URL('worker.js', directory)),
  ]);
  let boundaries = 0,
    longCases = 0;
  for (const testCase of cases()) {
    const { generate, ...config } = testCase;
    parentPort.postMessage({ type: 'case', config });
    let pending = [],
      compared = 0,
      expectedCount = 0,
      payloadBits = 0,
      waveformBlocks = 0,
      generatedBlocks = 0;
    let nextSample = config.startSample;
    let maximumPending = 0;
    const runtime = worker.createRuntime({
      sampleRate: config.sampleRate,
      channels: Object.keys(config.channels),
      options: { ...config.options },
      paged: 'never',
      host: {
        async postBatch(batch) {
          for (const actual of batch.frames) {
            const expected = pending.shift();
            if (!expected) throw new Error('frame[' + compared + ']: unexpected frame ' + describe(actual));
            for (const [key, wanted] of Object.entries(expected)) {
              const received = actual[key];
              const matches =
                wanted !== null && typeof wanted === 'object'
                  ? typeof received === 'number' &&
                    Number.isFinite(received) &&
                    Math.abs(received - wanted.value) <= wanted.tolerance
                  : received === wanted;
              if (!matches)
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
      },
    });
    const encoder = createEncoder(testCase);
    async function push(windows) {
      for (const window of windows) {
        if (window.startSample !== nextSample || window.length < 1 || window.sampleRate !== config.sampleRate)
          throw new Error('Noncontiguous or invalid waveform block at ' + nextSample);
        nextSample = window.endSample;
        waveformBlocks++;
        await runtime.push(window, 0);
        await runtime.flush(0);
      }
    }
    for (const block of generate()) {
      if (
        !Number.isSafeInteger(block.payloadBits) ||
        block.payloadBits <= 0 ||
        !block.data.length ||
        !block.expected.length
      )
        throw new Error('Generator produced an empty block or invalid payload bit count');
      pending.push(...block.expected);
      expectedCount += block.expected.length;
      payloadBits += block.payloadBits;
      maximumPending = Math.max(maximumPending, pending.length);
      if (maximumPending > 4096) throw new Error('Expected frames are accumulating without bounded streaming progress');
      generatedBlocks++;
      await push(encoder.push(block.data));
    }
    await push(encoder.finish());
    const result = await runtime.finish(1);
    if (pending.length) throw new Error('frame[' + compared + ']: missing frame; expected ' + describe(pending[0]));
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
          describe({ frames: result.frames, truncated: result.truncated, binaryTruncated: result.binaryTruncated }),
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
      name: config.name,
      payloadBits,
      frames: compared,
      generatedBlocks,
      waveformBlocks,
      maximumPending,
    });
    pending = [];
  }
  if (!boundaries || !longCases) throw new Error('Protocol requires both fixed boundary and seeded long cases');
  parentPort.postMessage({ type: 'done' });
}

async function runWorker(protocol) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { protocol } });
  let config = { phase: 'load', seed: null };
  let timer;
  try {
    await new Promise((resolve, reject) => {
      const deadline = () => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new Error('Timed out after ' + CASE_TIMEOUT_MS + ' ms')), CASE_TIMEOUT_MS);
      };
      deadline();
      worker.on('message', (message) => {
        if (message.type === 'case') {
          config = message.config;
          deadline();
        } else if (message.type === 'pass') {
          console.log(
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
    throw new Error(
      '[decoder roundtrip] FAIL protocol=' + protocol + ' config=' + describe(config) + '\n' + (error.stack ?? error),
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
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
    if (!entries[0] && !entries[1]) console.log('[decoder roundtrip] SKIP ' + name + ': no generator.ts or encoder.ts');
    else if (!entries.every(Boolean))
      throw new Error(
        '[decoder roundtrip] FAIL protocol=' + name + ': generator.ts and encoder.ts must be provided together',
      );
    else protocols.push(name);
  }
  for (const protocol of protocols) await runWorker(protocol);
}

if (!isMainThread) await runProtocol(workerData.protocol);
