import { descriptor, MAX_LOGIC_BYTES_PER_SECOND } from './descriptor.js';
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
import { H417Transport, TRANSPORT_WORKING_BYTES, type UsbApi } from './transport.js';
import { selectUsb, type TransportMode, type TransportKind } from './relay.js';
import { captureError } from './overflow.js';
async function configureCompression(
  transport: H417Transport,
  caps: Capabilities,
  config: DeviceConfiguration,
): Promise<void> {
  const analog = String(config.options.analogEncoding ?? 'packed');
  if (!['packed', 'split'].includes(analog)) throw new Error('Invalid H417 compression selection');
  if (analog === 'split' && !caps.compressionMask) throw new Error('Firmware does not support analog LZ4');
  if (config.analogChannels) await transport.setCompression(analog === 'split' ? 1 : 0);
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
    if (!streamMask) return 0;
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
function digitalSettings(
  configuration: DeviceConfiguration,
  caps: Capabilities,
): {
  mask: number;
  channels: readonly number[];
  hardwareWidth: 0 | 8 | 16 | 24 | 32;
  hardwareBytes: 1 | 2 | 3 | 4;
  denseBytes: 1 | 2 | 3 | 4;
} {
  const channels = deviceChannelIndices(configuration, 'logic');
  if (!channels.length) return { mask: 0, channels, hardwareWidth: 0, hardwareBytes: 1, denseBytes: 1 };
  if (
    channels.some(
      (channel, index) =>
        !Number.isInteger(channel) || channel < 0 || channel > 31 || (index > 0 && channel <= channels[index - 1]!),
    )
  )
    throw new Error('Invalid logic channel selection');
  let mask = 0;
  for (const channel of channels) mask = (mask | (1 << channel)) >>> 0;
  if ((mask & ~caps.digitalMask) >>> 0) throw new Error('Capture only logic pins initialized in the management page');
  const available: number[] = [];
  for (let channel = 0; channel < 32; channel++) if (caps.digitalMask & (1 << channel)) available.push(channel);
  if (channels.some((channel, index) => available.indexOf(channel) !== index))
    throw new Error('Logic channels must be a contiguous prefix');
  const hardwareWidth = (Math.ceil((32 - Math.clz32(mask)) / 8) * 8) as 8 | 16 | 24 | 32;
  return {
    mask,
    channels,
    hardwareWidth,
    hardwareBytes: (hardwareWidth / 8) as 1 | 2 | 3 | 4,
    denseBytes: Math.ceil(channels.length / 8) as 1 | 2 | 3 | 4,
  };
}

type LogicPacker = (
  source: Uint8Array,
  sourceOffset: number,
  samples: number,
  destination: Uint8Array,
  destinationOffset: number,
) => void;

function createLogicPacker(settings: ReturnType<typeof digitalSettings>): LogicPacker {
  const { channels, mask, hardwareWidth, hardwareBytes, denseBytes } = settings;
  const fullMask = (hardwareWidth === 32 ? 0xffffffff : (1 << hardwareWidth) - 1) >>> 0;
  if (mask === fullMask)
    return (source, sourceOffset, samples, destination, destinationOffset) => {
      const bytes = samples * hardwareBytes;
      destination.set(source.subarray(sourceOffset, sourceOffset + bytes), destinationOffset);
    };

  const hardwareBits = hardwareBytes * 8;
  const lowBits = Math.min(16, hardwareBits);
  const highBits = hardwareBits - lowBits;
  const table = (start: number, bits: number): Uint32Array => {
    const values = new Uint32Array(1 << bits);
    for (let value = 0; value < values.length; value++) {
      let packed = 0;
      for (let index = 0; index < channels.length; index++) {
        const channel = channels[index]!;
        if (channel >= start && channel < start + bits && value & (1 << (channel - start))) packed |= 1 << index;
      }
      values[value] = packed >>> 0;
    }
    return values;
  };
  const low = table(0, lowBits);
  const high = highBits ? table(lowBits, highBits) : undefined;
  const lowMask = lowBits === 32 ? 0xffffffff : (1 << lowBits) - 1;
  const read = (source: Uint8Array, offset: number): number => {
    if (hardwareBytes === 1) return source[offset]!;
    if (hardwareBytes === 2) return source[offset]! | (source[offset + 1]! << 8);
    if (hardwareBytes === 3) return source[offset]! | (source[offset + 1]! << 8) | (source[offset + 2]! << 16);
    return (
      (source[offset]! | (source[offset + 1]! << 8) | (source[offset + 2]! << 16) | (source[offset + 3]! << 24)) >>> 0
    );
  };
  return (source, sourceOffset, samples, destination, destinationOffset) => {
    for (let sample = 0; sample < samples; sample++) {
      const value = read(source, sourceOffset + sample * hardwareBytes);
      let packed = low[value & lowMask]!;
      if (high) packed = (packed | high[value >>> lowBits]!) >>> 0;
      const output = destinationOffset + sample * denseBytes;
      if (denseBytes === 1) destination[output] = packed;
      else {
        destination[output] = packed;
        destination[output + 1] = packed >>> 8;
        if (denseBytes > 2) destination[output + 2] = packed >>> 16;
        if (denseBytes > 3) destination[output + 3] = packed >>> 24;
      }
    }
  };
}
function readLogicBit(data: Uint8Array, sample: number, sampleBytes: number, channel: number): number {
  const offset = sample * sampleBytes + (channel >>> 3);
  return (data[offset]! >>> (channel & 7)) & 1;
}
export type { Capabilities } from './protocol.js';
export interface H417Identity {
  serialNumber: string;
  vendorId: number;
  productId: number;
  capabilities: Capabilities;
  transportMode?: TransportMode;
  transportKind?: TransportKind;
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
  private transportMode: TransportMode = 'auto';
  private serialNumber?: string;
  private restoring = false;
  private autoRestore = true;
  onConnectionChange: (() => void) | null = null;
  private readonly disconnected = (event: { device: { serialNumber?: string } }): void => {
    if (event.device.serialNumber === this.identity?.serialNumber) {
      this.identity = undefined;
      this.onConnectionChange?.();
    }
  };
  constructor(initialization?: Partial<H417Identity>) {
    this.identity = initialization?.capabilities ? (initialization as H417Identity) : undefined;
    this.serialNumber = initialization?.serialNumber;
    this.transportMode = initialization?.transportMode ?? 'auto';
  }
  get initialization(): Partial<H417Identity> {
    return { ...this.identity, serialNumber: this.serialNumber, transportMode: this.transportMode };
  }
  get connected(): boolean {
    return !!this.identity;
  }
  async connect(initialization?: unknown): Promise<void> {
    if (!(await this.restore(initialization))) throw new ComponentError('driver.ch32h417.error.unavailable');
  }
  async restore(initialization?: unknown): Promise<boolean> {
    this.autoRestore = true;
    if (initialization && typeof initialization === 'object') {
      const saved = initialization as Partial<H417Identity>;
      if (saved.transportMode && ['auto', 'native', 'webusb'].includes(saved.transportMode))
        this.transportMode = saved.transportMode;
      if (saved.serialNumber) this.serialNumber = saved.serialNumber;
    }
    const { api: usb, kind } = await this.usb(this.transportMode);
    const matches = (await usb.getDevices()).filter(
      (device) =>
        device.vendorId === USB_VID && device.productId === USB_PID && device.serialNumber?.startsWith('H417-'),
    );
    if (!matches.length) {
      this.identity = undefined;
      this.onConnectionChange?.();
      return false;
    }
    const serialNumber = this.serialNumber;
    const device =
      matches.find((item) => item.serialNumber === serialNumber) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!device) throw new ComponentError('driver.ch32h417.error.ambiguous');
    if (this.identity && this.identity.serialNumber === device.serialNumber && this.identity.transportKind === kind)
      return true;
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
        transportKind: kind,
        transportMode: this.transportMode,
      };
      this.serialNumber = device.serialNumber;
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
    this.autoRestore = false;
    this.identity = undefined;
    this.api?.removeEventListener?.('disconnect', this.disconnected);
    this.api = null;
    this.onConnectionChange?.();
  }
  private async usb(mode: TransportMode): Promise<{ api: UsbApi; kind: TransportKind }> {
    const webusb = (globalThis.navigator as (Navigator & { usb?: UsbApi }) | undefined)?.usb;
    const selected = await selectUsb(mode, webusb);
    if (!selected.api) throw new ComponentError('driver.ch32h417.error.browser');
    return { api: selected.api as UsbApi, kind: selected.kind };
  }
  private async captureUsb(): Promise<UsbApi> {
    return (await this.usb(this.identity?.transportKind ?? this.transportMode)).api;
  }
  async setTransport(mode: string): Promise<void> {
    if (!['auto', 'native', 'webusb'].includes(mode)) throw new Error('Invalid USB transport');
    this.transportMode = mode as TransportMode;
    this.autoRestore = true;
    try {
      await this.restore();
    } catch (error) {
      this.identity = undefined;
      throw error;
    } finally {
      this.onConnectionChange?.();
    }
  }
  async refreshTransport(): Promise<void> {
    if (this.restoring || !this.autoRestore) return;
    this.restoring = true;
    try {
      await this.restore();
    } catch (error) {
      this.identity = undefined;
      this.onConnectionChange?.();
      throw error;
    } finally {
      this.restoring = false;
    }
  }
  get descriptor(): DeviceDescriptor {
    return {
      ...descriptor(this.identity?.capabilities),
      transport: {
        selected: this.transportMode,
        active: this.identity?.transportKind,
        choices: ['auto', 'native', 'webusb'],
      },
    };
  }
  getCapabilities(configuration: DeviceConfiguration): DeviceCapabilities {
    let caps = this.descriptor.capabilities;
    if (configuration.logicChannels && this.identity) {
      const digital = digitalSettings(configuration, this.identity.capabilities);
      const rates = this.identity.capabilities.rates.filter(
        (rate) => rate * digital.hardwareBytes <= MAX_LOGIC_BYTES_PER_SECOND,
      );
      const preferred = rates.includes(40_000_000) ? 40_000_000 : rates.at(-1)!;
      caps = { ...caps, sampleRate: { kind: 'list', values: rates, default: preferred } };
    }
    const result: DeviceCapabilities = configuration.logicChannels
      ? caps
      : {
          ...caps,
          timebaseOnly: true,
          sampleRate: { kind: 'list', values: [400000000], default: 400000000 },
        };
    if (!configuration.analogChannels) return result;
    const deviceCaps = this.identity?.capabilities;
    const analogTiming = deviceCaps
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
    const matches = (await (await this.captureUsb()).getDevices()).filter(
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
        caps.digitalMask !== identity.capabilities.digitalMask ||
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
      const adc1Hz = adc1 ? 400000000 / conversions[0]! : 0,
        hsadcHz = hsadc ? 400000000 / conversions[1]! : 0;
      const adcCount = Number(!!(adc1 & 1)) + Number(!!(adc1 & 2));
      if (adc1 && Number(configuration.sampleCount) * adc1Hz <= configuration.sampleRate)
        throw new Error('Capture duration must exceed one ADC1 sample period');
      if (adc1Hz * adcCount > caps.adc1Budget) throw new ComponentError('driver.ch32h417.error.adcRate');
      const selected = deviceChannelIndices(configuration, 'logic'),
        digitalFormat = digitalSettings(configuration, caps);
      const packLogic = createLogicPacker(digitalFormat);
      const payload = new Uint8Array(40),
        view = new DataView(payload.buffer);
      view.setUint32(0, configuration.sampleRate, true);
      view.setBigUint64(4, BigInt(configuration.sampleCount), true);
      view.setUint32(12, digitalFormat.mask, true);
      view.setUint8(16, digitalFormat.hardwareWidth);
      view.setUint8(17, adc1);
      view.setUint8(18, hsadc);
      view.setUint32(20, hsadc ? hsadcHz : 0, true);
      view.setUint32(24, adc1 ? adc1Hz : 0, true);
      view.setUint32(28, periods[0]!, true);
      view.setUint32(32, periods[1]!, true);
      view.setUint8(36, bits[0]!);
      view.setUint8(37, bits[1]!);
      await configureCompression(transport, caps, configuration);
      await transport.start(payload, digitalFormat.hardwareBytes);
      let beating = false;
      heartbeat = setInterval(() => {
        if (beating) return;
        beating = true;
        void transport
          .keepalive()
          .catch((error) => transport.abort(error))
          .finally(() => {
            beating = false;
          });
      }, 1000);
      let digital = 0n;
      const referenceMv = new Map<number, number>();
      const expected = new Map<number, bigint>(),
        received = new Map<number, bigint>();
      while (true) {
        context.signal?.throwIfAborted();
        const frame = await transport.next();
        if (!frame) {
          context.signal?.throwIfAborted();
          throw new Error('H417 stream ended without END');
        }
        context.reportDiagnostics?.({
          'transport.receivedBytes': transport.metrics.receivedBytes,
          'transport.readMaxMs': transport.metrics.usbReadMaxMs,
          'transport.readGapMaxMs': transport.metrics.usbReadMaxGapMs,
          'transport.parserDelayMaxMs': transport.metrics.parserStartDelayMaxMs,
          'transport.queueWaitMs': transport.metrics.receiveQueueWaitMs,
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
          'compression.blocks': transport.metrics.codecBlocks,
          'timing.verified': 0,
        });
        if (frame.type === END) {
          const status = readStatus(frame.payload);
          if (
            status.sampleRate !== configuration.sampleRate ||
            status.channels !== digitalFormat.hardwareWidth ||
            status.samples !== digital
          )
            throw new Error('H417 final configuration/count mismatch');
          if (status.error) throw await captureError(transport, status.error, configuration, caps, digital);
          if (configuration.logicChannels && digital !== BigInt(configuration.sampleCount))
            throw new Error('Incomplete digital capture');
          if (analog.some((pin) => !expected.has(pin) || expected.get(pin) !== received.get(pin)))
            throw new Error('Incomplete analog capture');
          await context.acquireBuffer();
          yield { format: 'timeline', length: BigInt(configuration.sampleCount) };
          return;
        }
        if (frame.type === DATA) {
          if (frame.payload.length % digitalFormat.hardwareBytes)
            throw new Error('H417 digital block has a partial sample');
          const count = frame.payload.length / digitalFormat.hardwareBytes;
          const buffer = await context.acquireBuffer(),
            data = new Uint8Array(buffer, 0, count * digitalFormat.denseBytes);
          packLogic(frame.payload, 0, count, data, 0);
          yield {
            format: 'packed-logic',
            startSample: digital,
            sampleRate: configuration.sampleRate,
            channelCount: selected.length,
            length: count,
            encoding:
              digitalFormat.denseBytes === 4
                ? 'raw32'
                : digitalFormat.denseBytes === 3
                  ? 'raw24'
                  : digitalFormat.denseBytes === 2
                    ? 'raw16'
                    : 'raw8',
            data,
          };
          digital += BigInt(count);
          continue;
        }
        if (frame.type !== ANALOG || !frame.analog) throw new Error('Unexpected acquisition frame');
        const info = frame.analog;
        if (
          info.adc1Mask !== adc1 ||
          info.hsadcMask !== hsadc ||
          !(mask & (1 << info.pin)) ||
          info.timing.bits !== bits[info.pin] ||
          info.timing.periodTicks !== BigInt(periods[info.pin]!)
        )
          throw new Error('Analog configuration changed');
        const pins = [0, 1].filter((i) => info.mask & (1 << i)),
          count = frame.payload.length / 2 / pins.length;
        const raw = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        for (let rank = 0; rank < pins.length; ++rank) {
          const pin = pins[rank]!;
          const firstTick = info.timing.firstTick - frame.firstSample * info.timing.periodTicks;
          const target = info.targetSamples;
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
            [`PC${pin + 1}.conversionHz`]: info.timing.clockHz / Number(info.timing.conversionTicks),
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
    const logicSampleBytes = configuration.logicChannels
      ? digitalSettings(configuration, this.identity.capabilities).denseBytes
      : 1;
    return {
      layout: configuration.analogChannels ? 'multi-rate' : 'packed-logic',
      logicSampleBytes,
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
    const capacitySamples = context.chunkSamples ?? 1_048_576,
      digital = digitalSettings(configuration, this.identity.capabilities),
      capacityBytes = capacitySamples * digital.denseBytes,
      packLogic = createLogicPacker(digital);
    if (!Number.isSafeInteger(capacitySamples) || capacitySamples < 1)
      throw new Error('Invalid packed acquisition capacity');
    let buffer: ArrayBuffer | null = null,
      raw: Uint8Array | null = null,
      usedSamples = 0,
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
        'transport.readMaxMs': lastTransport?.usbReadMaxMs ?? 0,
        'transport.readGapMaxMs': lastTransport?.usbReadMaxGapMs ?? 0,
        'transport.parserDelayMaxMs': lastTransport?.parserStartDelayMaxMs ?? 0,
        'transport.queueWaitMs': lastTransport?.receiveQueueWaitMs ?? 0,
        'transport.queuePeak': lastTransport?.queuePeak ?? 0,
        'transport.dataFrames': lastTransport?.dataFrames ?? 0,
        'transport.dataCore': lastTransport?.dataCore ?? 0,
        'compression.rawBytes': lastTransport?.codecRawBytes ?? 0,
        'compression.wireBytes': lastTransport?.codecWireBytes ?? 0,
        'compression.cycles': lastTransport?.codecCycles ?? 0,
        'compression.maxCycles': lastTransport?.codecMaxCycles ?? 0,
        'compression.maxHoldMs': lastTransport?.codecMaxHoldMs ?? 0,
        'compression.queuePeak': lastTransport?.codecQueuePeak ?? 0,
        'compression.decodeMs': lastTransport?.codecDecodeMs ?? 0,
        'compression.blocks': lastTransport?.codecBlocks ?? 0,
        'worker.packedCopyMs': workerMetrics.packedCopyMs,
        'worker.bufferWaitMs': workerMetrics.bufferWaitMs,
        'worker.consumerWaitMs': workerMetrics.consumerWaitMs,
      });
      return {
        format: 'packed-logic',
        startSample: start,
        sampleRate: configuration.sampleRate,
        channelCount: configuration.logicChannels,
        length: usedSamples,
        encoding:
          digital.denseBytes === 4
            ? 'raw32'
            : digital.denseBytes === 3
              ? 'raw24'
              : digital.denseBytes === 2
                ? 'raw16'
                : 'raw8',
        data: raw!.subarray(0, usedSamples * digital.denseBytes),
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
          if (payload.length % digital.hardwareBytes) throw new Error('H417 digital block has a partial sample');
          for (let offset = 0; offset < payload.length;) {
            if (!buffer) {
              const waitStarted = performance.now();
              buffer = await context.acquireBuffer();
              workerMetrics.bufferWaitMs += performance.now() - waitStarted;
              if (buffer.byteLength < capacityBytes || capacitySamples > 0x1000000)
                throw new Error('Invalid packed acquisition buffer');
              raw = new Uint8Array(buffer, 0, capacityBytes);
            }
            const copyStarted = performance.now();
            const samples = Math.min(capacitySamples - usedSamples, (payload.length - offset) / digital.hardwareBytes);
            packLogic(payload, offset, samples, raw!, usedSamples * digital.denseBytes);
            workerMetrics.packedCopyMs += performance.now() - copyStarted;
            usedSamples += samples;
            offset += samples * digital.hardwareBytes;
            if (usedSamples === capacitySamples) {
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
              start += BigInt(usedSamples);
              usedSamples = 0;
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
        if (usedSamples) {
          yield encode();
          usedSamples = 0;
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
      api = await this.captureUsb();
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
      if (
        caps.packetBytes !== identity.capabilities.packetBytes ||
        caps.digitalMask !== identity.capabilities.digitalMask ||
        !caps.rates.includes(configuration.sampleRate)
      )
        throw new Error('H417 USB speed changed; reconnect to refresh sampling rates');
      const digital = digitalSettings(configuration, caps);
      const payload = new Uint8Array(40),
        view = new DataView(payload.buffer);
      view.setUint32(0, configuration.sampleRate, true);
      view.setBigUint64(4, sampleIndex(configuration.sampleCount), true);
      view.setUint32(12, digital.mask, true);
      view.setUint8(16, digital.hardwareWidth);
      await configureCompression(transport, caps, configuration);
      await transport.start(payload, digital.hardwareBytes);
      let beating = false;
      heartbeat = setInterval(() => {
        if (beating || signal?.aborted) return;
        beating = true;
        void transport
          .keepalive()
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
            status.channels !== digital.hardwareWidth ||
            samples !== status.samples
          )
            throw new Error('H417 final configuration/count mismatch');
          if (status.error) throw await captureError(transport, status.error, configuration, caps, samples);
          if (samples !== sampleIndex(configuration.sampleCount))
            throw new Error('H417 capture ended before the requested sample count');
          break;
        }
        if (frame.type !== DATA || frame.firstSample !== samples)
          throw new Error('H417 sample stream exceeds requested count');
        if (frame.payload.length % digital.hardwareBytes) throw new Error('H417 digital block has a partial sample');
        const count = frame.payload.length / digital.hardwareBytes;
        if (samples + BigInt(count) > sampleIndex(configuration.sampleCount))
          throw new Error('H417 sample stream exceeds requested count');
        if (frame.payload.length) {
          firstByte ??= frame.payload[0]!;
          lastByte = frame.payload[frame.payload.length - 1]!;
        }
        await options.onBlock?.(samples, frame.payload, transport.metrics);
        samples += BigInt(count);
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
      api = await this.captureUsb();
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
        caps.digitalMask !== identity.capabilities.digitalMask ||
        caps.packetBytes !== transport.packet ||
        !caps.rates.includes(config.sampleRate)
      )
        throw new Error('H417 USB speed changed; reconnect to refresh sampling rates');
      const digital = digitalSettings(config, caps);
      const payload = new Uint8Array(40),
        v = new DataView(payload.buffer);
      v.setUint32(0, config.sampleRate, true);
      v.setBigUint64(4, sampleIndex(config.sampleCount), true);
      v.setUint32(12, digital.mask, true);
      v.setUint8(16, digital.hardwareWidth);
      await configureCompression(transport, caps, config);
      await transport.start(payload, digital.hardwareBytes);
      context?.signal?.throwIfAborted();
      let beating = false;
      heartbeat = setInterval(() => {
        if (beating || context?.signal?.aborted) return;
        beating = true;
        void transport
          .keepalive()
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
            status.channels !== digital.hardwareWidth ||
            samples !== status.samples
          )
            throw new Error('H417 final configuration/count mismatch');
          if (status.error) throw await captureError(transport, status.error, config, caps, samples);
          if (samples !== sampleIndex(config.sampleCount))
            throw new Error('H417 capture ended before the requested sample count');
          break;
        }
        if (frame.type !== DATA || frame.firstSample !== samples)
          throw new Error('H417 sample stream exceeds requested capture');
        if (frame.payload.length % digital.hardwareBytes) throw new Error('H417 digital block has a partial sample');
        const frameSamples = frame.payload.length / digital.hardwareBytes;
        if (samples + BigInt(frameSamples) > sampleIndex(config.sampleCount))
          throw new Error('H417 sample stream exceeds requested capture');
        for (let offset = 0; offset < frameSamples; offset += chunkSamples) {
          const count = Math.min(chunkSamples, frameSamples - offset);
          const buffer = (await context?.acquireBuffer?.()) ?? new ArrayBuffer(count * config.logicChannels);
          const channels: Record<string, Uint8Array> = {};
          for (const [index, channel] of deviceChannelIndices(config, 'logic').entries()) {
            const values = new Uint8Array(buffer, count * index, count);
            for (let i = 0; i < count; i++)
              values[i] = readLogicBit(frame.payload, offset + i, digital.hardwareBytes, channel);
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
