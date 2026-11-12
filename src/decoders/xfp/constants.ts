export const MODULE_ID: Readonly<Record<number, string>> = {
  0x01: 'GBIC',
  0x02: 'Integrated module/connector',
  0x03: 'SFP',
  0x04: '300-pin XBI',
  0x05: 'XENPAK',
  0x06: 'XFP',
  0x07: 'XFF',
  0x08: 'XFP-E',
  0x09: 'XPAK',
  0x0a: 'X2',
};

export const ALARM_THRESHOLDS: Readonly<Record<number, string>> = {
  0: 'Temp high alarm',
  2: 'Temp low alarm',
  4: 'Temp high warning',
  6: 'Temp low warning',
  16: 'Bias high alarm',
  18: 'Bias low alarm',
  20: 'Bias high warning',
  22: 'Bias low warning',
  24: 'TX power high alarm',
  26: 'TX power low alarm',
  28: 'TX power high warning',
  30: 'TX power low warning',
  32: 'RX power high alarm',
  34: 'RX power low alarm',
  36: 'RX power high warning',
  38: 'RX power low warning',
  40: 'AUX 1 high alarm',
  42: 'AUX 1 low alarm',
  44: 'AUX 1 high warning',
  46: 'AUX 1 low warning',
  48: 'AUX 2 high alarm',
  50: 'AUX 2 low alarm',
  52: 'AUX 2 high warning',
  54: 'AUX 2 low warning',
};

export const AD_READOUTS: Readonly<Record<number, string>> = {
  0: 'Module temperature',
  4: 'TX bias current',
  6: 'Measured TX output power',
  8: 'Measured RX input power',
  10: 'AUX 1 measurement',
  12: 'AUX 2 measurement',
};

export const GCS_BITS = [
  'TX disable',
  'Soft TX disable',
  'MOD_NR',
  'P_Down',
  'Soft P_Down',
  'Interrupt',
  'RX_LOS',
  'Data_Not_Ready',
  'TX_NR',
  'TX_Fault',
  'TX_CDR not locked',
  'RX_NR',
  'RX_CDR not locked',
] as const;

export const CONNECTOR: Readonly<Record<number, string>> = {
  0x01: 'SC',
  0x02: 'Fibre Channel style 1 copper',
  0x03: 'Fibre Channel style 2 copper',
  0x04: 'BNC/TNC',
  0x05: 'Fibre Channel coax',
  0x06: 'FiberJack',
  0x07: 'LC',
  0x08: 'MT-RJ',
  0x09: 'MU',
  0x0a: 'SG',
  0x0b: 'Optical pigtail',
  0x20: 'HSSDC II',
  0x21: 'Copper pigtail',
};

export const TRANSCEIVER: readonly (readonly string[])[] = [
  ['10GBASE-SR', '10GBASE-LR', '10GBASE-ER', '10GBASE-LRM', '10GBASE-SW', '10GBASE-LW', '10GBASE-EW'],
  ['1200-MX-SN-I', '1200-SM-LL-L', 'Extended Reach 1550 nm', 'Intermediate reach 1300 nm FP'],
  [],
  ['1000BASE-SX / 1xFC MMF', '1000BASE-LX / 1xFC SMF', '2xFC MMF', '2xFC SMF', 'OC48-SR', 'OC48-IR', 'OC48-LR'],
  ['I-64.1r', 'I-64.1', 'I-64.2r', 'I-64.2', 'I-64.3', 'I-64.5'],
  ['S-64.1', 'S-64.2a', 'S-64.2b', 'S-64.3a', 'S-64.3b', 'S-64.5a', 'S-64.5b'],
  ['L-64.1', 'L-64.2a', 'L-64.2b', 'L-64.2c', 'L-64.3', 'G.959.1 P1L1-2D2'],
  ['V-64.2a', 'V-64.2b', 'V-64.3'],
];

export const SERIAL_ENCODING = ['64B/66B', '8B/10B', 'SONET scrambled', 'NRZ', 'RZ'] as const;

export const XMIT_TECH = [
  '850 nm VCSEL',
  '1310 nm VCSEL',
  '1550 nm VCSEL',
  '1310 nm FP',
  '1310 nm DFB',
  '1550 nm DFB',
  '1310 nm EML1550 nm EMLcopper',
] as const;

export const CDR = [
  '9.95Gb/s',
  '10.3Gb/s',
  '10.5Gb/s',
  '10.7Gb/s',
  '11.1Gb/s',
  '(unknown)',
  'lineside loopback mode',
  'XFI loopback mode',
] as const;

export const DEVICE_TECH = [
  ['no wavelength control', 'sctive wavelength control'],
  ['uncooled transmitter device', 'cooled transmitter'],
  ['PIN detector', 'APD detector'],
  ['transmitter not tunable', 'transmitter tunable'],
] as const;

export const ENHANCED_OPTS = [
  'VPS',
  'soft TX_DISABLE',
  'soft P_Down',
  'VPS LV regulator mode',
  'VPS bypassed regulator mode',
  'active FEC control',
  'wavelength tunability',
  'CMU',
] as const;

export const AUX_TYPES = [
  'not implemented',
  'APD bias voltage',
  '(unknown)',
  'TEC current',
  'laser temperature',
  'laser wavelength',
  '5V supply voltage',
  '3.3V supply voltage',
  '1.8V supply voltage',
  '-5.2V supply voltage',
  '5V supply current',
  '(unknown)',
  '(unknown)',
  '3.3V supply current',
  '1.8V supply current',
  '-5.2V supply current',
] as const;
