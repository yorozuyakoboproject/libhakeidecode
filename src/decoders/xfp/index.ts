import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import {
  AD_READOUTS,
  ALARM_THRESHOLDS,
  AUX_TYPES,
  CDR,
  CONNECTOR,
  DEVICE_TECH,
  ENHANCED_OPTS,
  GCS_BITS,
  MODULE_ID,
  SERIAL_ENCODING,
  TRANSCEIVER,
  XMIT_TECH,
} from './constants.js';
import { descriptor } from './descriptor.js';

interface StartPacket {
  readonly 0: 'START';
  readonly 1: boolean;
}

interface StopPacket {
  readonly 0: 'STOP';
}

interface AddressPacket {
  readonly 0: 'ADDRESS';
  readonly 1: 'read' | 'write';
  readonly 2: number;
  readonly 3: boolean;
}

interface DataPacket {
  readonly 0: 'DATA';
  readonly 1: 'read' | 'write';
  readonly 2: number;
  readonly 3: boolean;
  readonly 4: number;
}

type I2CPacket = StartPacket | StopPacket | AddressPacket | DataPacket | readonly ['WARNING', string];

function lowerHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function upperHex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function ascii(data: readonly number[]): string {
  return String.fromCharCode(...data);
}

function trimmedAscii(data: readonly number[]): string {
  const whitespace = (value: number): boolean =>
    value === 0x00 ||
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0b ||
    value === 0x0c ||
    value === 0x0d ||
    value === 0x20;
  let start = 0;
  let end = data.length;
  while (start < end && whitespace(data[start]!)) start++;
  while (end > start && whitespace(data[end - 1]!)) end--;
  return ascii(data.slice(start, end));
}

function toTemperature(value: number): string {
  const signed = value & 0x8000 ? value - 0x10000 : value;
  return `${(signed / 256).toFixed(1)} C`;
}

function toCurrent(value: number): string {
  return `${(value / 500000).toFixed(1)} mA`;
}

function toPower(value: number): string {
  return `${(value / 10000).toFixed(2)} mW`;
}

function toWavelength(value: number): string {
  return `${Math.floor(value / 20)} nm`;
}

function toWavelengthTolerance(value: number): string {
  return `${(value / 200).toFixed(1)} nm`;
}

export class XfpDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private cnt = -1;
  private spans: [bigint, bigint][] = [];
  private buf: number[] = [];
  private highPage = 0;
  private ss = 0n;
  private es = 0n;

  override reset(): void {
    this.cnt = -1;
    this.spans = [];
    this.buf = [];
    this.highPage = 0;
    this.ss = 0n;
    this.es = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private annotate(key: string, value: string, startCnt?: number, endCnt?: number): void {
    const start = startCnt ?? this.cnt - this.buf.length + 1;
    const end = endCnt ?? this.cnt;
    const span = this.spans[start];
    const endSpan = this.spans[end];
    const ss = span?.[0] ?? this.ss;
    const es = endSpan?.[1] ?? this.es;
    this.put(ss, es, this.outAnn, [0, [`${key}: ${value}`]]);
    this.put(ss, es, this.outAnn, [1, [value]]);
  }

  private moduleId(data: readonly number[]): void {
    this.annotate('Module identifier', MODULE_ID[data[0]!] ?? 'Unknown');
  }

  private signalCc(data: readonly number[]): void {
    if (data[0] !== 0) this.annotate('Signal Conditioner Control', lowerHex(data[0]!));
  }

  private alarmWarnings(data: readonly number[]): void {
    const startIndex = this.cnt - data.length;
    let index = 0;
    while (index < 56) {
      if (index === 8) index += 8;
      const value = (data[index]! << 8) | data[index + 1]!;
      if (value !== 0) {
        const name = ALARM_THRESHOLDS[index] ?? '...';
        let text: string;
        if (index === 0 || index === 2 || index === 4 || index === 6) text = toTemperature(value);
        else if (index === 16 || index === 18 || index === 20 || index === 22) text = toCurrent(value);
        else if (index >= 24 && index <= 38) text = toPower(value);
        else text = value.toString();
        this.annotate(name, text, startIndex + index, startIndex + index + 1);
      }
      index += 2;
    }
  }

  private vps(data: readonly number[]): void {
    if (data[0] !== 0 || data[1] !== 0) this.annotate('VPS', `${lowerHex(data[0]!)}${lowerHex(data[1]!)}`);
  }

  private ber(data: readonly number[]): void {
    if (data[0] !== 0 || data[1] !== 0) this.annotate('BER', `[${data.join(', ')}]`);
  }

  private wavelengthControl(data: readonly number[]): void {
    if (data.some((value) => value !== 0)) this.annotate('WCR', `[${data.join(', ')}]`);
  }

  private fecControl(data: readonly number[]): void {
    if (data.some((value) => value !== 0)) this.annotate('FEC', `[${data.join(', ')}]`);
  }

  private interruptControl(data: readonly number[]): void {
    this.annotate('Interrupt bits', data.map(lowerHex).join(' '));
  }

  private adReadout(data: readonly number[]): void {
    const startIndex = this.cnt - data.length + 1;
    let index = 0;
    while (index < 14) {
      if (index === 2) index += 2;
      const value = (data[index]! << 8) | data[index + 1]!;
      if (value !== 0) {
        const name = AD_READOUTS[index] ?? '...';
        let text: string;
        if (index === 0) text = toTemperature(value);
        else if (index === 4) text = toCurrent(value);
        else if (index === 6 || index === 8) text = toPower(value);
        else text = value.toString();
        this.annotate(name, text, startIndex + index, startIndex + index + 1);
      }
      index += 2;
    }
  }

  private gcs(data: readonly number[]): void {
    let bits = (data[0]! << 8) | data[1]!;
    const values: string[] = [];
    for (let index = 0; index < 13; index++) {
      if (bits & 0x8000) values.push(GCS_BITS[index]!);
      bits <<= 1;
    }
    this.annotate('General Control/Status', values.join(', '));
  }

  private pageSelect(data: readonly number[]): void {
    this.highPage = data[0]!;
  }

  private extModuleId(data: readonly number[]): void {
    const values = [`Power level ${(data[0]! >> 6) + 1} module`];
    if ((data[0]! & 0x20) === 0) values.push('CDR');
    if ((data[0]! & 0x10) === 0) values.push('TX ref clock input required');
    this.annotate('Extended id', values.join(', '));
  }

  private connector(data: readonly number[]): void {
    const name = CONNECTOR[data[0]!];
    if (name) this.annotate('Connector', name);
  }

  private transceiver(data: readonly number[]): void {
    const values: string[] = [];
    for (let byte = 0; byte < 8; byte++) {
      let value = data[byte]!;
      if (value === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (value & 0x80) values.push(TRANSCEIVER[byte]?.[bit] ?? '(unknown)');
        value <<= 1;
      }
    }
    this.annotate('Transceiver compliance', values.join(', '));
  }

  private serialEncoding(data: readonly number[]): void {
    let value = data[0]!;
    const values: string[] = [];
    for (let bit = 0; bit < 8; bit++) {
      if (value & 0x80) values.push(SERIAL_ENCODING[bit] ?? '(unknown)');
      value <<= 1;
    }
    this.annotate('Serial encoding support', values.join(', '));
  }

  private bitRateMinimum(data: readonly number[]): void {
    this.annotate('Minimum bit rate', `${(data[0]! / 10).toFixed(3)} GB/s`);
  }

  private bitRateMaximum(data: readonly number[]): void {
    this.annotate('Maximum bit rate', `${(data[0]! / 10).toFixed(3)} GB/s`);
  }

  private linkLengthSmf(data: readonly number[]): void {
    const value = data[0]!;
    this.annotate('Link length (SMF)', value === 0 ? '(standard)' : value === 255 ? '> 254 km' : `${value} km`);
  }

  private linkLengthExtended(data: readonly number[]): void {
    const value = data[0]!;
    this.annotate(
      'Link length (extended, 50μm MMF)',
      value === 0 ? '(standard)' : value === 255 ? '> 508 m' : `${value * 2} m`,
    );
  }

  private linkLength50um(data: readonly number[]): void {
    const value = data[0]!;
    this.annotate('Link length (50μm MMF)', value === 0 ? '(standard)' : value === 255 ? '> 254 m' : `${value} m`);
  }

  private linkLength625um(data: readonly number[]): void {
    const value = data[0]!;
    this.annotate('Link length (62.5μm MMF)', value === 0 ? '(standard)' : value === 255 ? '> 254 m' : `${value} m`);
  }

  private linkLengthCopper(data: readonly number[]): void {
    const value = data[0]!;
    this.annotate('Link length (copper)', value === 0 ? '(unknown)' : value === 255 ? '> 254 m' : `${value * 2} m`);
  }

  private deviceTechnology(data: readonly number[]): void {
    const values: string[] = [];
    const transmitter = data[0]! >> 4;
    if (transmitter < XMIT_TECH.length) values.push(`${XMIT_TECH[transmitter]} transmitter`);
    const device = data[0]! & 0x0f;
    for (let bit = 0; bit < 4; bit++) values.push(DEVICE_TECH[bit]![(device >> (3 - bit)) & 1]!);
    this.annotate('Device technology', values.join(', '));
  }

  private vendor(data: readonly number[]): void {
    const name = trimmedAscii(data);
    if (name) this.annotate('Vendor', name);
  }

  private cdr(data: readonly number[]): void {
    let value = data[0]!;
    const values: string[] = [];
    for (let bit = 0; bit < 8; bit++) {
      if (value & 0x80) values.push(CDR[bit]!);
      value <<= 1;
    }
    this.annotate('CDR support', values.join(', '));
  }

  private vendorOui(data: readonly number[]): void {
    if (data.some((value) => value !== 0)) this.annotate('Vendor OUI', data.map(upperHex).join('-'));
  }

  private vendorPartNumber(data: readonly number[]): void {
    const name = trimmedAscii(data);
    if (name) this.annotate('Vendor part number', name);
  }

  private vendorRevision(data: readonly number[]): void {
    const name = trimmedAscii(data);
    if (name) this.annotate('Vendor revision', name);
  }

  private wavelength(data: readonly number[]): void {
    this.annotate('Wavelength', toWavelength((data[0]! << 8) | data[1]!));
  }

  private wavelengthTolerance(data: readonly number[]): void {
    this.annotate('Wavelength tolerance', toWavelengthTolerance((data[0]! << 8) | data[1]!));
  }

  private maximumCaseTemperature(data: readonly number[]): void {
    this.annotate('Maximum case temperature', `${data[0]} C`);
  }

  private powerSupply(data: readonly number[]): void {
    const first = this.cnt - 3;
    this.annotate('Max power dissipation', `${(data[0]! * 0.02).toFixed(3)} W`, first, first);
    this.annotate('Max power dissipation (powered down)', `${(data[1]! * 0.01).toFixed(3)} W`, first + 1, first + 1);
    this.annotate('Max current required (5V supply)', `${((data[2]! >> 4) * 0.05).toFixed(3)} A`, first + 2, first + 2);
    this.annotate(
      'Max current required (3.3V supply)',
      `${((data[2]! & 0x0f) * 0.1).toFixed(3)} A`,
      first + 2,
      first + 2,
    );
    this.annotate(
      'Max current required (1.8V supply)',
      `${((data[3]! >> 4) * 0.1).toFixed(3)} A`,
      first + 3,
      first + 3,
    );
    this.annotate(
      'Max current required (-5.2V supply)',
      `${((data[3]! & 0x0f) * 0.05).toFixed(3)} A`,
      first + 3,
      first + 3,
    );
  }

  private vendorSerialNumber(data: readonly number[]): void {
    const name = trimmedAscii(data);
    if (name) this.annotate('Vendor serial number', name);
  }

  private manufacturingDate(data: readonly number[]): void {
    const year = Number.parseInt(ascii(data.slice(0, 2)), 10) + 2000;
    const month = Number.parseInt(ascii(data.slice(2, 4)), 10);
    const day = Number.parseInt(ascii(data.slice(4, 6)), 10);
    const lot = trimmedAscii(data.slice(6));
    let value = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
      .toString()
      .padStart(2, '0')}`;
    if (lot) value += ` lot ${lot}`;
    this.annotate('Manufacturing date', value);
  }

  private diagnosticMonitoring(data: readonly number[]): void {
    const values = [
      data[0]! & 0x10 ? 'BER support' : 'no BER support',
      data[0]! & 0x08 ? 'average power measurement' : 'OMA power measurement',
    ];
    this.annotate('Diagnostic monitoring', values.join(', '));
  }

  private enhancedOptions(data: readonly number[]): void {
    let value = data[0]!;
    const values: string[] = [];
    for (let bit = 0; bit < 8; bit++) {
      if (value & 0x80) values.push(ENHANCED_OPTS[bit]!);
      value <<= 1;
    }
    this.annotate('Enhanced option support', values.join(', '));
  }

  private auxiliaryMonitoring(data: readonly number[]): void {
    this.annotate('AUX1 monitoring', AUX_TYPES[data[0]! >> 4]!);
    this.annotate('AUX2 monitoring', AUX_TYPES[data[0]! & 0x0f]!);
  }

  private maybeAscii(data: readonly number[]): void {
    const first = this.cnt - data.length + 1;
    for (let index = 0; index < data.length; index++) {
      const value = data[index]!;
      if (value >= 0x20 && value < 0x7f)
        this.annotate('Vendor ID', String.fromCharCode(value), first + index, first + index);
    }
  }

  private handleLowerMemory(): void {
    switch (this.cnt) {
      case 0:
        this.moduleId(this.buf);
        break;
      case 1:
        this.signalCc(this.buf);
        break;
      case 57:
        this.alarmWarnings(this.buf);
        break;
      case 59:
        this.vps(this.buf);
        break;
      case 69:
      case 117:
      case 118:
      case 122:
      case 126:
        break;
      case 71:
        this.ber(this.buf);
        break;
      case 75:
        this.wavelengthControl(this.buf);
        break;
      case 79:
        this.fecControl(this.buf);
        break;
      case 95:
        this.interruptControl(this.buf);
        break;
      case 109:
        this.adReadout(this.buf);
        break;
      case 111:
        this.gcs(this.buf);
        break;
      case 127:
        this.pageSelect(this.buf);
        break;
      default:
        return;
    }
    this.buf = [];
  }

  private handleHighMemory(): void {
    switch (this.cnt) {
      case 128:
        this.moduleId(this.buf);
        break;
      case 129:
        this.extModuleId(this.buf);
        break;
      case 130:
        this.connector(this.buf);
        break;
      case 138:
        this.transceiver(this.buf);
        break;
      case 139:
        this.serialEncoding(this.buf);
        break;
      case 140:
        this.bitRateMinimum(this.buf);
        break;
      case 141:
        this.bitRateMaximum(this.buf);
        break;
      case 142:
        this.linkLengthSmf(this.buf);
        break;
      case 143:
        this.linkLengthExtended(this.buf);
        break;
      case 144:
        this.linkLength50um(this.buf);
        break;
      case 145:
        this.linkLength625um(this.buf);
        break;
      case 146:
        this.linkLengthCopper(this.buf);
        break;
      case 147:
        this.deviceTechnology(this.buf);
        break;
      case 163:
        this.vendor(this.buf);
        break;
      case 164:
        this.cdr(this.buf);
        break;
      case 167:
        this.vendorOui(this.buf);
        break;
      case 183:
        this.vendorPartNumber(this.buf);
        break;
      case 185:
        this.vendorRevision(this.buf);
        break;
      case 187:
        this.wavelength(this.buf);
        break;
      case 189:
        this.wavelengthTolerance(this.buf);
        break;
      case 190:
        this.maximumCaseTemperature(this.buf);
        break;
      case 191:
        break;
      case 195:
        this.powerSupply(this.buf);
        break;
      case 211:
        this.vendorSerialNumber(this.buf);
        break;
      case 219:
        this.manufacturingDate(this.buf);
        break;
      case 220:
        this.diagnosticMonitoring(this.buf);
        break;
      case 221:
        this.enhancedOptions(this.buf);
        break;
      case 222:
        this.auxiliaryMonitoring(this.buf);
        break;
      case 223:
        break;
      case 255:
        this.maybeAscii(this.buf);
        break;
      default:
        return;
    }
    this.buf = [];
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || typeof data[0] !== 'string') return;
    const packet = data as unknown as I2CPacket;
    this.ss = ss;
    this.es = es;
    if (packet[0] === 'START') {
      this.cnt = -1;
      this.spans = [];
      this.buf = [];
      this.highPage = 0;
      return;
    }
    if (packet[0] !== 'DATA' || packet[1] !== 'read') return;

    this.cnt++;
    this.spans.push([ss, es]);
    this.buf.push(packet[2]);
    if (this.cnt < 0x80) this.handleLowerMemory();
    else if (this.cnt < 0x100 && this.highPage === 0x01) this.handleHighMemory();
  }
}

export default XfpDecoder;
