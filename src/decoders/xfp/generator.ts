import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
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

export interface I2COperation {
  readonly address: number;
  readonly direction: 'read' | 'write';
  readonly data: readonly number[];
  readonly addressAck?: boolean;
  readonly dataAcks?: readonly boolean[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface XfpCase extends RoundtripCase<I2COperation> {}

const SUMMARY: ExpectedFrame = { protoId: 'xfp', kind: 'summary' };
const DATA_BITS = 9 * (1 + 256);

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

function temperature(value: number): string {
  const signed = value & 0x8000 ? value - 0x10000 : value;
  return `${(signed / 256).toFixed(1)} C`;
}

function current(value: number): string {
  return `${(value / 500000).toFixed(1)} mA`;
}

function power(value: number): string {
  return `${(value / 10000).toFixed(2)} mW`;
}

function pair(key: string, value: string): ExpectedFrame[] {
  return [
    { classIndex: 0, texts: [`${key}: ${value}`] },
    { classIndex: 1, texts: [value] },
  ];
}

function readExpectations(data: readonly number[]): ExpectedFrame[] {
  const expected: ExpectedFrame[] = [];
  expected.push(...pair('Module identifier', MODULE_ID[data[0]!] ?? 'Unknown'));

  if (data[1] !== 0) expected.push(...pair('Signal Conditioner Control', lowerHex(data[1]!)));

  let index = 0;
  while (index < 56) {
    if (index === 8) index += 8;
    const value = (data[2 + index]! << 8) | data[3 + index]!;
    if (value !== 0) {
      const name = ALARM_THRESHOLDS[index] ?? '...';
      let text: string;
      if (index === 0 || index === 2 || index === 4 || index === 6) text = temperature(value);
      else if (index === 16 || index === 18 || index === 20 || index === 22) text = current(value);
      else if (index >= 24 && index <= 38) text = power(value);
      else text = value.toString();
      expected.push(...pair(name, text));
    }
    index += 2;
  }

  if (data[58] !== 0 || data[59] !== 0) expected.push(...pair('VPS', `${lowerHex(data[58]!)}${lowerHex(data[59]!)}`));
  if (data[70] !== 0 || data[71] !== 0) expected.push(...pair('BER', `[${data[70]}, ${data[71]}]`));
  if (data.slice(72, 76).some((value) => value !== 0))
    expected.push(...pair('WCR', `[${data.slice(72, 76).join(', ')}]`));
  if (data.slice(76, 80).some((value) => value !== 0))
    expected.push(...pair('FEC', `[${data.slice(76, 80).join(', ')}]`));
  expected.push(...pair('Interrupt bits', data.slice(80, 96).map(lowerHex).join(' ')));

  let adIndex = 0;
  while (adIndex < 14) {
    if (adIndex === 2) adIndex += 2;
    const value = (data[96 + adIndex]! << 8) | data[97 + adIndex]!;
    if (value !== 0) {
      const name = AD_READOUTS[adIndex] ?? '...';
      let text: string;
      if (adIndex === 0) text = temperature(value);
      else if (adIndex === 4) text = current(value);
      else if (adIndex === 6 || adIndex === 8) text = power(value);
      else text = value.toString();
      expected.push(...pair(name, text));
    }
    adIndex += 2;
  }

  let gcsBits = (data[110]! << 8) | data[111]!;
  const gcsValues: string[] = [];
  for (let bit = 0; bit < 13; bit++) {
    if (gcsBits & 0x8000) gcsValues.push(GCS_BITS[bit]!);
    gcsBits <<= 1;
  }
  expected.push(...pair('General Control/Status', gcsValues.join(', ')));
  if (data[127] !== 1) return expected;

  expected.push(...pair('Module identifier', MODULE_ID[data[128]!] ?? 'Unknown'));
  const extValues = [`Power level ${(data[129]! >> 6) + 1} module`];
  if ((data[129]! & 0x20) === 0) extValues.push('CDR');
  if ((data[129]! & 0x10) === 0) extValues.push('TX ref clock input required');
  expected.push(...pair('Extended id', extValues.join(', ')));
  if (CONNECTOR[data[130]!]) expected.push(...pair('Connector', CONNECTOR[data[130]!]!));

  const transceiverValues: string[] = [];
  for (let byte = 0; byte < 8; byte++) {
    let value = data[131 + byte]!;
    if (value === 0) continue;
    for (let bit = 0; bit < 8; bit++) {
      if (value & 0x80) transceiverValues.push(TRANSCEIVER[byte]?.[bit] ?? '(unknown)');
      value <<= 1;
    }
  }
  expected.push(...pair('Transceiver compliance', transceiverValues.join(', ')));

  let serialValue = data[139]!;
  const serialValues: string[] = [];
  for (let bit = 0; bit < 8; bit++) {
    if (serialValue & 0x80) serialValues.push(SERIAL_ENCODING[bit] ?? '(unknown)');
    serialValue <<= 1;
  }
  expected.push(...pair('Serial encoding support', serialValues.join(', ')));
  expected.push(...pair('Minimum bit rate', `${(data[140]! / 10).toFixed(3)} GB/s`));
  expected.push(...pair('Maximum bit rate', `${(data[141]! / 10).toFixed(3)} GB/s`));
  expected.push(
    ...pair('Link length (SMF)', data[142] === 0 ? '(standard)' : data[142] === 255 ? '> 254 km' : `${data[142]} km`),
  );
  expected.push(
    ...pair(
      'Link length (extended, 50μm MMF)',
      data[143] === 0 ? '(standard)' : data[143] === 255 ? '> 508 m' : `${data[143]! * 2} m`,
    ),
  );
  expected.push(
    ...pair(
      'Link length (50μm MMF)',
      data[144] === 0 ? '(standard)' : data[144] === 255 ? '> 254 m' : `${data[144]} m`,
    ),
  );
  expected.push(
    ...pair(
      'Link length (62.5μm MMF)',
      data[145] === 0 ? '(standard)' : data[145] === 255 ? '> 254 m' : `${data[145]} m`,
    ),
  );
  expected.push(
    ...pair(
      'Link length (copper)',
      data[146] === 0 ? '(unknown)' : data[146] === 255 ? '> 254 m' : `${data[146]! * 2} m`,
    ),
  );

  const technologyValues: string[] = [];
  const transmitter = data[147]! >> 4;
  if (transmitter < XMIT_TECH.length) technologyValues.push(`${XMIT_TECH[transmitter]} transmitter`);
  const device = data[147]! & 0x0f;
  for (let bit = 0; bit < 4; bit++) technologyValues.push(DEVICE_TECH[bit]![(device >> (3 - bit)) & 1]!);
  expected.push(...pair('Device technology', technologyValues.join(', ')));

  const vendor = trimmedAscii(data.slice(148, 164));
  if (vendor) expected.push(...pair('Vendor', vendor));

  let cdrValue = data[164]!;
  const cdrValues: string[] = [];
  for (let bit = 0; bit < 8; bit++) {
    if (cdrValue & 0x80) cdrValues.push(CDR[bit]!);
    cdrValue <<= 1;
  }
  expected.push(...pair('CDR support', cdrValues.join(', ')));
  if (data.slice(165, 168).some((value) => value !== 0))
    expected.push(...pair('Vendor OUI', data.slice(165, 168).map(upperHex).join('-')));

  const partNumber = trimmedAscii(data.slice(168, 184));
  if (partNumber) expected.push(...pair('Vendor part number', partNumber));
  const revision = trimmedAscii(data.slice(184, 186));
  if (revision) expected.push(...pair('Vendor revision', revision));
  expected.push(...pair('Wavelength', `${Math.floor(((data[186]! << 8) | data[187]!) / 20)} nm`));
  expected.push(...pair('Wavelength tolerance', `${(((data[188]! << 8) | data[189]!) / 200).toFixed(1)} nm`));
  expected.push(...pair('Maximum case temperature', `${data[190]} C`));

  expected.push(...pair('Max power dissipation', `${(data[192]! * 0.02).toFixed(3)} W`));
  expected.push(...pair('Max power dissipation (powered down)', `${(data[193]! * 0.01).toFixed(3)} W`));
  expected.push(...pair('Max current required (5V supply)', `${((data[194]! >> 4) * 0.05).toFixed(3)} A`));
  expected.push(...pair('Max current required (3.3V supply)', `${((data[194]! & 0x0f) * 0.1).toFixed(3)} A`));
  expected.push(...pair('Max current required (1.8V supply)', `${((data[195]! >> 4) * 0.1).toFixed(3)} A`));
  expected.push(...pair('Max current required (-5.2V supply)', `${((data[195]! & 0x0f) * 0.05).toFixed(3)} A`));

  const serialNumber = trimmedAscii(data.slice(196, 212));
  if (serialNumber) expected.push(...pair('Vendor serial number', serialNumber));

  const year = Number.parseInt(ascii(data.slice(212, 214)), 10) + 2000;
  const month = Number.parseInt(ascii(data.slice(214, 216)), 10);
  const day = Number.parseInt(ascii(data.slice(216, 218)), 10);
  const lot = trimmedAscii(data.slice(218, 220));
  let manufacturing = `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  if (lot) manufacturing += ` lot ${lot}`;
  expected.push(...pair('Manufacturing date', manufacturing));

  expected.push(
    ...pair(
      'Diagnostic monitoring',
      [
        data[220]! & 0x10 ? 'BER support' : 'no BER support',
        data[220]! & 0x08 ? 'average power measurement' : 'OMA power measurement',
      ].join(', '),
    ),
  );
  let enhancedValue = data[221]!;
  const enhancedValues: string[] = [];
  for (let bit = 0; bit < 8; bit++) {
    if (enhancedValue & 0x80) enhancedValues.push(ENHANCED_OPTS[bit]!);
    enhancedValue <<= 1;
  }
  expected.push(...pair('Enhanced option support', enhancedValues.join(', ')));
  expected.push(...pair('AUX1 monitoring', AUX_TYPES[data[222]! >> 4]!));
  expected.push(...pair('AUX2 monitoring', AUX_TYPES[data[222]! & 0x0f]!));

  for (let offset = 0; offset < 32; offset++) {
    const value = data[224 + offset]!;
    if (value >= 0x20 && value < 0x7f) expected.push(...pair('Vendor ID', String.fromCharCode(value)));
  }
  return expected;
}

function setAscii(data: number[], start: number, length: number, text: string): void {
  for (let index = 0; index < length; index++) data[start + index] = text.charCodeAt(index) || 0x20;
}

function boundaryData(): number[] {
  const data = Array<number>(256).fill(0);
  data[0] = 0x06;
  data[1] = 0x12;
  data[2] = 0x1a;
  data[3] = 0x80;
  data[18] = 0x0f;
  data[19] = 0xa0;
  data[26] = 0x27;
  data[27] = 0x10;
  data[42] = 0x12;
  data[43] = 0x34;
  data[56] = 0x00;
  data[57] = 0x01;
  data[58] = 0x12;
  data[59] = 0x34;
  data[70] = 0x00;
  data[71] = 0x02;
  for (let index = 0; index < 4; index++) data[72 + index] = index + 1;
  for (let index = 0; index < 4; index++) data[76 + index] = index + 5;
  for (let index = 0; index < 16; index++) data[80 + index] = index + 1;
  data[96] = 0x0e;
  data[100] = 0xff;
  data[101] = 0xff;
  data[102] = 0x27;
  data[103] = 0x10;
  data[104] = 0x13;
  data[105] = 0x88;
  data[106] = 0x12;
  data[107] = 0x34;
  data[108] = 0x00;
  data[109] = 0x07;
  data[110] = 0xa8;
  data[127] = 0x01;
  data[128] = 0x06;
  data[129] = 0x25;
  data[130] = 0x07;
  data[131] = 0x80;
  data[132] = 0x40;
  data[139] = 0xc0;
  data[140] = 100;
  data[141] = 101;
  data[142] = 10;
  data[143] = 255;
  data[144] = 100;
  data[145] = 10;
  data[146] = 255;
  data[147] = 0xa5;
  setAscii(data, 148, 16, 'ACME PHOTONICS');
  data[164] = 0xc0;
  data[165] = 0x00;
  data[166] = 0x1a;
  data[167] = 0x2b;
  setAscii(data, 168, 16, 'XFP-TEST-10G');
  setAscii(data, 184, 2, 'A1');
  data[186] = 0x3a;
  data[187] = 0x98;
  data[189] = 100;
  data[190] = 85;
  data[192] = 10;
  data[193] = 5;
  data[194] = 0x21;
  data[195] = 0x12;
  setAscii(data, 196, 16, 'SN12345678');
  setAscii(data, 212, 8, '251111L1');
  data[220] = 0x18;
  data[221] = 0x81;
  data[222] = 0x14;
  setAscii(data, 224, 32, 'XFP-VENDOR-ID-0123456789ABCDEFG');
  return data;
}

function longData(random: () => number): number[] {
  const data = Array.from({ length: 256 }, () => random() & 0xff);
  data[0] = 0x06;
  data[1] = random() & 0xff || 0x12;
  data[58] = random() & 0xff || 0x12;
  data[59] = random() & 0xff || 0x34;
  data[127] = 0x01;
  data[128] = 0x06;
  data[129] = random() & 0xff || 0x25;
  data[130] = 0x07;
  data[131] = 0x80;
  data[147] = 0xa5;
  data[148] = 0x41;
  setAscii(data, 168, 16, `XFP-${(random() >>> 0).toString(16).toUpperCase().padStart(8, '0')}`);
  data[164] = 0xc0;
  data[165] = 0x00;
  data[166] = random() & 0xff;
  data[167] = random() & 0xff || 0x2b;
  data[186] = 0x3a;
  data[187] = 0x98;
  data[188] = 0;
  data[189] = 100;
  data[190] = 85;
  data[192] = 10;
  data[193] = 5;
  data[194] = 0x21;
  data[195] = 0x12;
  setAscii(data, 196, 16, `SN${(random() >>> 0).toString(16).padStart(8, '0')}`);
  setAscii(data, 212, 8, '251111L1');
  data[220] = 0x18;
  data[221] = 0x81;
  data[222] = 0x14;
  setAscii(data, 224, 32, 'XFP-VENDOR-ID-0123456789ABCDEFG');
  return data;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x584650,
}: GenerationOptions = {}): Iterable<XfpCase> {
  const common = {
    seed,
    sampleRate: 800_000,
    channels: { scl: 7, sda: 3 },
    chain: [{ decoder: 'i2c', options: { address_format: 'shifted' } }],
  } as const;

  yield {
    ...common,
    name: 'boundary-management-structures',
    kind: 'boundary',
    startSample: 37n,
    options: {},
    chunkSamples: [67, 997, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const bytes = boundaryData();
      const expectedAnnotations = readExpectations(bytes);
      const data: I2COperation[] = [{ address: 0x50, direction: 'read', data: bytes }];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: DATA_BITS,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const transactionsPerBlock = 20;
  const transactions = Math.ceil(required / DATA_BITS);
  const blocks = Math.ceil(transactions / transactionsPerBlock);

  yield {
    ...common,
    name: 'seeded-long-management-reads',
    kind: 'long',
    startSample: 0n,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let remaining = transactions;
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(transactionsPerBlock, remaining);
        remaining -= count;
        const data: I2COperation[] = [];
        const expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const bytes = longData(random);
          data.push({ address: 0x50, direction: 'read', data: bytes });
          expectedAnnotations.push(...readExpectations(bytes));
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits: count * DATA_BITS,
        };
      }
    },
  };
}
