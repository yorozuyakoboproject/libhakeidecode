import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { MDIO_TIMING, planMdioWaveform } from './encoder.js';
import type { MdioCommand, MdioFramePlan, MdioRun, MdioTiming } from './encoder.js';

export interface MdioCase extends RoundtripCase<MdioRun> {}

function hex16(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

function decimal2(value: number): string {
  return value.toString().padStart(2, '0');
}

function opText(command: MdioCommand): readonly string[] {
  if (!command.clause45) return command.opcode ? ['OP: READ', 'OP: R'] : ['OP: WRITE', 'OP: W'];
  if (command.opcode === 0) return ['OP: ADDR', 'OP: A'];
  if (command.opcode === 1) return ['OP: WRITE', 'OP: W'];
  if (command.opcode === 2) return ['OP: READINC', 'OP: RI'];
  return ['OP: READ', 'OP: R'];
}

function fieldAnnotations(command: MdioCommand, frame: MdioFramePlan): ExpectedFrame[] {
  const edges = frame.edges;
  const annotations: ExpectedFrame[] = [
    { ss: edges[0], es: edges[32], classIndex: 2, texts: ['PRE #32', 'PRE', 'P'] },
    {
      ss: edges[32],
      es: edges[34],
      classIndex: 2,
      texts: command.clause45 ? ['ST (Clause 45)', 'ST 45', 'ST', 'S'] : ['ST (Clause 22)', 'ST 22', 'ST', 'S'],
    },
    { ss: edges[34], es: edges[36], classIndex: 2, texts: [...opText(command), 'OP', 'O'] },
    {
      ss: edges[36],
      es: edges[41],
      classIndex: 2,
      texts: command.clause45
        ? [`PRTAD: ${decimal2(command.portAddress)}`, 'PRT', 'P']
        : [`PHYAD: ${decimal2(command.portAddress)}`, 'PHY', 'P'],
    },
    {
      ss: edges[41],
      es: edges[46],
      classIndex: 2,
      texts: command.clause45
        ? [`DEVAD: ${decimal2(command.deviceAddress)}`, 'DEV', 'D']
        : [`REGAD: ${decimal2(command.deviceAddress)}`, 'REG', 'R'],
    },
    { ss: edges[46], es: edges[48], classIndex: 2, texts: ['TA', 'T'] },
    { ss: edges[48], es: frame.es, classIndex: 2, texts: [`DATA: ${hex16(command.data)}`, 'DATA', 'D'] },
  ];

  if (frame.protocol) {
    const [, address, read] = frame.protocol[0];
    let short = '';
    if (command.clause45 && address !== -1) short += `ADDR: ${hex16(address)} `;
    else if (command.clause45) short += 'ADDR: UKWN ';
    short += `${read ? 'READ:  ' : 'WRITE: '}${hex16(command.data)}`;
    let extended = ` ${command.clause45 ? 'PRTAD' : 'PHYAD'}: ${decimal2(command.portAddress)}`;
    extended += ` ${command.clause45 ? 'DEVAD' : 'REGAD'}: ${decimal2(command.deviceAddress)}`;
    annotations.push({
      ss: frame.ss,
      es: frame.es,
      classIndex: 5,
      texts: [short + extended, short],
    });
  }

  return annotations;
}

function protocolFrames(plan: ReturnType<typeof planMdioWaveform>): ExpectedFrame[] {
  return plan.frames.flatMap((frame) =>
    frame.protocol
      ? [
          {
            ss: frame.ss,
            es: frame.es,
            protoId: 'mdio',
            kind: 'protocol',
            data: frame.protocol,
          } satisfies ExpectedFrame,
        ]
      : [],
  );
}

function boundaryCommands(): MdioCommand[] {
  return [
    { clause45: false, opcode: 0, portAddress: 3, deviceAddress: 0x12, data: 0xa55a },
    { clause45: false, opcode: 1, portAddress: 7, deviceAddress: 0x1f, data: 0xc003 },
    { clause45: true, opcode: 0, portAddress: 0, deviceAddress: 1, data: 0x8000 },
    { clause45: true, opcode: 2, portAddress: 0, deviceAddress: 1, data: 0x1234 },
    { clause45: true, opcode: 3, portAddress: 0, deviceAddress: 1, data: 0x5678 },
    { clause45: true, opcode: 1, portAddress: 0, deviceAddress: 1, data: 0x9abc },
  ];
}

function makeBoundary(
  name: string,
  commands: readonly MdioCommand[],
  options: Record<string, string>,
  timing: MdioTiming,
  startSample: bigint,
  chunkSamples: readonly number[],
): MdioCase {
  const caseConfig: MdioCase = {
    name,
    kind: 'boundary',
    seed: 0x4d44494f,
    sampleRate: 1_000_000,
    startSample,
    channels: { mdc: 1, mdio: 4 },
    options,
    chunkSamples,
    minimumPayloadBits: 0,
    *generate() {
      const plan = planMdioWaveform(commands, caseConfig.startSample, timing);
      const annotations = commands.flatMap((command, index) => fieldAnnotations(command, plan.frames[index]!));
      const decoded = plan.frames.filter((frame) => frame.protocol !== null).length;
      const debugBits = options.show_debug_bits === 'yes' ? commands.length * 64 : 0;
      yield {
        data: plan.runs,
        expected: protocolFrames(plan),
        expectedAnnotations: annotations,
        annotationCount: commands.length * 71 + decoded + debugBits,
        payloadBits: commands.length * 64,
      };
    },
  };
  return caseConfig;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d44494f,
}: GenerationOptions = {}): Iterable<MdioCase> {
  yield makeBoundary(
    'clause22-clause45-boundaries',
    boundaryCommands(),
    { show_debug_bits: 'no' },
    MDIO_TIMING,
    9_007_199_254_740_990n,
    [1, 17, 257, 4093],
  );
  yield makeBoundary(
    'debug-bit-numbers',
    [boundaryCommands()[1]!],
    { show_debug_bits: 'yes' },
    { low: 1, high: 3, gap: 4, lead: 2 },
    31n,
    [3, 11, 127],
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const framesPerBlock = 1024;
  const blockCount = Math.ceil(required / (framesPerBlock * 64));
  const totalFrames = framesPerBlock * blockCount;
  const random = randomWords(seed);
  const caseConfig: MdioCase = {
    name: 'seeded-long-management-frames',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { mdc: 0, mdio: 2 },
    options: { show_debug_bits: 'no' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      let sample = caseConfig.startSample;
      let remaining = totalFrames;
      while (remaining > 0) {
        const count = Math.min(framesPerBlock, remaining);
        const commands: MdioCommand[] = [
          {
            clause45: true,
            opcode: 0,
            portAddress: random() & 31,
            deviceAddress: random() & 31,
            data: random() & 0xffff,
          },
        ];
        for (let index = 1; index < count; index++) {
          const clause45 = (random() & 1) === 0;
          commands.push({
            clause45,
            opcode: clause45 ? 1 + (random() % 3) : random() & 1,
            portAddress: random() & 31,
            deviceAddress: random() & 31,
            data: random() & 0xffff,
          });
        }

        const plan = planMdioWaveform(commands, sample, MDIO_TIMING);
        sample = plan.endSample;
        const decoded = plan.frames.filter((frame) => frame.protocol !== null).length;
        yield {
          data: plan.runs,
          expected: protocolFrames(plan),
          expectedAnnotations: fieldAnnotations(commands[0]!, plan.frames[0]!).slice(0, 3),
          annotationCount: count * 71 + decoded,
          payloadBits: count * 64,
        };
        remaining -= count;
      }
    },
  };
  yield caseConfig;
}
