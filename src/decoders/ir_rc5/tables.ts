export type Rc5Label = readonly [long: string, short: string];

export const SYSTEMS = new Map<number, Rc5Label>([
  [0, ['TV receiver 1', 'TV1']],
  [1, ['TV receiver 2', 'TV2']],
  [2, ['Teletext', 'Txt']],
  [3, ['Extension to TV1 and TV2', 'Ext TV1/TV2']],
  [4, ['LaserVision player', 'LV']],
  [5, ['Video cassette recorder 1', 'VCR1']],
  [6, ['Video cassette recorder 2', 'VCR2']],
  [7, ['Experimental', 'Exp']],
  [8, ['Satellite TV receiver 1', 'Sat1']],
  [9, ['Extension to VCR1 and VCR2', 'Ext VCR1/VCR2']],
  [10, ['Satellite TV receiver 2', 'Sat2']],
  [12, ['Compact disc video player', 'CD-Video']],
  [13, ['Camcorder', 'Cam']],
  [14, ['Photo on compact disc player', 'CD-Photo']],
  [16, ['Audio preamplifier 1', 'Preamp1']],
  [17, ['Radio tuner', 'Tuner']],
  [18, ['Analog cassette recoder 1', 'Rec1']],
  [19, ['Audio preamplifier 2', 'Preamp2']],
  [20, ['Compact disc player', 'CD']],
  [21, ['Audio stack or record player', 'Combi']],
  [22, ['Audio satellite', 'Sat']],
  [23, ['Analog cassette recoder 2', 'Rec2']],
  [26, ['Compact disc recorder', 'CD-R']],
  [29, ['Lighting 1', 'Light1']],
  [30, ['Lighting 2', 'Light2']],
  [31, ['Telephone', 'Phone']],
]);

const DIGITS = new Map<number, Rc5Label>(
  Array.from({ length: 10 }, (_, value) => [value, [String(value), String(value)] as Rc5Label]),
);

export const TV_COMMANDS = new Map<number, Rc5Label>([
  ...DIGITS,
  [10, ['-/--', '-/--']],
  [11, ['Channel/program', 'Ch/P']],
  [12, ['Standby', 'StBy']],
  [13, ['Mute', 'M']],
  [14, ['Personal preferences', 'PP']],
  [15, ['Display', 'Disp']],
  [16, ['Volume up', 'Vol+']],
  [17, ['Volume down', 'Vol-']],
  [18, ['Brightness up', 'Br+']],
  [19, ['Brightness down', 'Br-']],
  [20, ['Saturation up', 'S+']],
  [21, ['Saturation down', 'S-']],
  [32, ['Program up', 'P+']],
  [33, ['Program down', 'P-']],
]);

export const VCR_COMMANDS = new Map<number, Rc5Label>([
  ...DIGITS,
  [10, ['-/--', '-/--']],
  [12, ['Standby', 'StBy']],
  [32, ['Program up', 'P+']],
  [33, ['Program down', 'P-']],
  [50, ['Fast rewind', 'FRW']],
  [52, ['Fast forward', 'FFW']],
  [53, ['Play', 'Pl']],
  [54, ['Stop', 'St']],
  [55, ['Recording', 'Rec']],
]);

export const UNKNOWN_LABEL: Rc5Label = ['Unknown', 'Unk'];
