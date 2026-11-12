import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { OnewireTimeline, bitsFromBigInt, bitsFromBytes } from '../onewire_link/generator.js';
import type { OnewireOperation } from '../onewire_link/generator.js';

export interface OnewireNetworkCase extends RoundtripCase<OnewireOperation> {}

const COMMANDS: Readonly<Record<number, readonly [string, string]>> = {
  0x33: ['Read ROM', 'GET ROM'],
  0x0f: ['Conditional read ROM', 'GET ROM'],
  0xcc: ['Skip ROM', 'TRANSPORT'],
  0x55: ['Match ROM', 'GET ROM'],
  0xf0: ['Search ROM', 'SEARCH ROM'],
  0xec: ['Conditional search ROM', 'SEARCH ROM'],
  0x3c: ['Overdrive skip ROM', 'TRANSPORT'],
  0x69: ['Overdrive match ROM', 'GET ROM'],
  0xa5: ['Resume', 'TRANSPORT'],
  0x96: ['DS2408: Disable Test Mode', 'GET ROM'],
};
const MASK64 = 0xffffffffffffffffn;

function hex(value: bigint, digits: number): string {
  return value.toString(16).padStart(digits, '0');
}

interface NetworkTrace {
  readonly frames: ExpectedFrame[];
  readonly annotations: ExpectedFrame[];
}

export function networkTrace(operations: readonly OnewireOperation[], timeline: OnewireTimeline): NetworkTrace {
  const frames: ExpectedFrame[] = [],
    annotations: ExpectedFrame[] = [];
  let state = 'COMMAND',
    bitCount = 0,
    search = 'P',
    data = 0n,
    ssBlock = 0n,
    esBlock = 0n;
  const collect = (length: number, value: number, ss: bigint, es: bigint): boolean => {
    if (bitCount === 0) ssBlock = ss;
    data = (data & ~(1n << BigInt(bitCount))) | (BigInt(value) << BigInt(bitCount));
    bitCount++;
    if (bitCount !== length) return false;
    esBlock = es;
    data &= (1n << BigInt(length)) - 1n;
    bitCount = 0;
    return true;
  };
  const searchRom = (length: number, value: number, ss: bigint, es: bigint): boolean => {
    if (bitCount === 0 && search === 'P') ssBlock = ss;
    if (search === 'P') {
      search = 'N';
    } else if (search === 'N') {
      search = 'D';
    } else {
      data = (data & ~(1n << BigInt(bitCount))) | (BigInt(value) << BigInt(bitCount));
      search = 'P';
      bitCount++;
    }
    if (bitCount !== length) return false;
    esBlock = es;
    const mask = (1n << BigInt(length)) - 1n;
    data &= mask;
    search = 'P';
    bitCount = 0;
    return true;
  };

  for (const operation of operations) {
    if (operation.kind === 'reset') {
      const event = timeline.reset(operation),
        text = `Reset/presence: ${operation.presence ? 'true' : 'false'}`;
      frames.push({
        ss: event.rise,
        es: event.presencePacketEnd,
        protoId: 'onewire_network',
        kind: 'protocol',
        data: ['RESET/PRESENCE', operation.presence],
      });
      annotations.push({ classIndex: 0, texts: [text], ss: event.rise, es: event.presencePacketEnd });
      search = 'P';
      bitCount = 0;
      state = 'COMMAND';
      continue;
    }
    const events = timeline.bits(operation);
    for (let index = 0; index < operation.bits.length; index++) {
      const ss = events[index]!.fall,
        es = events[index]!.slotEnd,
        value = operation.bits[index]!;
      if (state === 'COMMAND') {
        if (!collect(8, value, ss, es)) continue;
        const command = COMMANDS[Number(data)],
          text = `ROM command: 0x${hex(data, 2)} '${command ? command[0] : 'unrecognized'}'`;
        annotations.push({ classIndex: 0, texts: [text], ss: ssBlock, es: esBlock });
        state = command ? command[1]! : 'COMMAND ERROR';
      } else if (state === 'GET ROM') {
        if (!collect(64, value, ss, es)) continue;
        const rom = data & MASK64;
        annotations.push({ classIndex: 0, texts: [`ROM: 0x${hex(rom, 16)}`], ss: ssBlock, es: esBlock });
        frames.push({
          ss: ssBlock,
          es: esBlock,
          protoId: 'onewire_network',
          kind: 'protocol',
          data: ['ROM', rom],
        });
        state = 'TRANSPORT';
      } else if (state === 'SEARCH ROM') {
        if (!searchRom(64, value, ss, es)) continue;
        const rom = data & MASK64;
        annotations.push({ classIndex: 0, texts: [`ROM: 0x${hex(rom, 16)}`], ss: ssBlock, es: esBlock });
        frames.push({
          ss: ssBlock,
          es: esBlock,
          protoId: 'onewire_network',
          kind: 'protocol',
          data: ['ROM', rom],
        });
        state = 'TRANSPORT';
      } else if (state === 'TRANSPORT') {
        if (!collect(8, value, ss, es)) continue;
        annotations.push({ classIndex: 0, texts: [`Data: 0x${hex(data, 2)}`], ss: ssBlock, es: esBlock });
        frames.push({
          ss: ssBlock,
          es: esBlock,
          protoId: 'onewire_network',
          kind: 'protocol',
          data: ['DATA', Number(data)],
        });
      } else if (collect(8, value, ss, es)) {
        annotations.push({
          classIndex: 0,
          texts: [`ROM error data: 0x${hex(data, 2)}`],
          ss: ssBlock,
          es: esBlock,
        });
      }
    }
  }
  return { frames, annotations };
}

function searchBits(rom: bigint): number[] {
  const result: number[] = [];
  for (let bit = 0; bit < 64; bit++) {
    const value = Number((rom >> BigInt(bit)) & 1n);
    result.push(value, value ^ 1, value);
  }
  return result;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x31574e45,
}: GenerationOptions = {}): Iterable<OnewireNetworkCase> {
  yield {
    name: 'rom-command-paths',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { owr: 2 },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'onewire_link', options: { overdrive: 'no' } }],
    *generate() {
      const rom = 0x1234567890abcdefn,
        searchRom = 0xfedcba0987654321n,
        data: OnewireOperation[] = [
          { kind: 'reset', presence: true },
          { kind: 'bits', bits: bitsFromBytes([0xcc]) },
          { kind: 'bits', bits: bitsFromBytes([0x00, 0xff]) },
          { kind: 'reset', presence: false },
          { kind: 'bits', bits: bitsFromBytes([0x33]) },
          { kind: 'bits', bits: bitsFromBigInt(rom, 64) },
          { kind: 'reset', presence: true },
          { kind: 'bits', bits: bitsFromBytes([0x55]) },
          { kind: 'bits', bits: bitsFromBigInt(rom, 64) },
          { kind: 'bits', bits: bitsFromBytes([0xa5]) },
          { kind: 'reset', presence: true },
          { kind: 'bits', bits: bitsFromBytes([0xf0]) },
          { kind: 'bits', bits: searchBits(searchRom) },
          { kind: 'reset', presence: false },
          { kind: 'bits', bits: bitsFromBytes([0x99, 0x42]) },
          { kind: 'reset', presence: true },
          { kind: 'bits', bits: bitsFromBytes([0xa5]) },
          { kind: 'bits', bits: bitsFromBytes([0x5a]) },
        ],
        timeline = new OnewireTimeline({
          startSample: 9_007_199_254_740_990n,
          sampleRate: 1_000_000,
        }),
        trace = networkTrace(data, timeline);
      yield {
        data,
        expected: trace.frames,
        expectedAnnotations: trace.annotations,
        annotationCount: trace.annotations.length,
        payloadBits: data.reduce(
          (count, operation) => count + (operation.kind === 'bits' ? operation.bits.length : 0),
          0,
        ),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    transactionsPerBlock = 300,
    bitsPerTransaction = 8 + 64 + 8,
    blocks = Math.ceil(required / (transactionsPerBlock * bitsPerTransaction));
  yield {
    name: 'seeded-long-overdrive-rom-stream',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { owr: 5 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'onewire_link', options: { overdrive: 'yes' } }],
    *generate() {
      const random = randomWords(seed),
        timeline = new OnewireTimeline({ startSample: 0n, sampleRate: 2_000_000 });
      for (let block = 0; block < blocks; block++) {
        const operations: OnewireOperation[] = [];
        for (let index = 0; index < transactionsPerBlock; index++) {
          const rom = (BigInt(random()) << 32n) | BigInt(random());
          operations.push(
            { kind: 'reset', presence: true, overdrive: true },
            { kind: 'bits', bits: bitsFromBytes([0x55]), overdrive: true },
            { kind: 'bits', bits: bitsFromBigInt(rom, 64), overdrive: true },
            { kind: 'bits', bits: bitsFromBytes([random() & 0xff]), overdrive: true },
          );
        }
        const trace = networkTrace(operations, timeline);
        yield {
          data: operations,
          expected: trace.frames,
          expectedAnnotations: trace.annotations.slice(0, 4),
          annotationCount: trace.annotations.length,
          payloadBits: operations.reduce(
            (count, operation) => count + (operation.kind === 'bits' ? operation.bits.length : 0),
            0,
          ),
        };
      }
    },
  };
}
