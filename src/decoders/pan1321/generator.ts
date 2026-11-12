import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface PanItem {
  readonly direction: 'rx' | 'tx';
  readonly bytes: readonly number[];
}

export interface PanCase extends RoundtripCase<PanItem> {}

const UART_OPTIONS = {
  baudrate: 115200,
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
const CHANNELS = { rx: 1, tx: 5 } as const;
const SAMPLE_RATE = 460800;
const WIDTH = SAMPLE_RATE / UART_OPTIONS.baudrate;
const WITHIN_GAP = 1;
const BETWEEN_GAP = 2;

function bytes(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

function line(direction: 'rx' | 'tx', text: string): PanItem {
  return { direction, bytes: bytes(text) };
}

function annotationRows(text: string): readonly (readonly [number, string])[] {
  const command = text.slice(0, -2);
  if (text.startsWith('ROK'))
    return [
      [0, 'Device initialized correctly'],
      [1, 'Init'],
    ];
  if (text.startsWith('OK'))
    return [
      [0, 'Device acknowledged last command'],
      [1, 'ACK'],
    ];
  if (text.startsWith('ERR')) {
    const error = command.slice(command.indexOf('=') + 1);
    return [
      [0, `Device sent error code ${error}`],
      [1, `ERR = ${error}`],
    ];
  }
  if (text.startsWith('AT+JAAC')) {
    const parameter = command.slice(command.indexOf('=') + 1);
    if (parameter !== '0' && parameter !== '1') return [[2, `Warning: Invalid JAAC parameter "${parameter}"`]];
    const action = parameter === '1' ? 'Auto' : "Don't auto";
    return [
      [0, `${action}-accept new connections`],
      [1, `${action}-accept connections`],
    ];
  }
  if (text.startsWith('AT+JPRO')) {
    const parameter = command.slice(command.indexOf('=') + 1);
    if (parameter !== '0' && parameter !== '1') return [[2, `Warning: Invalid JPRO parameter "${parameter}"`]];
    const action = parameter === '0' ? 'Leaving' : 'Entering';
    return [
      [0, `${action} production mode`],
      [1, `Production mode = ${parameter === '1' ? 'on' : 'off'}`],
    ];
  }
  if (text.startsWith('AT+JRES')) {
    if (command !== 'AT+JRES') return [[2, 'Warning: Invalid JRES usage.']];
    return [
      [0, 'Triggering a software reset'],
      [1, 'Reset'],
    ];
  }
  if (text.startsWith('AT+JSDA')) {
    const [lengthText, data = ''] = command.slice(command.indexOf('=') + 1).split(',');
    const length = Number(lengthText);
    const rows: [number, string][] = [];
    if (!/^\d+$/.test(lengthText ?? '')) rows.push([2, `Warning: Invalid data length "${lengthText}".`]);
    if (length !== data.length) rows.push([2, `Warning: Data length mismatch (${length} != ${data.length}).`]);
    const hex = Array.from(data, (character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
    rows.push([0, `Sending ${length} data bytes: ${hex}`], [1, `Send ${length} = ${hex}`]);
    return rows;
  }
  if (text.startsWith('AT+JSEC')) {
    const pin = command.slice(-4);
    return [
      [0, `Host set the Bluetooth PIN to "${pin}"`],
      [1, `PIN = ${pin}`],
    ];
  }
  if (text.startsWith('AT+JSLN')) {
    const name = command.slice(command.indexOf(',') + 1);
    return [
      [0, `Host set the Bluetooth name to "${name}"`],
      [1, `BT name = ${name}`],
    ];
  }
  if (text.startsWith('AT+')) {
    return [
      [0, `Host sent unsupported command: ${command}`],
      [1, `Unsupported command: ${command}`],
    ];
  }
  return [
    [0, `Device sent an unknown reply: ${command}`],
    [1, `Unknown reply: ${command}`],
  ];
}

function timing(startSample: bigint) {
  let units = 2;
  return (items: readonly PanItem[]): { ss: bigint; es: bigint }[] => {
    const result: { ss: bigint; es: bigint }[] = [];
    for (const item of items) {
      const first = units;
      const last = first + (item.bytes.length - 1) * (9 + 1 + WITHIN_GAP);
      result.push({
        ss: startSample + BigInt(first + 1) * BigInt(WIDTH),
        es: startSample + BigInt(last + 9) * BigInt(WIDTH),
      });
      units += item.bytes.length * (9 + 1 + WITHIN_GAP) + BETWEEN_GAP;
    }
    return result;
  };
}

function block(items: readonly PanItem[], starts: readonly { ss: bigint; es: bigint }[], summary: boolean) {
  const expectedAnnotations: ExpectedFrame[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!,
      start = starts[index]!;
    for (const [classIndex, text] of annotationRows(String.fromCharCode(...item.bytes)))
      expectedAnnotations.push({ classIndex, texts: [text], ss: start.ss, es: start.es });
  }
  return {
    data: [...items],
    expected: summary ? [{ protoId: 'pan1321', kind: 'summary' }] : [],
    expectedAnnotations,
    annotationCount: expectedAnnotations.length,
    payloadBits: items.reduce((sum, item) => sum + item.bytes.length * 8, 0),
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x50414e31,
}: GenerationOptions = {}): Iterable<PanCase> {
  const boundaries: readonly (readonly [string, readonly PanItem[]])[] = [
    [
      'host-commands',
      [
        line('tx', 'AT+JAAC=1\r\n'),
        line('tx', 'AT+JPRO=0\r\n'),
        line('tx', 'AT+JRES\r\n'),
        line('tx', 'AT+JSDA=3,ABC\r\n'),
        line('tx', 'AT+JSEC=1,2,2,04,1234\r\n'),
        line('tx', 'AT+JSLN=05,Codex\r\n'),
        line('tx', 'AT+UNKNOWN\r\n'),
      ],
    ],
    [
      'invalid-commands',
      [
        line('tx', 'AT+JAAC=2\r\n'),
        line('tx', 'AT+JPRO=x\r\n'),
        line('tx', 'AT+JRES=1\r\n'),
        line('tx', 'AT+JSDA=3,AB\r\n'),
      ],
    ],
    ['device-replies', [line('rx', 'ROK\r\n'), line('rx', 'OK\r\n'), line('rx', 'ERR=7\r\n'), line('rx', 'HELLO\r\n')]],
  ];
  for (const [name, items] of boundaries) {
    const startSample = name === 'device-replies' ? 9_007_199_254_740_990n : 7n;
    const time = timing(startSample);
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
        const starts = time(items);
        yield block(items, starts, true);
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    perBlock = 256,
    nameLength = 60,
    hostBytes = 11 + nameLength + 2,
    replyBytes = 4,
    pairCount = Math.ceil(required / ((hostBytes + replyBytes) * 8)),
    itemCount = pairCount * 2,
    blocks = Math.ceil(itemCount / perBlock);
  let produced = 0;
  yield {
    name: 'seeded-long-lines',
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
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      for (let blockIndex = 0; blockIndex < blocks; blockIndex++) {
        const items: PanItem[] = [];
        for (let index = 0; index < perBlock && produced < itemCount; index++, produced++) {
          if (produced & 1) {
            items.push(line('rx', 'OK\r\n'));
            continue;
          }
          let name = '';
          for (let character = 0; character < nameLength; character++) name += alphabet[random() % alphabet.length];
          items.push(line('tx', `AT+JSLN=${nameLength},${name}\r\n`));
        }
        const starts = time(items);
        yield block(items, starts, blockIndex === 0);
      }
    },
  };
}
