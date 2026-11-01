import type { DeviceCapabilities, DeviceDescriptor } from '../../libhakei/device.js';
import { formatRate } from '../../libhakei/units.js';
import type { Capabilities } from './protocol.js';

export const USB_VID = 0x0721,
  USB_PID = 0x2333;
export const SS_RATES = [
  6_250_000, 8_000_000, 10_000_000, 20_000_000, 25_000_000, 40_000_000, 50_000_000, 80_000_000, 100_000_000,
  200_000_000,
] as const;
export const defaultCaps: Capabilities = {
  appProtocol: 19,
  channelRates: [],
  compressionMask: 0,
  hsadcBlockSamples: 4096,
  analogMask: 0,
  adc1Mask: 0,
  hsadcMask: 0,
  adc1Budget: 562500,
  hsadcMax: 20000000,
  packetBytes: 1024,
  blockBytes: 16384,
  heartbeatMs: 5000,
  channels: 8,
  rates: [...SS_RATES],
};
function capabilities(caps: Capabilities): DeviceCapabilities {
  return {
    sampleRate: {
      kind: 'list',
      values: caps.rates,
      default: caps.packetBytes === 1024 ? 40_000_000 : 10_000_000,
    },
    sampleCount: {
      kind: 'range',
      min: 1n,
      max: ((1n << 64n) - 1n) / 400000000n,
      step: 1n,
      default: 200_000n,
    },
    logicChannels: { kind: 'list', values: [0, 1, 2, 3, 4, 5, 6, 7, 8], default: 8 },
    analogChannels: {
      kind: 'range',
      min: 0,
      max: caps.analogMask & 2 ? 2 : caps.analogMask & 1 ? 1 : 0,
      step: 1,
      default: 0,
    },
  };
}

export function descriptor(caps: Capabilities = defaultCaps): DeviceDescriptor {
  return {
    id: 'ch32h417',
    name: 'CH32H417 Logic Analyzer',
    capabilities: capabilities(caps),
    analogInputs: [0, 1]
      .filter((i) => caps.analogMask & (1 << i))
      .map((index) => ({
        index,
        name: `PC${index + 1} · ${caps.hsadcMask & (1 << index) ? 'HSADC' : 'ADC1'}`,
      })),
    options: [
      ...(caps.appProtocol >= 22 && caps.compressionMask
        ? [
            {
              id: 'digitalEncoding',
              name: 'Digital encoding',
              kind: 'choice' as const,
              values: ['raw', 'runs'],
              default: 'raw',
            },
            ...(caps.analogMask
              ? [
                  {
                    id: 'analogEncoding',
                    name: 'Analog encoding',
                    kind: 'choice' as const,
                    values: ['packed', 'split'],
                    default: 'packed',
                  },
                ]
              : []),
          ]
        : []),
      ...(caps.appProtocol >= 21
        ? [
            ...[
              { id: 'adc1Period', name: 'ADC1 hardware sample rate', mask: caps.adc1Mask, preferred: 4000 },
              {
                id: 'hsadcPeriod',
                name: 'HSADC hardware sample rate',
                mask: caps.hsadcMask,
                preferred: caps.packetBytes === 512 ? 320 : 40,
              },
            ]
              .filter((path) => path.mask)
              .map((path) => {
                const periods = [
                  ...new Set(
                    caps.channelRates
                      .filter(
                        (r) => path.mask & (1 << r.pin) && r.decimation === 1 && r.outputTicks === r.conversionTicks,
                      )
                      .map((r) => r.conversionTicks),
                  ),
                ].sort((a, b) => a - b);
                return {
                  id: path.id,
                  name: path.name,
                  kind: 'choice' as const,
                  values: periods.map(String),
                  default: String(periods.includes(path.preferred) ? path.preferred : periods[0]),
                  labels: Object.fromEntries(periods.map((period) => [String(period), formatRate(400000000 / period)])),
                  description:
                    'Hardware sampling only. ADC1 pins share one rate; digital and HSADC rates are independent.',
                };
              }),
            ...[0, 1]
              .filter((pin) => caps.analogMask & (1 << pin))
              .map((pin) => {
                const native = caps.hsadcMask & (1 << pin) ? 10 : 12;
                return {
                  id: `pc${pin + 1}Bits`,
                  name: `PC${pin + 1} output bits`,
                  kind: 'choice' as const,
                  values: Array.from({ length: native - 7 }, (_, i) => String(i + 8)),
                  default: String(native),
                  description:
                    'Reducing output bits loses precision. Encoding preserves the quantized samples exactly.',
                };
              }),
          ]
        : [
            {
              id: 'hsadcHz',
              name: 'HSADC sampling rate (Hz)',
              kind: 'number' as const,
              min: 1250000,
              max: caps.hsadcMax,
              step: 1,
              default: caps.packetBytes === 512 ? 1250000 : 10000000,
            },
            {
              id: 'adc1Hz',
              name: 'ADC1 rate per channel (Hz)',
              kind: 'number' as const,
              min: 1,
              max: caps.adc1Budget,
              step: 1,
              default: 100000,
            },
          ]),
    ],
  };
}
