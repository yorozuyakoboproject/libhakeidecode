import { ComponentError } from '../../components.js';
import { deviceChannelIndices, type DeviceConfiguration } from '../../libhakei/device.js';
import { Command, readCodecStatistics, readStatus, type Capabilities } from './protocol.js';
import { H417Transport, statusError } from './transport.js';

async function processingLoad(
  transport: H417Transport,
  stats: ReturnType<typeof readCodecStatistics>,
  configuration: DeviceConfiguration,
  caps: Capabilities,
): Promise<number | undefined> {
  if (!stats.streams.some((s) => s.inputBytes > 0n)) return 0;
  const result = await transport.device.controlTransferIn?.(
    { requestType: 'vendor', recipient: 'device', request: 1, value: 0, index: 0 },
    28,
  );
  const info = result?.data;
  if (result?.status !== 'ok' || !info || info.byteLength < 24 || info.getUint32(0, true) !== 0x37313448) return;
  const clockHz = info.getUint32(20, true);
  if (!clockHz) return;
  const pins = deviceChannelIndices(configuration, 'analog');
  const rates = [
    { mask: caps.adc1Mask, period: Number(configuration.options.adc1Period) },
    { mask: caps.hsadcMask, period: Number(configuration.options.hsadcPeriod) },
  ].map(({ mask, period }) => {
    const channels = pins.filter((p) => mask & (1 << p)).length;
    return channels && period > 0 ? (2 * channels * 400000000) / period : 0;
  });
  rates.push(configuration.logicChannels ? configuration.sampleRate : 0);
  return stats.streams.reduce(
    (load, s, i) => load + (s.inputBytes > 0n ? ((Number(s.cycles) / Number(s.inputBytes)) * rates[i]!) / clockHz : 0),
    0,
  );
}

export async function captureError(
  transport: H417Transport,
  error: number,
  configuration: DeviceConfiguration,
  caps: Capabilities,
  samples?: bigint,
): Promise<Error> {
  const fallback = statusError(error, samples);
  if (error !== 3) return fallback;
  if (transport.metrics.receiveQueuePauses > 0) return new ComponentError('driver.ch32h417.error.hostOverflow');
  if (caps.appProtocol < 22) return fallback;
  try {
    const until = performance.now() + 1000;
    while (readStatus((await transport.command(Command.status)).payload).state) {
      if (performance.now() >= until) return fallback;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const stats = readCodecStatistics(await transport.command(Command.codecStats));
    const failure = stats.failure;
    if (!failure || ![1, 2, 5, 11, 13].includes(failure.kind)) return fallback;
    const load = await processingLoad(transport, stats, configuration, caps).catch(() => undefined);
    const rawDigital = !configuration.analogChannels && configuration.options.digitalEncoding === 'raw';
    const sending = [1, 2, 3, 5, 6].includes(failure.txKind);
    const usbBacklog =
      sending &&
      (failure.outputs === 0x0f || (rawDigital && [11, 13].includes(failure.kind) && [2, 3].includes(failure.txKind)));
    if (load !== undefined && load > 1) {
      return new ComponentError(
        usbBacklog ? 'driver.ch32h417.error.multipleOverflows' : 'driver.ch32h417.error.processingOverflow',
        { load: load.toFixed(2) },
      );
    }
    if (usbBacklog) return new ComponentError('driver.ch32h417.error.usbBackpressure');
  } catch {
    return fallback;
  }
  return fallback;
}
