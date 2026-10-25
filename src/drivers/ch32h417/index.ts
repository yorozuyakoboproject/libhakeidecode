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
  type PackedLogicDevice,
  type PackedLogicChunk,
  type ManagedSampleSourceContext,
  type SampleSourceContext,
} from '../../libhakei/device.js';
import { Command, DATA, END, USB_PID, USB_VID, readCapabilities, readStatus, type Capabilities } from './protocol.js';
import { H417Transport, TRANSPORT_WORKING_BYTES, browserUsb, statusError, type UsbApi } from './transport.js';
export type { Capabilities } from './protocol.js';
export interface H417Identity {
  serialNumber: string;
  vendorId: number;
  productId: number;
  capabilities: Capabilities;
}
export interface H417TransportMetrics {
  reads: number;
  receivedBytes: number;
  parserMs: number;
  queuePeak: number;
  dataFrames: number;
}
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
}
export class CH32H417Device implements PackedLogicDevice {
  readonly layout = 'packed-logic';
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
  getCapabilities(_configuration: DeviceConfiguration): DeviceCapabilities {
    return this.descriptor.capabilities;
  }
  createSource(configuration: DeviceConfiguration, context?: SampleSourceContext): SampleSource {
    validateDeviceConfiguration(this, configuration);
    if (!this.identity) throw new ComponentError('driver.ch32h417.error.disconnected');
    return this.capture(configuration, context);
  }
  getAcquisitionDescription(_configuration: DeviceConfiguration): PackedLogicAcquisitionDescription {
    if (!this.identity) throw new ComponentError('driver.ch32h417.error.disconnected');
    return {
      layout: 'packed-logic',
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
    const workerMetrics: H417WorkerMetrics = { packedCopyMs: 0, bufferWaitMs: 0, consumerWaitMs: 0 };
    const encode = (): PackedLogicChunk => {
      context.reportDiagnostics?.({
        'transport.reads': lastTransport?.reads ?? 0,
        'transport.receivedBytes': lastTransport?.receivedBytes ?? 0,
        'transport.parserMs': lastTransport?.parserMs ?? 0,
        'transport.queuePeak': lastTransport?.queuePeak ?? 0,
        'transport.dataFrames': lastTransport?.dataFrames ?? 0,
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
      await transport.open(
        deviceChannelIndices(configuration, 'logic').reduce((mask, channel) => mask | (1 << channel), 0),
      );
      const caps = readCapabilities(await transport.command(Command.caps));
      if (caps.packetBytes !== identity.capabilities.packetBytes || !caps.rates.includes(configuration.sampleRate))
        throw new Error('H417 USB speed changed; reconnect to refresh sampling rates');
      const payload = new Uint8Array(16),
        view = new DataView(payload.buffer);
      view.setUint32(0, configuration.sampleRate, true);
      view.setBigUint64(4, sampleIndex(configuration.sampleCount), true);
      view.setUint8(12, configuration.logicChannels);
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
        if (!frame) throw stopError ?? new Error('H417 stream ended without END');
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
      return { samples, frames, firstByte, lastByte, session: transport.session, transport: { ...transport.metrics } };
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
      await transport.open(deviceChannelIndices(config, 'logic').reduce((mask, channel) => mask | (1 << channel), 0));
      context?.signal?.throwIfAborted();
      const caps = readCapabilities(await transport.command(Command.caps));
      context?.signal?.throwIfAborted();
      if (
        caps.packetBytes !== identity.capabilities.packetBytes ||
        caps.packetBytes !== transport.packet ||
        !caps.rates.includes(config.sampleRate)
      )
        throw new Error('H417 USB speed changed; reconnect to refresh sampling rates');
      const payload = new Uint8Array(16),
        v = new DataView(payload.buffer);
      v.setUint32(0, config.sampleRate, true);
      v.setBigUint64(4, sampleIndex(config.sampleCount), true);
      v.setUint8(12, config.logicChannels);
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
