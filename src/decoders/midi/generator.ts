import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

interface Expectation {
  readonly classIndex: number;
  readonly texts: readonly string[];
  readonly first: number;
  readonly last: number;
}

export interface MidiItem {
  readonly direction: 'rx' | 'tx';
  readonly bytes: readonly number[];
  readonly expectations: readonly Expectation[];
}

export interface MidiCase extends RoundtripCase<MidiItem> {}

const UART_OPTIONS = {
  baudrate: 31250,
  data_bits: 8,
  parity: 'none',
  stop_bits: 1,
  bit_order: 'lsb-first',
  format: 'hex',
  invert_rx: 'no',
  invert_tx: 'no',
  sample_point: 50,
  rx_packet_delim: -1,
  tx_packet_delim: -1,
  rx_packet_len: -1,
  tx_packet_len: -1,
} as const;
const CHANNELS = { rx: 3, tx: 7 } as const;
const SAMPLE_RATE = 125000;
const WIDTH = SAMPLE_RATE / UART_OPTIONS.baudrate;
const WITHIN_GAP = 1;
const BETWEEN_GAP = 2;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PERCUSSION: Readonly<Record<number, string>> = {
  35: 'Acoustic Bass Drum',
  36: 'Bass Drum 1',
  37: 'Side Stick',
  38: 'Acoustic Snare',
  39: 'Hand Clap',
  40: 'Electric Snare',
  41: 'Low Floor Tom',
  42: 'Closed Hi Hat',
  43: 'High Floor Tom',
  44: 'Pedal Hi-Hat',
  45: 'Low Tom',
  46: 'Open Hi-Hat',
  47: 'Low-Mid Tom',
  48: 'Hi Mid Tom',
  49: 'Crash Cymbal 1',
  50: 'High Tom',
  51: 'Ride Cymbal 1',
  52: 'Chinese Cymbal',
  53: 'Ride Bell',
  54: 'Tambourine',
  55: 'Splash Cymbal',
  56: 'Cowbell',
  57: 'Crash Cymbal 2',
  58: 'Vibraslap',
  59: 'Ride Cymbal 2',
  60: 'Hi Bongo',
  61: 'Low Bongo',
  62: 'Mute Hi Conga',
  63: 'Open Hi Conga',
  64: 'Low Conga',
  65: 'High Timbale',
  66: 'Low Timbale',
  67: 'High Agogo',
  68: 'Low Agogo',
  69: 'Cabasa',
  70: 'Maracas',
  71: 'Short Whistle',
  72: 'Long Whistle',
  73: 'Short Guiro',
  74: 'Long Guiro',
  75: 'Claves',
  76: 'Hi Wood Block',
  77: 'Low Wood Block',
  78: 'Mute Cuica',
  79: 'Open Cuica',
  80: 'Mute Triangle',
  81: 'Open Triangle',
};

function note(channel: number, value: number): string {
  if (channel === 10) return `assuming ${PERCUSSION[value] ?? 'undefined'}`;
  return NOTE_NAMES[value % 12]! + (Math.floor(value / 12) - 1);
}

function noteTexts(channel: number, value: number, velocity: number): readonly string[] {
  const status = velocity === 0 ? ['note off', 'note off', 'N off'] : ['note on', 'note on', 'N on'];
  return [
    `Channel ${channel}: ${status[0]} (note = ${value} '${note(channel, value)}', velocity = ${velocity})`,
    `ch ${channel}: ${status[1]} ${value}, velocity = ${velocity}`,
    `${channel}: ${status[2]} ${value}, vel ${velocity}`,
  ];
}

function item(direction: 'rx' | 'tx', bytes: readonly number[], expectations: readonly Expectation[]): MidiItem {
  return { direction, bytes, expectations };
}

function messageItem(
  direction: 'rx' | 'tx',
  bytes: readonly number[],
  classIndex: number,
  texts: readonly string[],
): MidiItem {
  return item(direction, bytes, [{ classIndex, texts, first: 0, last: bytes.length - 1 }]);
}

function timing(startSample: bigint) {
  let units = 2;
  return (items: readonly MidiItem[]): ExpectedFrame[] => {
    const annotations: ExpectedFrame[] = [];
    for (const current of items) {
      for (const expected of current.expectations) {
        const first = units + expected.first * (9 + 1 + WITHIN_GAP);
        const last = units + expected.last * (9 + 1 + WITHIN_GAP);
        annotations.push({
          classIndex: expected.classIndex,
          texts: expected.texts,
          ss: startSample + BigInt(first + 1) * BigInt(WIDTH),
          es: startSample + BigInt(last + 9) * BigInt(WIDTH),
        });
      }
      units += current.bytes.length * (9 + 1 + WITHIN_GAP) + BETWEEN_GAP;
    }
    return annotations;
  };
}

function block(items: readonly MidiItem[], annotations: readonly ExpectedFrame[], summary: boolean) {
  return {
    data: [...items],
    expected: summary ? [{ protoId: 'midi', kind: 'summary' }] : [],
    expectedAnnotations: [...annotations],
    annotationCount: annotations.length,
    payloadBits: items.reduce((sum, current) => sum + current.bytes.length * 8, 0),
  };
}

function channelMessages(): MidiItem {
  const bytes: number[] = [],
    expectations: Expectation[] = [];
  const add = (message: readonly number[], texts: readonly string[]) => {
    const first = bytes.length;
    bytes.push(...message);
    expectations.push({ classIndex: 0, texts, first, last: bytes.length - 1 });
  };
  add(
    [0x83, 60, 64],
    ["Channel 4: note off (note = 60 'C4', velocity = 64)", 'ch 4: note off 60, velocity = 64', '4: N off 60, vel 64'],
  );
  add(
    [0x93, 62, 0],
    ["Channel 4: note off (note = 62 'D4', velocity = 0)", 'ch 4: note off 62, velocity = 0', '4: N off 62, vel 0'],
  );
  add(
    [0xa4, 64, 70],
    [
      "Channel 5: polyphonic key pressure / aftertouch of 70 for note = 64 'E4'",
      'ch 5: key pressure 70 for note 64',
      '5: KP 70, N 64',
    ],
  );
  add(
    [0xb0, 0x07, 0x64],
    [
      "Channel 1: control change 'channel volume MSB (formerly main volume)' (param = 0x64)",
      "ch 1: ctrl chg 'channel volume MSB' (param = 0x64)",
      "1: CC 'ch vol-M' is 0x64",
    ],
  );
  add(
    [0xb0, 0x44, 0x3f],
    [
      "Channel 1: control change 'legato footswitch' = normal",
      "ch 1: ctrl chg 'legato switch' = normal",
      "1: CC 'legato' = no",
    ],
  );
  add(
    [0xb0, 0x54, 0x64],
    [
      "Channel 1: control change 'portamento control' (source note = 100 / E7)",
      "ch 1: ctrl chg 'portamento ctrl' (source note = 100)",
      "1: CC 'porta ctrl' (src N 100)",
    ],
  );
  add(
    [0xb0, 0x7a, 0x7f],
    ["Channel 1: control change 'local control' on", "ch 1: ctrl chg 'local ctrl' on", "1: CC 'local ctrl' on"],
  );
  add(
    [0xc9, 24],
    [
      'Channel 10: program change to drum kit 25 (assuming GS Power Kit)',
      'ch 10: prgm chg to drum kit 25',
      '10: PC 25',
    ],
  );
  add([0xd2, 88], ['Channel 3: channel pressure / aftertouch 88', 'ch 3: channel pressure 88', '3: CP 88']);
  add(
    [0xe5, 0x01, 0x40],
    ['Channel 6: pitch bend change 0x01 0x40 (8193)', 'ch 6: pitch bend 0x01 0x40 (8193)', '6: PB (8193)'],
  );
  add(
    [0x90, 69, 100],
    ["Channel 1: note on (note = 69 'A4', velocity = 100)", 'ch 1: note on 69, velocity = 100', '1: N on 69, vel 100'],
  );
  add(
    [70, 101],
    ["Channel 1: note on (note = 70 'A#4', velocity = 101)", 'ch 1: note on 70, velocity = 101', '1: N on 70, vel 101'],
  );
  return item('tx', bytes, expectations);
}

function splitSystemMessages(): MidiItem[] {
  return [
    messageItem('tx', [0xf0, 0x41, 0x10, 0x7f, 0x00, 0x00, 0x01, 0xf7], 0, [
      "system exclusive: for 'Roland' with payload 0x10 0x7f 0x00 0x00 0x01 ",
      "SysEx: 'Roland', payload 10 7f 00 00 01 ",
      "SE: 'Roland', payload 10 7f 00 00 01 ",
    ]),
    messageItem('tx', [0xf1, 0x45], 0, [
      'System Common: MIDI time code quarter frame of minutes LS nibble, value 0x5',
      'SysCom: MIDI time code of min LSN, value 0x5',
      'SC: MIDI time of min LSN, value 0x5',
    ]),
    messageItem('tx', [0xf2, 0x10, 0x20], 0, [
      'System Common: song position pointer 0x10 0x20 (4112)',
      'SysCom: song position 0x10 0x20 (4112)',
      'SC: song pos (4112)',
    ]),
    messageItem('tx', [0xf3, 7], 0, [
      'System Common: song select number 7',
      'SysCom: song select number 7',
      'SC: song sel # 7',
    ]),
    messageItem('tx', [0xf6], 0, ['System Common: tune request', 'SysCom: tune request', 'SC: tune req']),
    messageItem('tx', [0xf8], 1, ['System Realtime: timing clock', 'SysReal: timing clock', 'SR: clock']),
  ];
}

function interruptionAndGarbage(): MidiItem[] {
  return [
    item(
      'tx',
      [0x90, 0xf8, 60, 100],
      [
        {
          classIndex: 1,
          texts: ['System Realtime: timing clock', 'SysReal: timing clock', 'SR: clock'],
          first: 1,
          last: 1,
        },
        {
          classIndex: 0,
          texts: [
            "Channel 1: note on (note = 60 'C4', velocity = 100)",
            'ch 1: note on 60, velocity = 100',
            '1: N on 60, vel 100',
          ],
          first: 0,
          last: 3,
        },
      ],
    ),
    item(
      'tx',
      [0x01, 0xf8, 0x90],
      [
        {
          classIndex: 1,
          texts: ['System Realtime: timing clock', 'SysReal: timing clock', 'SR: clock'],
          first: 1,
          last: 1,
        },
        { classIndex: 2, texts: ['UNHANDLED DATA: 0x01', 'UNHANDLED', '???', '?'], first: 0, last: 1 },
      ],
    ),
    item(
      'tx',
      [0xf0, 0xf7],
      [
        {
          classIndex: 2,
          texts: [
            'system exclusive: truncated manufacturer code (<1 bytes)',
            'SysEx: truncated manufacturer (<1 bytes)',
            'SE: trunc. manu.',
          ],
          first: 0,
          last: 1,
        },
      ],
    ),
  ];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d494449,
}: GenerationOptions = {}): Iterable<MidiCase> {
  const boundaries: readonly (readonly [string, readonly MidiItem[]])[] = [
    ['channel-messages', [channelMessages()]],
    ['system-messages', splitSystemMessages()],
    ['interruption-garbage', interruptionAndGarbage()],
  ];
  for (const [name, items] of boundaries) {
    const startSample = name === 'channel-messages' ? 9_007_199_254_740_990n : 9n,
      time = timing(startSample);
    yield {
      name,
      kind: 'boundary',
      seed,
      sampleRate: SAMPLE_RATE,
      startSample,
      channels: CHANNELS,
      options: {},
      chunkSamples: [1, 31, 257, 4093],
      minimumPayloadBits: 0,
      chain: [{ decoder: 'uart', options: UART_OPTIONS }],
      *generate() {
        yield block(items, time(items), true);
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    perBlock = 256,
    count = Math.ceil(required / 24),
    blocks = Math.ceil(count / perBlock);
  let generated = 0;
  yield {
    name: 'seeded-long-notes',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const random = randomWords(seed),
        time = timing(0n);
      for (let blockIndex = 0; blockIndex < blocks; blockIndex++) {
        const items: MidiItem[] = [];
        for (let index = 0; index < perBlock && generated < count; index++, generated++) {
          const channel = 1 + (random() & 15),
            value = random() & 0x7f,
            velocity = 1 + (random() % 127);
          items.push(
            messageItem(
              generated & 1 ? 'rx' : 'tx',
              [0x90 | (channel - 1), value, velocity],
              0,
              noteTexts(channel, value, velocity),
            ),
          );
        }
        const annotations = time(items);
        yield block(items, annotations, blockIndex === 0);
      }
    },
  };
}
