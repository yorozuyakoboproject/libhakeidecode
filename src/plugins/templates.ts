export const DECODER_PLUGIN_TEMPLATE = `export const manifest = {
  id: 'decoder.pulse-counter',
  name: 'Pulse Counter',
  version: '1.0.0',
  kind: 'decoder',
  description: 'Counts pulses and measures pulse widths on a single logic channel.',
};

export const component = {
  descriptor: {
    id: 'pulse-counter',
    name: 'Pulse Counter',
    longname: 'Pulse Counter Decoder',
    desc: 'Counts active pulses and annotates pulse width',
    inputs: ['logic'],
    outputs: ['pulse-counter'],
    tags: ['timing', 'custom'],
    channels: [{ id: 'data', name: 'DATA', desc: 'Digital input channel' }],
    annotations: [['pulse', 'Active pulse']],
    annotationRows: [['pulses', 'Pulses', [0]]],
    options: [
      { id: 'polarity', desc: 'Active polarity', default: 'high', values: ['high', 'low'] },
    ],
  },
  ui: {
    inputs: [{ key: 'data', label: 'DATA' }],
    primaryOptions: ['polarity'],
    rows: [{ label: 'Pulses', classes: [0], color: '#70d7a1' }],
    summary(result) {
      return \`Pulses: \${result.frames}\`;
    },
  },
  messages: {
    en: {
      'decoder.pulse-counter.name': 'Pulse Counter',
      'decoder.pulse-counter.option.polarity': 'Active polarity',
      'decoder.pulse-counter.value.high': 'Active high',
      'decoder.pulse-counter.value.low': 'Active low',
    },
    'zh-CN': {
      'decoder.pulse-counter.name': '脉冲计数器',
      'decoder.pulse-counter.option.polarity': '有效电平',
      'decoder.pulse-counter.value.high': '高电平有效',
      'decoder.pulse-counter.value.low': '低电平有效',
    },
  },
};

export function createWorker(sdk) {
  return {
    id: 'pulse-counter',
    csvHeader: 'index,start_sample,end_sample,width_us',
    csvRow(frame, sampleRate) {
      const us = (Number(frame.es - frame.ss) * 1e6) / sampleRate;
      return \`\${frame.index},\${frame.ss},\${frame.es},\${us.toFixed(3)}\`;
    },
    createRuntime(ctx) {
      const activeLevel = ctx.options.polarity === 'low' ? 0 : 1;
      let pulseStart = null;
      let frames = 0;
      let annotations = 0;
      const batchFrames = [];
      const batchAnns = [];
      return {
        get frameCount() {
          return frames;
        },
        get annotationCount() {
          return annotations;
        },
        memory: () => sdk.resultMemory(),
        async push(window) {
          const view = window.channel('data');
          if (!view || !view.length) return;
          let i = 0;
          while (i < view.length) {
            const bit = view.at(i);
            const sample = window.startSample + BigInt(i);
            if (bit === activeLevel && pulseStart === null) {
              pulseStart = sample;
            } else if (bit !== activeLevel && pulseStart !== null) {
              const us = ((Number(sample - pulseStart) * 1e6) / ctx.sampleRate).toFixed(1);
              frames++;
              annotations++;
              batchFrames.push({ index: frames, ss: pulseStart, es: sample, label: \`\${us} µs\` });
              batchAnns.push({
                ss: pulseStart,
                es: sample,
                classIndex: 0,
                texts: [\`#\${frames} · \${us} µs\`, \`\${us}µs\`],
              });
              pulseStart = null;
            }
            const next = view.nextEdge(i + 1);
            if (next <= i) break;
            i = next;
          }
        },
        async flush(progress) {
          if (!batchFrames.length && !batchAnns.length) return;
          await ctx.host.postBatch({
            type: 'batch',
            progress,
            frames: batchFrames.splice(0),
            annotations: batchAnns.splice(0),
          });
        },
        async finish(progress) {
          await this.flush(progress);
          return {
            binaries: {},
            values: { pulses: frames },
            frames,
            annotations,
            truncated: false,
            binaryTruncated: false,
          };
        },
        reset() {
          pulseStart = null;
        },
      };
    },
  };
}
`;

export const DRIVER_PLUGIN_TEMPLATE = `export const manifest = {
  id: 'driver.square-gen',
  name: 'Square Wave Generator',
  version: '1.0.0',
  kind: 'driver',
  description: 'Custom synthetic capture driver producing configurable square waves in a Web Worker.',
};

const DESCRIPTOR = {
  id: 'square-gen',
  name: 'Square Wave Generator',
  capabilities: {
    sampleRate: { kind: 'list', values: [100_000, 1_000_000, 10_000_000], default: 1_000_000 },
    sampleCount: { kind: 'range', min: 1_000n, max: 2_000_000n, step: 1_000n, default: 100_000n },
    logicChannels: { kind: 'range', min: 1, max: 8, step: 1, default: 2 },
    analogChannels: { kind: 'range', min: 0, max: 1, step: 1, default: 1 },
  },
  options: [
    { id: 'frequencyHz', name: 'Base frequency (Hz)', kind: 'number', min: 10, max: 500_000, step: 10, default: 2000 },
  ],
};

export const component = {
  descriptor: DESCRIPTOR,
  messages: {
    en: {
      'driver.square-gen.name': 'Square Wave Generator',
      'driver.square-gen.option.frequencyHz': 'Base frequency (Hz)',
    },
    'zh-CN': {
      'driver.square-gen.name': '方波信号发生驱动',
      'driver.square-gen.option.frequencyHz': '基础频率 (Hz)',
    },
  },
};

export function createWorker(sdk) {
  return {
    id: 'square-gen',
    createDevice() {
      return {
        layout: 'channel-arrays',
        descriptor: DESCRIPTOR,
        getCapabilities() {
          return DESCRIPTOR.capabilities;
        },
        getAcquisitionDescription() {
          return {
            layout: 'channel-arrays',
            logicSampleBytes: 1,
            analogSampleBytes: 4,
            chunkSamples: 65_536,
          };
        },
        async *createSource(configuration, context) {
          sdk.validateDeviceConfiguration(this, configuration);
          const total = Number(configuration.sampleCount);
          const chunkSize = Math.min(context?.chunkSamples ?? 65_536, total);
          const freq = Number(configuration.options.frequencyHz ?? 2000);
          const rate = configuration.sampleRate;
          const logic = sdk.deviceChannelIndices(configuration, 'logic');
          const analog = sdk.deviceChannelIndices(configuration, 'analog');
          for (let start = 0; start < total; start += chunkSize) {
            context?.signal?.throwIfAborted();
            await context?.acquireBuffer?.();
            const len = Math.min(chunkSize, total - start);
            const channels = {};
            for (let c = 0; c < logic.length; c++) {
              const arr = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                const phase = (((start + i) / rate) * freq * (c + 1)) % 1;
                arr[i] = phase < 0.5 ? 1 : 0;
              }
              channels[\`D\${logic[c]}\`] = arr;
            }
            const analogChannels = {};
            for (const ch of analog) {
              const arr = new Float32Array(len);
              for (let i = 0; i < len; i++) {
                arr[i] = Math.sin((2 * Math.PI * freq * (start + i)) / rate);
              }
              analogChannels[\`A\${ch}\`] = arr;
            }
            yield sdk.createSampleChunk({
              startSample: BigInt(start),
              sampleRate: rate,
              channels,
              analogChannels,
            });
          }
        },
      };
    },
  };
}
`;
