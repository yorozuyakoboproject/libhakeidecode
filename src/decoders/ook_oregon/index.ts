import { Decoder, OUTPUT_ANN, OUTPUT_BINARY } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

type Bit = [bigint, bigint, string];
type Nibble = [bigint, bigint, string | number, string];

const SENSORS: Readonly<Record<string, readonly [readonly string[], string]>> = {
  '1984': [['WGR800'], 'Wind'],
  '1994': [['WGR800'], 'Wind'],
  '1A2D': [['THGR228N'], 'Temp_Hum1'],
  '1A3D': [['THGR918'], ''],
  '1D20': [['THGN123N', 'THGR122NX', 'THGN123N', 'THGR228N'], 'Temp_Hum'],
  '1D30': [['THGN500', 'THGN132N'], ''],
  '2914': [['PCR800'], 'Rain'],
  '2A19': [['PCR800'], 'Rain1'],
  '2A1D': [['RGR918'], 'Rain'],
  '2D10': [['RGR968', 'PGR968 '], 'Rain1'],
  '3A0D': [['STR918', 'WGR918'], 'Wind'],
  '5A5D': [['BTHR918'], ''],
  '5A6D': [['BTHR918N'], 'Temp_Hum_Baro'],
  '5D53': [['BTHGN129'], 'Baro'],
  '5D60': [['BTHR968'], 'Temp_Hum_Baro'],
  C844: [['THWR800'], 'Temp'],
  CC13: [['RTGR328N'], 'Temp_Hum'],
  CC23: [['THGR328N'], 'Temp_Hum'],
  CD39: [['RTHR328N'], 'Temp'],
  D874: [['UVN800'], 'UV1'],
  EA4C: [['THWR288A'], 'Temp'],
  EC40: [['THN132N', 'THR238NF'], 'Temp'],
  EC70: [['UVR128'], 'UV'],
  F824: [['THGN800', 'THGN801', 'THGR810'], 'Temp_Hum'],
  F8B4: [['THGR810'], 'Temp_Hum'],
};

const CHECKSUMS: Readonly<Record<string, string>> = {
  '1D20': 'v3',
  '5D60': 'v3',
  EC40: 'v3',
};

const DIRECTIONS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
  'N',
] as const;

function hex(value: number): string {
  return value.toString(16);
}

function formatGeneral(value: number): string {
  if (!Number.isFinite(value)) return '';
  const rounded = Number(value.toPrecision(6));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export class OokOregonDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private decoded: Bit[] = [];
  private ookstring = '';
  private decodePos = 0;
  private decodedNibbles: Nibble[] = [];
  private ver = '';
  private sensorId = '';
  private ss = 0n;
  private es = 0n;
  private outAnn = -1;
  private outBinary = -1;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.decoded = [];
    this.ookstring = '';
    this.decodePos = 0;
    this.decodedNibbles = [];
    this.ver = '';
    this.sensorId = '';
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  private putx(data: readonly [number, readonly string[]]): void {
    this.put(this.ss, this.es, this.outAnn, data);
  }

  private dumpOregonHex(start: bigint, finish: bigint): void {
    const text =
      'Oregon ' +
      this.ver +
      ' "' +
      this.decodedNibbles
        .map((nibble) => nibble[3] || ' ')
        .join('')
        .toUpperCase() +
      '"\n';
    this.put(start, finish, this.outBinary, [0, Uint8Array.from(text, (character) => character.charCodeAt(0))]);
  }

  private putPreAndSync(lengthPreamble: number, lengthSync: number, version: string): void {
    this.decodePos = lengthPreamble;
    this.ss = this.decoded[0]![0];
    this.es = this.decoded[this.decodePos]![0];
    this.putx([1, ['Oregon ' + version + ' Preamble', version + ' Preamble', version + ' Pre', version]]);
    this.decodePos += lengthSync;
    this.ss = this.decoded[lengthPreamble]![0];
    this.es = this.decoded[this.decodePos]![0];
    this.putx([1, ['Sync', 'Syn', 'S']]);
    this.decoded = this.decoded.slice(this.decodePos);
    this.ookstring = this.ookstring.slice(this.decodePos);
    this.ver = version;
  }

  private oregon(): void {
    this.ookstring = this.decoded.map((bit) => bit[2]).join('');
    this.decodePos = 0;
    let preamble: string | undefined;
    let data: string | undefined;
    if (this.ookstring.slice(0, 40).includes('10011001')) {
      [preamble, data] = this.ookstring.split('10011001', 2);
      if (data !== undefined && data.length > 0 && preamble!.length > 16) {
        this.putPreAndSync(preamble!.length, 8, 'v2.1');
        this.oregonV2();
      }
    } else if (this.ookstring.slice(0, 17).includes('E1100')) {
      [preamble, data] = this.ookstring.split('E1100', 2);
      if (data !== undefined && data.length > 0 && preamble!.length <= 12) {
        this.putPreAndSync(preamble!.length, 5, 'v1');
        this.oregonV1();
      }
    } else if (this.ookstring.slice(0, 28).includes('0101')) {
      [preamble, data] = this.ookstring.split('0101', 2);
      if (data !== undefined && data.length > 0 && preamble!.length > 12) {
        this.putPreAndSync(preamble!.length, 4, 'v3');
        this.oregonV3();
      }
    } else if (this.ookstring.length > 16) {
      this.ss = this.decoded[0]![0];
      this.es = this.decoded.at(-1)![1];
      this.putx([1, ['Not Oregon or wrong preamble']]);
    }
  }

  private oregonV1(): void {
    this.decodePos = 0;
    this.decodedNibbles = [];
    if (this.decoded.length >= 32) {
      this.putNibble('RollingCode', this.decoded[0]![0], this.decoded[3]![1], 4);
      this.putNibble('Ch', this.decoded[0]![0], this.decoded[3]![1], 4);
      this.putNibble('Temp', this.decoded[0]![0], this.decoded[15]![1], 16);
      this.putNibble('Checksum', this.decoded[0]![0], this.decoded[7]![1], 8);
      this.dumpOregonHex(this.decoded[0]![0], this.decoded.at(-1)![1]);
      this.oregonTemp(2);
      this.oregonChannel(1);
      this.oregonBattery(2);
      this.oregonChecksumV1();
    }
  }

  private oregonV2(): void {
    this.decodePos = 0;
    this.ookstring = this.ookstring
      .split('')
      .filter((_, index) => index % 2 === 1)
      .join('');
    for (let index = 0; index < this.decoded.length; index++)
      if (index % 2 === 1) this.decoded[index]![0] = this.decoded[index - 1]![0];
    this.decoded = this.decoded.filter((_, index) => index % 2 === 1);
    this.oregonV3();
  }

  private nibbles(value: string): string[] {
    const result: string[] = [];
    for (let index = 0; index + 4 <= value.length; index += 4)
      result.push(
        value
          .slice(index, index + 4)
          .split('')
          .reverse()
          .join(''),
      );
    return result;
  }

  private putNibble(label: string, start: bigint, finish: bigint, bits: number): void {
    const parameter = this.ookstring.slice(this.decodePos, this.decodePos + bits);
    const values = this.nibbles(parameter);
    let result = values.join('').includes('E') ? '' : Number.parseInt(values.join(''), 2).toString(16);
    if (result.length < bits / 4) result = '0'.repeat(Math.trunc(bits / 4) - result.length) + result;
    const caption = label ? label + ': ' : '';
    this.put(start, finish, this.outAnn, [1, [caption + result, result]]);
    const position = label ? label : Math.trunc(this.decodePos / 4);
    for (let index = 0; index < values.length; index++) {
      const ss = this.decoded[this.decodePos + 4 * index]![0];
      const es = this.decoded[this.decodePos + 4 * index + 3]![1];
      const nibble = values[index]!;
      this.decodedNibbles.push([ss, es, position, nibble.includes('E') ? '' : Number.parseInt(nibble, 2).toString(16)]);
    }
    this.decodePos += bits;
  }

  private oregonV3(): void {
    this.decodePos = 0;
    this.decodedNibbles = [];
    if (this.decoded.length < 32) {
      this.put(this.decoded[0]![0], this.decoded.at(-1)![1], this.outAnn, [1, ['Too short to decode']]);
      return;
    }
    this.putNibble('SensorID', this.decoded[0]![0], this.decoded[16]![0], 16);
    this.putNibble('Ch', this.decoded[0]![0], this.decoded[3]![1], 4);
    this.putNibble('RollingCode', this.decoded[0]![0], this.decoded[7]![1], 8);
    this.putNibble('Flags1', this.decoded[0]![0], this.decoded[3]![1], 4);
    const remaining = Math.trunc(this.ookstring.slice(this.decodePos).length / 4);
    for (let index = 0; index < remaining; index++)
      this.putNibble('', this.decoded[this.decodePos]![0], this.decoded[this.decodePos + 3]![1], 4);
    this.dumpOregonHex(this.decoded[0]![0], this.decoded.at(-1)![1]);
    this.oregonLevel2();
  }

  private putLevel2(offset: number, digits: number, decimalPoint: number, prefix: string, label: string): void {
    const nibbles = this.decodedNibbles;
    let output = '';
    const values = nibbles.slice(offset, offset + digits);
    if (values.length === digits && values.every((nibble) => nibble[3] !== '')) {
      let value = 0;
      for (let index = decimalPoint; index > 0; index--)
        value += Number.parseInt(String(nibbles[offset + decimalPoint - index]![3]), 16) / 10 ** index;
      for (let index = decimalPoint; index < digits; index++)
        value += Number.parseInt(String(nibbles[offset + index]![3]), 16) * 10 ** (index - decimalPoint);
      output = formatGeneral(value);
    }
    let es = nibbles[offset + digits - 1]![1];
    if (label === '\u2103') es = nibbles[offset + digits]![1];
    this.put(nibbles[offset]![0], es, this.outAnn, [2, [prefix + output + label, output]]);
  }

  private oregonTemp(offset: number): void {
    const nibble = this.decodedNibbles[offset + 3];
    const sign = !nibble || nibble[3] === '' ? '?' : String(Number.parseInt(String(nibble[3]), 16)) === '0' ? '+' : '-';
    this.putLevel2(offset, 3, 1, sign, '\u2103');
  }

  private oregonBaro(offset: number): void {
    const values = this.decodedNibbles.slice(offset, offset + 4);
    const value =
      values.length === 4 && values.every((nibble) => nibble[3] !== '')
        ? Number.parseInt(String(values[1]![3]) + String(values[0]![3]), 16) + 856
        : '';
    this.put(values[0]![0], values[3]![1], this.outAnn, [2, [String(value) + ' mb', String(value)]]);
  }

  private oregonWindDirection(offset: number): void {
    const nibble = this.decodedNibbles[offset];
    if (!nibble || nibble[3] === '') return;
    const degrees = Math.trunc(Number.parseInt(String(nibble[3]), 16) * 22.5);
    const compass = DIRECTIONS[Math.floor((degrees + 11.25) / 22.5)]!;
    this.put(nibble[0], nibble[1], this.outAnn, [2, [compass + ' (' + degrees + '\u00b0)', compass]]);
  }

  private oregonChannel(offset: number): void {
    const nibble = this.decodedNibbles[offset];
    if (!nibble || nibble[3] === '') return;
    let channel = '';
    let value = Number.parseInt(String(nibble[3]), 16);
    if (this.ver !== 'v3') {
      if (value !== 0) {
        let bitPosition = 0;
        while ((value & 1) === 0) {
          bitPosition++;
          value >>= 1;
        }
        if (this.ver === 'v2.1') bitPosition++;
        channel = String(bitPosition);
      }
    } else channel = String(value);
    if (channel) this.put(nibble[0], nibble[1], this.outAnn, [2, ['Ch ' + channel, channel]]);
  }

  private oregonBattery(offset: number): void {
    const nibble = this.decodedNibbles[offset];
    if (!nibble || nibble[3] === '') return;
    const status = ((Number.parseInt(String(nibble[3]), 16) >> 2) & 1) === 1 ? 'Low' : 'OK';
    this.put(nibble[0], nibble[1], this.outAnn, [2, ['Batt ' + status, status]]);
  }

  private oregonLevel2(): void {
    const nibbles = this.decodedNibbles;
    this.sensorId = (nibbles[0]![3].toString() + nibbles[1]![3] + nibbles[2]![3] + nibbles[3]![3]).toUpperCase();
    const entry = SENSORS[this.sensorId] ?? [['Unknown'], 'Unknown'];
    const names = entry[0].join(',');
    let type = entry[1];
    if (type === 'Unknown' && this.options.unknown !== 'Unknown') type = String(this.options.unknown);
    this.put(nibbles[0]![0], nibbles[3]![1], this.outAnn, [2, [names + ' - ' + type, names, entry[0][0]!]]);
    this.oregonChannel(4);
    this.oregonBattery(7);
    if (type === 'Rain') {
      this.putLevel2(8, 4, 2, '', ' in/hr');
      this.putLevel2(12, 6, 3, 'Total ', ' in');
      this.oregonChecksum(18);
    }
    if (type === 'Rain1') {
      this.putLevel2(8, 3, 1, '', ' mm/hr');
      this.putLevel2(11, 5, 1, 'Total ', ' mm');
      this.oregonChecksum(18);
    }
    if (type === 'Temp') {
      this.oregonTemp(8);
      this.oregonChecksum(12);
    }
    if (type === 'Temp_Hum_Baro') {
      this.oregonTemp(8);
      this.putLevel2(12, 2, 0, 'Hum ', '%');
      this.oregonBaro(15);
      this.oregonChecksum(19);
    }
    if (type === 'Temp_Hum_Baro1') {
      this.oregonTemp(8);
      this.putLevel2(12, 2, 0, 'Hum ', '%');
      this.oregonBaro(14);
    }
    if (type === 'Temp_Hum') {
      this.oregonTemp(8);
      this.putLevel2(12, 2, 0, 'Hum ', '%');
      this.oregonChecksum(15);
    }
    if (type === 'Temp_Hum1') {
      this.oregonTemp(8);
      this.putLevel2(12, 2, 0, 'Hum ', '%');
      this.oregonChecksum(14);
    }
    if (type === 'UV') this.putLevel2(8, 2, 0, '', '');
    if (type === 'UV1') this.putLevel2(11, 2, 0, '', '');
    if (type === 'Wind') {
      this.oregonWindDirection(8);
      this.putLevel2(11, 3, 1, 'Gust ', ' m/s');
      this.putLevel2(14, 3, 1, 'Speed ', ' m/s');
      this.oregonChecksum(17);
    }
  }

  private putChecksum(index: number, checksum: number): void {
    const nibbles = this.decodedNibbles;
    if (index + 1 >= nibbles.length) return;
    let result = 'BAD';
    if (nibbles[index + 1]![3] !== '' && nibbles[index]![3] !== '' && checksum !== -1) {
      const received =
        this.ver === 'v1'
          ? Number.parseInt(String(nibbles[index]![3]), 16) * 16 + Number.parseInt(String(nibbles[index + 1]![3]), 16)
          : Number.parseInt(String(nibbles[index + 1]![3]), 16) * 16 + Number.parseInt(String(nibbles[index]![3]), 16);
      if (checksum === received) result = 'OK';
    }
    const received = (String(nibbles[index + 1]![3]) + String(nibbles[index]![3])).toUpperCase();
    const calculated = checksum < 0 ? 'x' + hex(-checksum) : hex(checksum);
    const details = `${result} Calc ${calculated.toUpperCase()} Rx ${received} `;
    this.put(nibbles[index]![0], nibbles[index + 1]![1], this.outAnn, [2, ['Checksum ' + details, result]]);
  }

  private oregonChecksum(index: number): void {
    let checksum = 0;
    for (let position = 0; position < index; position++) {
      const nibble = this.nibbles(this.ookstring.slice(position * 4, position * 4 + 4))[0];
      if (!nibble || nibble.includes('E')) {
        checksum = -1;
        break;
      }
      checksum += Number.parseInt(nibble, 2);
      if (checksum > 255) checksum -= 255;
    }
    const override = CHECKSUMS[this.sensorId];
    if (override) this.ver = override;
    if (this.ver === 'v2.1') checksum -= 10;
    this.putChecksum(index, checksum);
  }

  private oregonChecksumV1(): void {
    let checksum = 0;
    for (let index = 0; index < 3; index++) {
      const low = this.decodedNibbles[2 * index]!;
      const high = this.decodedNibbles[2 * index + 1]!;
      if (!low || !high || low[3] === '' || high[3] === '') {
        checksum = -1;
        break;
      }
      checksum += ((Number.parseInt(String(low[3]), 16) & 0xf) << 4) | (Number.parseInt(String(high[3]), 16) & 0xf);
      if (checksum > 255) checksum -= 255;
    }
    this.putChecksum(6, checksum);
  }

  decode(_ss: bigint, _es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    this.decoded = data.map((item) => {
      const bit = item as readonly [bigint, bigint, string];
      return [bit[0], bit[1], String(bit[2])];
    });
    this.oregon();
  }
}

export default OokOregonDecoder;
