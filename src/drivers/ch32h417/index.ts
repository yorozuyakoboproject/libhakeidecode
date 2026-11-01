import { descriptor } from './descriptor.js';
import { ComponentError } from '../../components.js';
import { sampleIndex, type SampleSource } from '../../libhakei/index.js';
import {
  validateDeviceConfiguration,
  deviceChannelIndices,
  type PackedLogicAcquisitionDescription,
  type DeviceCapabilities,
  type DeviceConfiguration,
  type DeviceDescriptor,
  type MultiRateDevice,
  type MultiRateAcquisitionDescription,
  type AcquisitionChunk,
  type PackedLogicChunk,
  type ManagedSampleSourceContext,
  type SampleSourceContext,
  type TransferProgress,
} from '../../libhakei/device.js';
import {
  Command,
  DATA,
  END,
  ANALOG,
  USB_PID,
  USB_VID,
  readCapabilities,
  readStatus,
  type Capabilities,
} from './protocol.js';
import { H417Transport, TRANSPORT_WORKING_BYTES, browserUsb, statusError, type UsbApi } from './transport.js';
async function configureCompression(
  transport: H417Transport,
  caps: Capabilities,
  config: DeviceConfiguration,
): Promise<void> {
  const digital = String(config.options.digitalEncoding ?? 'raw');
  const analog = String(config.options.analogEncoding ?? 'packed');
  if (!['raw', 'runs'].includes(digital) || !['packed', 'split'].includes(analog))
    throw new Error('Invalid H417 compression selection');
  if (caps.appProtocol < 22 || !caps.compressionMask) {
    if (digital !== 'raw' || analog !== 'packed') throw new Error('Firmware does not support independent encoding');
    if (caps.compressionMask) await transport.setCompression(0, 0);
    return;
  }
  await transport.setCompression(digital === 'runs' ? 4 : 0, analog === 'split' ? 1 : 0);
}
function analogSettings(caps: Capabilities, configuration: DeviceConfiguration) {
  const analog = deviceChannelIndices(configuration, 'analog');
  const mask = analog.reduce((m, i) => m | (1 << i), 0),
    hsadc = mask & caps.hsadcMask,
    adc1 = mask & caps.adc1Mask;
  const periods = [0, 1].map((pin) =>
    Number(configuration.options[caps.hsadcMask & (1 << pin) ? 'hsadcPeriod' : 'adc1Period'] ?? 0),
  );
  const bits = [0, 1].map((pin) => Number(configuration.options[`pc${pin + 1}Bits`] ?? (hsadc & (1 << pin) ? 10 : 12)));
  const conversions = [adc1, hsadc].map((streamMask) => {
    if (!streamMask || caps.appProtocol < 21) return 0;
    let period = 0;
    for (const pin of analog)
      if (streamMask & (1 << pin)) {
        if (
          !caps.channelRates.some(
            (r) =>
              r.pin === pin &&
              r.decimation === 1 &&
              r.outputTicks === r.conversionTicks &&
              r.conversionTicks === periods[pin],
          ) ||
          !Number.isInteger(bits[pin]) ||
          bits[pin]! < 8 ||
          bits[pin]! > (hsadc & (1 << pin) ? 10 : 12)
        )
          throw new Error('Unsupported hardware analog setting');
        if (period && period !== periods[pin]) throw new Error('ADC1 pins must share one hardware sample rate');
        period = periods[pin]!;
      }
    return period;
  });
  return { periods, bits, conversions };
}
export type { Capabilities } from './protocol.js';
export interface H417Identity {
  serialNumber: string;
  vendorId: number;
  productId: number;
  capabilities: Capabilities;
}
export type H417TransportMetrics = H417Transport['metrics'];
export interface H417StreamStats {
  samples: bigint;
  frames: number;
  firstByte: number | null;
  lastByte: number | null;
  session: number;
  transport: H417TransportMetrics;
}
export interface H417WorkerMetrics {
  packedCopyMs: number;
  bufferWaitMs: number;
  consumerWaitMs: number;
}
export interface H417StreamOptions {
  readonly onBlock?: (samples: bigint, packed: Uint8Array, transport: H417TransportMetrics) => void | Promise<void>;
  readonly onTransferProgress?: (progress: TransferProgress) => void;
}
export class CH32H417Device implements MultiRateDevice {
  readonly layout = 'multi-rate';
  private identity?: H417Identity;
  private api: UsbApi | null = null;
  onConnectionChange: (() => void) | null = null;
  private readonly disconnected = (event: { device: { serialNumber?: string } }): void => {
    if (event.device.serialNumber === this.identity?.serialNumber) {
      this.identity = undefined;
      this.onConnectionChange?.();
    }
  };
  constructor(initialization?: H417Identity) {
    this.identity = initialization;
  }
  get initialization(): H417Identity | undefined {
    return this.identity;
  }
  get connected(): boolean {
    return !!this.identity;
  }
  async connect(initialization?: unknown): Promise<void> {
    if (!(await this.restore(initialization))) throw new ComponentError('driver.ch32h417.error.unavailable');
  }
  async restore(initialization?: unknown): Promise<boolean> {
    const usb = browserUsb();
    const matches = (await usb.getDevices()).filter(
      (device) =>
        device.vendorId === USB_VID && device.productId === USB_PID && device.serialNumber?.startsWith('H417-'),
    );
    if (!matches.length) return false;
    const serialNumber =
      initialization && typeof initialization === 'object' && 'serialNumber' in initialization
        ? initialization.serialNumber
        : undefined;
    const device =
      matches.find((item) => item.serialNumber === serialNumber) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!device) throw new ComponentError('driver.ch32h417.error.ambiguous');
    const transport = new H417Transport(device);
    try {
      await transport.open();
      const caps = readCapabilities(await transport.command(Command.caps));
      if (!device.serialNumber || caps.packetBytes !== transport.packet)
        throw new Error('H417 endpoint/capability mismatch');
      this.identity = {
        serialNumber: device.serialNumber,
        vendorId: device.vendorId,
        productId: device.productId,
        capabilities: caps,
      };
      if (this.api !== usb) {
        this.api?.removeEventListener?.('disconnect', this.disconnected);
        this.api = usb;
        usb.addEventListener?.('disconnect', this.disconnected);
      }
    } finally {
      await transport.close();
      this.onConnectionChange?.();
    }
    return true;
  }
  async disconnect(): Promise<void> {
    this.identity = undefined;
    this.api?.removeEventListener?.('disconnect', this.disconnected);
    this.api = null;
    this.onConnectionChange?.();
  }
  get descriptor(): DeviceDescriptor {
    return descriptor(this.identity?.capabilities);
  }
  getCapabilities(configuration: DeviceConfiguration): DeviceCapabilities {
    const caps = this.descriptor.capabilities;
    const result: DeviceCapabilities = configuration.logicChannels
      ? caps
      : {
          ...caps,
          timebaseOnly: true,
          sampleRate: { kind: 'list', values: [400000000], default: 400000000 },
        };
    if (!configuration.analogChannels) return result;
    const deviceCaps = this.identity?.capabilities;
    const analogTiming =
      deviceCaps && deviceCaps.appProtocol >= 21
        ? (() => {
            const { bits, conversions } = analogSettings(deviceCaps, configuration);
            return deviceChannelIndices(configuration, 'analog').map((channel) => {
              const conversion = conversions[deviceCaps.hsadcMask & (1 << channel) ? 1 : 0]!;
              return {
                channel,
                sampleRate: 400000000 / conversion,
                outputBits: bits[channel]!,
              };
            });
          })()
        : undefined;
    return {
      ...result,
      analogTiming,
    };
  }
  createSource(configuration: DeviceConfiguration, context?: SampleSourceContext): SampleSource {
    validateDeviceConfiguration(this, configuration);
    if (!this.identity) throw new ComponentError('driver.ch32h417.error.disconnected');
    return this.capture(configuration, context);
  }
  async *createMultiRateSource(
    configuration: DeviceConfiguration,
    context: ManagedSampleSourceContext,
  ): AsyncGenerator<AcquisitionChunk> {
    validateDeviceConfiguration(this, configuration);
    const identity = this.identity;
    if (!identity) throw new ComponentError('driver.ch32h417.error.disconnected');
    const matches = (await browserUsb().getDevices()).filter(
      (d) => d.serialNumber === identity.serialNumber && d.vendorId === USB_VID && d.productId === USB_PID,
    );
    if (matches.length !== 1) throw new Error('Authorized H417 device disconnected or ambiguous');
    const transport = new H417Transport(matches[0]!);
    transport.onTransferProgress = context.reportTransferProgress;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      void transport.stop().catch((error) => transport.abort(error));
    };
    context.signal?.addEventListener('abort', stop, { once: true });
    try {
      await transport.open();
      const caps = readCapabilities(await transport.command(Command.caps));
      if (
        caps.packetBytes !== identity.capabilities.packetBytes ||
        caps.adc1Mask !== identity.capabilities.adc1Mask ||
        caps.hsadcMask !== identity.capabilities.hsadcMask ||
        (configuration.logicChannels && !caps.rates.includes(configuration.sampleRate))
      )
        throw new Error('Device sampling capabilities changed; reconnect the analyzer');
      const analog = deviceChannelIndices(configuration, 'analog');
      const mask = analog.reduce((m, i) => m | (1 << i), 0),
        adc1 = mask & caps.adc1Mask,
        hsadc = mask & caps.hsadcMask;
      if (mask !== (adc1 | hsadc))
        throw new Error('Initialize the selected PC1/PC2 ADC modes in the management page first');
      const { periods, bits, conversions } = analogSettings(caps, configuration);
      const adc1Hz =
          caps.appProtocol >= 21 && adc1 ? 400000000 / conversions[0]! : Number(configuration.options.adc1Hz ?? 0),
        hsadcHz =
          caps.appProtocol >= 21 && hsadc ? 400000000 / conversions[1]! : Number(configuration.options.hsadcHz ?? 0);
      const adcCount = Number(!!(adc1 & 1)) + Number(!!(adc1 & 2));
      if (adc1 && Number(configuration.sampleCount) * adc1Hz <= configuration.sampleRate)
        throw new Error('Capture duration must exceed one ADC1 sample period');
      if (adc1Hz * adcCount > caps.adc1Budget) throw new ComponentError('driver.ch32h417.error.adcRate');
      const selected = deviceChannelIndices(configuration, 'logic');
      const payload = new Uint8Array(caps.appProtocol >= 21 ? 36 : 24),
        view = new DataView(payload.buffer);
      view.setUint32(0, configuration.sampleRate, true);
      view.setBigUint64(4, BigInt(configuration.sampleCount), true);
      view.setUint8(12, selected.length);
      view.setUint8(
        13,
        selected.reduce((m, i) => m | (1 << i), 0),
      );
      view.setUint8(14, adc1);
      view.setUint8(15, hsadc);
      view.setUint32(16, hsadc ? hsadcHz : 0, true);
      view.setUint32(20, adc1 ? adc1Hz : 0, true);
      if (caps.appProtocol >= 21) {
        view.setUint32(24, periods[0]!, true);
        view.setUint32(28, periods[1]!, true);
        view.setUint8(32, bits[0]!);
        view.setUint8(33, bits[1]!);
      }
      await configureCompression(transport, caps, configuration);
      await transport.start(payload);
      let beating = false;
      heartbeat = setInterval(() => {
        if (beating) return;
        beating = true;
        void transport
          .command(Command.keepalive)
          .catch((error) => transport.abort(error))
          .finally(() => {
            beating = false;
          });
      }, 1000);
      let digital = 0n;
      const referenceMv = new Map<number, number>();
      const expected = new Map<number, bigint>(),
        received = new Map<number, bigint>();
      const endTick = (BigInt(configuration.sampleCount) * 400000000n) / BigInt(configuration.sampleRate);
      while (true) {
        context.signal?.throwIfAborted();
        const frame = await transport.next();
        if (!frame) {
          context.signal?.throwIfAborted();
          throw new Error('H417 stream ended without END');
        }
        context.reportDiagnostics?.({
          'transport.receivedBytes': transport.metrics.receivedBytes,
          'compression.rawBytes': transport.metrics.codecRawBytes,
          'compression.wireBytes': transport.metrics.codecWireBytes,
          'compression.cycles': transport.metrics.codecCycles,
          'compression.decodeMs': transport.metrics.codecDecodeMs,
          'compression.maxCycles': transport.metrics.codecMaxCycles,
          'compression.cyclesPerByte': transport.metrics.codecRawBytes
            ? transport.metrics.codecCycles / transport.metrics.codecRawBytes
            : 0,
          'compression.maxHoldMs': transport.metrics.codecMaxHoldMs,
          'compression.queuePeak': transport.metrics.codecQueuePeak,
          'timing.verified': 0,
        });
        if (frame.type === END) {
          const status = readStatus(frame.payload);
          if (
            status.sampleRate !== configuration.sampleRate ||
            status.channels !== selected.length ||
            status.samples !== digital
          )
            throw new Error('H417 final configuration/count mismatch');
          if (status.error) throw statusError(status.error, digital);
          if (configuration.logicChannels && digital !== BigInt(configuration.sampleCount))
            throw new Error('Incomplete digital capture');
          if (analog.some((pin) => !expected.has(pin) || expected.get(pin) !== received.get(pin)))
            throw new Error('Incomplete analog capture');
          await context.acquireBuffer();
          yield { format: 'timeline', length: BigInt(configuration.sampleCount) };
          return;
        }
        if (frame.type === DATA) {
          const buffer = await context.acquireBuffer(),
            data = new Uint8Array(buffer, 0, frame.payload.length);
          const remap = Uint8Array.from({ length: 256 }, (_, v) =>
            selected.reduce((m, c, i) => m | (((v >> c) & 1) << i), 0),
          );
          for (let i = 0; i < data.length; ++i) data[i] = remap[frame.payload[i]!]!;
          yield {
            format: 'packed-logic',
            startSample: digital,
            sampleRate: configuration.sampleRate,
            channelCount: selected.length,
            length: data.length,
            encoding: 'raw8',
            data,
          };
          digital += BigInt(data.length);
          continue;
        }
        if (frame.type !== ANALOG || !frame.analog) throw new Error('Unexpected acquisition frame');
        const info = frame.analog;
        if (
          info.adc1Mask !== adc1 ||
          info.hsadcMask !== hsadc ||
          (info.pin === undefined
            ? info.mask !== (info.timing.bits === 10 ? hsadc : adc1)
            : !(mask & (1 << info.pin)) ||
              info.timing.bits !== bits[info.pin] ||
              info.timing.periodTicks !== BigInt(periods[info.pin]!))
        )
          throw new Error('Analog configuration changed');
        const pins = [0, 1].filter((i) => info.mask & (1 << i)),
          count = frame.payload.length / 2 / pins.length;
        const raw = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        for (let rank = 0; rank < pins.length; ++rank) {
          const pin = pins[rank]!;
          const firstTick =
            info.pin === undefined
              ? info.timing.firstTick + BigInt(info.timing.bits === 12 ? rank * 640 : 0)
              : info.timing.firstTick - frame.firstSample * info.timing.periodTicks;
          const target =
            info.targetSamples ??
            (endTick > firstTick ? (endTick - firstTick + info.timing.periodTicks - 1n) / info.timing.periodTicks : 0n);
          if (!expected.has(pin)) expected.set(pin, target);
          if (frame.firstSample !== (received.get(pin) ?? 0n) || target !== expected.get(pin))
            throw new Error('Analog stream discontinuity');
          const remaining = target - frame.firstSample;
          const take = remaining < BigInt(count) ? Number(remaining) : count;
          if (take <= 0) continue;
          const buffer = await context.acquireBuffer(),
            values = new Float32Array(buffer, 0, take);
          for (let i = 0; i < take; ++i) {
            const value = raw.getUint16((i * pins.length + rank) * 2, true);
            if (value >= 1 << info.timing.bits) throw new Error('ADC result out of range');
            values[i] = value;
          }
          context.reportDiagnostics?.({
            [`PC${pin + 1}.outputHz`]: info.timing.clockHz / Number(info.timing.periodTicks),
            [`PC${pin + 1}.conversionHz`]:
              info.timing.clockHz / Number(info.timing.conversionTicks ?? info.timing.periodTicks),
            [`PC${pin + 1}.bits`]: info.timing.bits,
          });
          if (!referenceMv.has(pin)) referenceMv.set(pin, info.timing.referenceMv);
          yield {
            format: 'analog',
            channel: pin,
            startSample: frame.firstSample,
            data: values,
            timing: {
              ...info.timing,
              firstTick,
              referenceMv: referenceMv.get(pin)!,
            },
          };
          received.set(pin, frame.firstSample + BigInt(take));
        }
      }
    } finally {
      clearInterval(heartbeat);
      context.signal?.removeEventListener('abort', stop);
      try {
        await transport.stop();
      } finally {
        await transport.close();
      }
    }
  }
  getAcquisitionDescription(
    configuration: DeviceConfiguration,
  ): PackedLogicAcquisitionDescription | MultiRateAcquisitionDescription {
    if (!this.identity) throw new ComponentError('driver.ch32h417.error.disconnected');
    return {
      layout: configuration.analogChannels ? 'multi-rate' : 'packed-logic',
      logicSampleBytes: 1,
      analogSampleBytes: 4,
      chunkSamples: 1_048_576,
      workingBytes: TRANSPORT_WORKING_BYTES,
    };
  }
  async *createPackedSource(
    configuration: DeviceConfiguration,
    context: ManagedSampleSourceContext,
  ): AsyncGenerator<PackedLogicChunk> {
    validateDeviceConfiguration(this, configuration);
    if (!this.identity) throw new ComponentError('driver.ch32h417.error.disconnected');
    const capacity = context.chunkSamples ?? 1_048_576;
    const selected = deviceChannelIndices(configuration, 'logic');
    const remap = Uint8Array.from({ length: 256 }, (_, value) =>
      selected.reduce((packed, channel, index) => packed | (((value >>> channel) & 1) << index), 0),
    );
    let buffer: ArrayBuffer | null = null,
      raw: Uint8Array | null = null,
      used = 0,
      start = 0n;
    const workerMetrics: H417WorkerMetrics = {
      packedCopyMs: 0,
      bufferWaitMs: 0,
      consumerWaitMs: 0,
    };
    const encode = (): PackedLogicChunk => {
      context.reportDiagnostics?.({
        'transport.reads': lastTransport?.reads ?? 0,
        'transport.receivedBytes': lastTransport?.receivedBytes ?? 0,
        'transport.parserMs': lastTransport?.parserMs ?? 0,
        'transport.queuePeak': lastTransport?.queuePeak ?? 0,
        'transport.dataFrames': lastTransport?.dataFrames ?? 0,
        'compression.rawBytes': lastTransport?.codecRawBytes ?? 0,
        'compression.wireBytes': lastTransport?.codecWireBytes ?? 0,
        'compression.cycles': lastTransport?.codecCycles ?? 0,
        'compression.maxCycles': lastTransport?.codecMaxCycles ?? 0,
        'compression.maxHoldMs': lastTransport?.codecMaxHoldMs ?? 0,
        'compression.queuePeak': lastTransport?.codecQueuePeak ?? 0,
        'compression.decodeMs': lastTransport?.codecDecodeMs ?? 0,
        'worker.packedCopyMs': workerMetrics.packedCopyMs,
        'worker.bufferWaitMs': workerMetrics.bufferWaitMs,
        'worker.consumerWaitMs': workerMetrics.consumerWaitMs,
      });
      return {
        format: 'packed-logic',
        startSample: start,
        sampleRate: configuration.sampleRate,
        channelCount: configuration.logicChannels,
        length: used,
        encoding: 'raw8',
        data: raw!.subarray(0, used),
      };
    };
    const queue: PackedLogicChunk[] = [];
    let wake: (() => void) | undefined,
      resume: (() => void) | undefined,
      failure: unknown,
      done = false;
    const controller = new AbortController();
    const signal = context?.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    let lastTransport: H417TransportMetrics | undefined;
    const running = this.stream(
      configuration,
      {
        onTransferProgress: context.reportTransferProgress,
        onBlock: async (_position, payload, transport) => {
          lastTransport = transport;
          for (let offset = 0; offset < payload.length;) {
            if (!buffer) {
              const waitStarted = performance.now();
              buffer = await context.acquireBuffer();
              workerMetrics.bufferWaitMs += performance.now() - waitStarted;
              if (buffer.byteLength < capacity || capacity > 0x1000000)
                throw new Error('Invalid packed acquisition buffer');
              raw = new Uint8Array(buffer, 0, capacity);
            }
            const copyStarted = performance.now();
            const n = Math.min(capacity - used, payload.length - offset);
            const source = payload.subarray(offset, offset + n);
            if (configuration.logicChannels === 8) raw!.set(source, used);
            else {
              for (let i = 0; i < n; i++) raw![used + i] = remap[source[i]!]!;
            }
            workerMetrics.packedCopyMs += performance.now() - copyStarted;
            used += n;
            offset += n;
            if (used === capacity) {
              const waiting = new Promise<void>((resolve) => {
                resume = resolve;
              });
              queue.push(encode());
              wake?.();
              wake = undefined;
              const waitStarted = performance.now();
              await waiting;
              workerMetrics.consumerWaitMs += performance.now() - waitStarted;
              signal.throwIfAborted();
              start += BigInt(used);
              used = 0;
              buffer = raw = null;
            }
          }
        },
      },
      signal,
    ).then(
      () => {
        done = true;
        wake?.();
      },
      (error) => {
        failure = error;
        done = true;
        wake?.();
      },
    );
    try {
      while (true) {
        while (!queue.length && !done)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const chunk = queue.shift();
        if (chunk) {
          yield chunk;
          resume?.();
          resume = undefined;
          continue;
        }
        if (used) {
          yield encode();
          used = 0;
        }
        if (failure) throw failure;
        return;
      }
    } finally {
      controller.abort();
      resume?.();
      await running;
    }
  }

  async stream(
    configuration: DeviceConfiguration,
    options: H417StreamOptions = {},
    signal?: AbortSignal,
  ): Promise<H417StreamStats> {
    validateDeviceConfiguration(this, configuration);
    if (!this.identity) throw new ComponentError('driver.ch32h417.error.disconnected');
    const identity = this.identity,
      api = browserUsb();
    const matches = (await api.getDevices()).filter(
      (d) =>
        d.vendorId === identity.vendorId &&
        d.productId === identity.productId &&
        d.serialNumber === identity.serialNumber,
    );
    if (matches.length !== 1) throw new Error('Authorized H417 device disconnected or ambiguous');
    const transport = new H417Transport(matches[0]!);
    transport.onTransferProgress = options.onTransferProgress;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopError: unknown,
      samples = 0n,
      frames = 0,
      firstByte: number | null = null,
      lastByte: number | null = null;
    const stop = () => {
      if (transport.active)
        void transport.stop().catch((error) => {
          stopError = error;
        });
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await transport.open();
      const caps = readCapabilities(await transport.command(Command.caps));
      if (caps.packetBytes !== identity.capabilities.packetBytes || !caps.rates.includes(configuration.sampleRate))
        throw new Error('H417 USB speed changed; reconnect to refresh sampling rates');
      const payload = new Uint8Array(24),
        view = new DataView(payload.buffer);
      view.setUint32(0, configuration.sampleRate, true);
      view.setBigUint64(4, sampleIndex(configuration.sampleCount), true);
      view.setUint8(12, configuration.logicChannels);
      view.setUint8(
        13,
        deviceChannelIndices(configuration, 'logic').reduce((mask, channel) => mask | (1 << channel), 0),
      );
      await configureCompression(transport, caps, configuration);
      await transport.start(payload);
      let beating = false;
      heartbeat = setInterval(() => {
        if (beating || signal?.aborted) return;
        beating = true;
        void transport
          .command(Command.keepalive)
          .catch((error) => transport.abort(error))
          .finally(() => {
            beating = false;
          });
      }, 1000);
      while (true) {
        signal?.throwIfAborted();
        const frame = await transport.next();
        if (!frame) {
          signal?.throwIfAborted();
          throw stopError ?? new Error('H417 stream ended without END');
        }
        if (frame.type === END) {
          const status = readStatus(frame.payload);
          if (
            status.sampleRate !== configuration.sampleRate ||
            status.channels !== configuration.logicChannels ||
            samples !== status.samples
          )
            throw new Error('H417 final configuration/count mismatch');
          if (status.error) throw statusError(status.error, samples);
          if (samples !== sampleIndex(configuration.sampleCount))
            throw new Error('H417 capture ended before the requested sample count');
          break;
        }
        if (
          frame.type !== DATA ||
          frame.firstSample !== samples ||
          samples + BigInt(frame.payload.length) > sampleIndex(configuration.sampleCount)
        )
          throw new Error('H417 sample stream exceeds requested count');
        if (frame.payload.length) {
          firstByte ??= frame.payload[0]!;
          lastByte = frame.payload[frame.payload.length - 1]!;
        }
        await options.onBlock?.(samples, frame.payload, transport.metrics);
        samples += BigInt(frame.payload.length);
        frames++;
      }
      return {
        samples,
        frames,
        firstByte,
        lastByte,
        session: transport.session,
        transport: { ...transport.metrics },
      };
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', stop);
      try {
        await transport.stop();
      } finally {
        await transport.close();
      }
    }
  }
  private async *capture(
    config: DeviceConfiguration,
    context?: SampleSourceContext,
  ): AsyncGenerator<import('../../libhakei/index.js').SampleChunkInput> {
    const identity = this.identity!,
      api = browserUsb();
    const matches = (await api.getDevices()).filter(
      (d) =>
        d.vendorId === identity.vendorId &&
        d.productId === identity.productId &&
        d.serialNumber === identity.serialNumber,
    );
    if (matches.length !== 1) throw new Error('Authorized H417 device disconnected or ambiguous');
    const transport = new H417Transport(matches[0]!);
    transport.onTransferProgress = context?.reportTransferProgress;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopError: unknown;
    const stop = () => {
      if (!transport.active) return;
      void transport
        .stop()
        .catch((error) => {
          stopError = error;
        })
        .finally(() => transport.close().catch(() => {}));
    };
    context?.signal?.addEventListener('abort', stop, { once: true });
    try {
      context?.signal?.throwIfAborted();
      await transport.open();
      context?.signal?.throwIfAborted();
      const caps = readCapabilities(await transport.command(Command.caps));
      context?.signal?.throwIfAborted();
      if (
        caps.packetBytes !== identity.capabilities.packetBytes ||
        caps.packetBytes !== transport.packet ||
        !caps.rates.includes(config.sampleRate)
      )
        throw new Error('H417 USB speed changed; reconnect to refresh sampling rates');
      const payload = new Uint8Array(24),
        v = new DataView(payload.buffer);
      v.setUint32(0, config.sampleRate, true);
      v.setBigUint64(4, sampleIndex(config.sampleCount), true);
      v.setUint8(12, config.logicChannels);
      v.setUint8(
        13,
        deviceChannelIndices(config, 'logic').reduce((mask, channel) => mask | (1 << channel), 0),
      );
      await configureCompression(transport, caps, config);
      await transport.start(payload);
      context?.signal?.throwIfAborted();
      let beating = false;
      heartbeat = setInterval(() => {
        if (beating || context?.signal?.aborted) return;
        beating = true;
        void transport
          .command(Command.keepalive)
          .catch((error) => transport.abort(error))
          .finally(() => {
            beating = false;
          });
      }, 1000);
      const chunkSamples = context?.chunkSamples ?? 16384;
      let samples = 0n;
      while (true) {
        context?.signal?.throwIfAborted();
        const frame = await transport.next();
        if (!frame) {
          context?.signal?.throwIfAborted();
          throw stopError ?? new Error('H417 stream ended without END');
        }
        if (frame.type === END) {
          const status = readStatus(frame.payload);
          if (
            status.sampleRate !== config.sampleRate ||
            status.channels !== config.logicChannels ||
            samples !== status.samples
          )
            throw new Error('H417 final configuration/count mismatch');
          if (status.error) throw statusError(status.error);
          if (samples !== sampleIndex(config.sampleCount))
            throw new Error('H417 capture ended before the requested sample count');
          break;
        }
        if (
          frame.type !== DATA ||
          frame.firstSample !== samples ||
          samples + BigInt(frame.payload.length) > sampleIndex(config.sampleCount)
        )
          throw new Error('H417 sample stream exceeds requested capture');
        for (let offset = 0; offset < frame.payload.length; offset += chunkSamples) {
          const count = Math.min(chunkSamples, frame.payload.length - offset);
          const buffer = (await context?.acquireBuffer?.()) ?? new ArrayBuffer(count * config.logicChannels);
          const channels: Record<string, Uint8Array> = {};
          for (const [index, channel] of deviceChannelIndices(config, 'logic').entries()) {
            const values = new Uint8Array(buffer, count * index, count);
            for (let i = 0; i < count; i++) values[i] = (frame.payload[offset + i]! >>> channel) & 1;
            channels[`D${channel}`] = values;
          }
          yield {
            startSample: samples,
            sampleRate: config.sampleRate,
            channels,
            isFinal: samples + BigInt(count) === sampleIndex(config.sampleCount),
            metadata: { device: 'ch32h417', session: transport.session },
          };
          samples += BigInt(count);
        }
      }
    } finally {
      clearInterval(heartbeat);
      context?.signal?.removeEventListener('abort', stop);
      try {
        await transport.stop();
      } finally {
        await transport.close();
      }
    }
  }
}

export { CH32H417Device as H417WorkerDevice };
