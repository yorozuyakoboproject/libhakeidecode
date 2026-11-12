export type RemoteNames = readonly [long: string, short: string];
export interface RemoteDefinition {
  readonly names: RemoteNames;
  readonly commands: ReadonlyMap<number, string>;
}

const NUMBERS = new Map<number, string>([
  [0x00, '1'],
  [0x01, '2'],
  [0x02, '3'],
  [0x03, '4'],
  [0x04, '5'],
  [0x05, '6'],
  [0x06, '7'],
  [0x07, '8'],
  [0x08, '9'],
  [0x09, '0/10'],
]);

function remote(long: string, short: string, commands: readonly (readonly [number, string])[]): RemoteDefinition {
  return { names: [long, short], commands: new Map([...commands, ...NUMBERS]) };
}

const REMOTES = new Map<string, RemoteDefinition>([
  [
    '1:none',
    remote('TV: ', 'TV:', [
      [0x15, 'Power'],
      [0x25, 'Input'],
      [0x33, 'Right'],
      [0x34, 'Left'],
      [0x3a, 'Display'],
      [0x60, 'Home'],
      [0x65, 'Enter'],
      [0x74, 'Up'],
      [0x75, 'Down'],
    ]),
  ],
  [
    '11:none',
    remote('Video: ', 'V:', [
      [0x18, 'Stop'],
      [0x19, 'Pause'],
      [0x1a, 'Play'],
      [0x1b, 'Rewind'],
      [0x1c, 'Fast Forward'],
      [0x42, 'Up'],
      [0x43, 'Down'],
      [0x4d, 'Home'],
      [0x51, 'Enter'],
      [0x5a, 'Display'],
      [0x61, 'Right'],
      [0x62, 'Left'],
    ]),
  ],
  ['16:40', remote('BlueRay: ', 'BR:', [[0x16, 'BlueRay']])],
  [
    '16:8',
    remote('Playback: ', 'PB:', [
      [0x2a, 'Shuffle'],
      [0x2c, 'Repeat'],
      [0x2e, 'Folder Down'],
      [0x2f, 'Folder Up'],
      [0x30, 'Previous'],
      [0x31, 'Next'],
      [0x32, 'Play'],
      [0x33, 'Rewind'],
      [0x34, 'Fast Forward'],
      [0x38, 'Stop'],
      [0x39, 'Pause'],
      [0x73, 'Options'],
      [0x7d, 'Return'],
    ]),
  ],
  [
    '17:none',
    remote('CD: ', 'CD:', [
      [0x28, 'Display'],
      [0x30, 'Previous'],
      [0x31, 'Next'],
      [0x32, 'Play'],
      [0x33, 'Rewind'],
      [0x34, 'Fast Forward'],
      [0x38, 'Stop'],
      [0x39, 'Pause'],
    ]),
  ],
  [
    '26:226',
    remote('BlueRay: ', 'BD:', [
      [0x18, 'Stop'],
      [0x19, 'Pause'],
      [0x1a, 'Play'],
      [0x1b, 'Rewind'],
      [0x1c, 'Fast Forward'],
      [0x29, 'Menu'],
      [0x2c, 'Top Menu'],
      [0x39, 'Up'],
      [0x3a, 'Down'],
      [0x3b, 'Left'],
      [0x3c, 'Right'],
      [0x3d, 'Enter'],
      [0x3f, 'Options'],
      [0x41, 'Display'],
      [0x42, 'Home'],
      [0x43, 'Return'],
      [0x56, 'Next'],
      [0x57, 'Previous'],
    ]),
  ],
  [
    '26:73',
    remote('DVD: ', 'DVD:', [
      [0x0b, 'Enter'],
      [0x0e, 'Return'],
      [0x17, 'Options'],
      [0x1a, 'Top Menu'],
      [0x1b, 'Menu'],
      [0x30, 'Previous'],
      [0x31, 'Next'],
      [0x32, 'Play'],
      [0x33, 'Rewind'],
      [0x34, 'Fast Forward'],
      [0x38, 'Stop'],
      [0x39, 'Pause'],
      [0x54, 'Display'],
      [0x7b, 'Left'],
      [0x7c, 'Right'],
      [0x79, 'Up'],
      [0x7a, 'Down'],
    ]),
  ],
  [
    '48:none',
    remote('Keypad: ', 'KP:', [
      [0x0c, 'Enter'],
      [0x12, 'Volume Up'],
      [0x13, 'Volume Down'],
      [0x14, 'Mute'],
      [0x15, 'Power'],
      [0x21, 'Tuner'],
      [0x22, 'Video'],
      [0x25, 'CD'],
      [0x4d, 'Home'],
      [0x4b, 'Display'],
      [0x60, 'Sleep'],
      [0x6a, 'TV'],
      [0x53, 'Home'],
      [0x7c, 'Game'],
      [0x7d, 'DVD'],
    ]),
  ],
  [
    '176:none',
    remote('Arrows: ', 'Ar:', [
      [0x7a, 'Left'],
      [0x7b, 'Right'],
      [0x78, 'Up'],
      [0x79, 'Down'],
      [0x77, 'Amp Menu'],
    ]),
  ],
  [
    '151:none',
    remote('TV Extra', 'TV:', [
      [0x23, 'Return'],
      [0x36, 'Options'],
    ]),
  ],
]);

export function sircRemoteText(address: number, command: number, extended: number | null): string[] {
  const definition = REMOTES.get(`${address}:${extended === null ? 'none' : extended}`);
  if (!definition) return ['Unknown Device: Unknown', 'UNK: Unknown'];
  const commandText = definition.commands.get(command) ?? 'Unknown';
  return definition.names.map((name) => name + commandText);
}
