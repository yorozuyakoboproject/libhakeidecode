import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { planMdioWaveform } from '../mdio/encoder.js';
import type { MdioCommand, MdioRun } from '../mdio/encoder.js';

export interface CfpCase extends RoundtripCase<MdioRun> {}

const CHAIN = [{ decoder: 'mdio', options: { show_debug_bits: 'no' } }] as const;
const SUMMARY: ExpectedFrame = { protoId: 'cfp', kind: 'summary' };

const MODULE_ID: Readonly<Record<number, string>> = {
  0x00: 'Unknown or unspecified',
  0x01: 'GBIC',
  0x02: 'Module/connector soldered to motherboard',
  0x03: 'SFP',
  0x04: '300 pin XSBI',
  0x05: 'XENPAK',
  0x06: 'XFP',
  0x07: 'XFF',
  0x08: 'XFP-E',
  0x09: 'XPAK',
  0x0a: 'X2',
  0x0b: 'DWDM-SFP',
  0x0c: 'QSFP',
  0x0d: 'QSFP+',
  0x0e: 'CFP',
  0x0f: 'CXP (TBD)',
  0x11: 'CFP2',
  0x12: 'CFP4',
};

function addressFrame(address: number): MdioCommand {
  return { clause45: true, opcode: 0, portAddress: 0, deviceAddress: 1, data: address };
}

function readFrame(data: number): MdioCommand {
  return { clause45: true, opcode: 3, portAddress: 0, deviceAddress: 1, data };
}

function writeFrame(data: number): MdioCommand {
  return { clause45: true, opcode: 1, portAddress: 0, deviceAddress: 1, data };
}

function decodedAnnotations(
  commands: readonly MdioCommand[],
  plan: ReturnType<typeof planMdioWaveform>,
): ExpectedFrame[] {
  const annotations: ExpectedFrame[] = [];
  for (let index = 0; index < commands.length; index++) {
    const frame = plan.frames[index]!;
    const packet = frame.protocol?.[0];
    if (!packet || !packet[2]) continue;
    const address = packet[1];
    const value = packet[5];
    const add = (classIndex: number, texts: readonly string[]): void => {
      annotations.push({ ss: frame.ss, es: frame.es, classIndex, texts });
    };

    if (address >= 0x8000 && address <= 0x807f) {
      add(0, ['CFP NVR 1: Basic ID register', 'NVR1']);
      if (address === 0x8000) add(1, [`Module identifier: ${MODULE_ID[value] ?? 'Reserved'}`]);
    } else if (address >= 0x8080 && address <= 0x80ff) {
      add(0, ['CFP NVR 2: Extended ID register', 'NVR2']);
    } else if (address >= 0x8100 && address <= 0x817f) {
      add(0, ['CFP NVR 3: Network lane specific register', 'NVR3']);
    } else if (address >= 0x8180 && address <= 0x81ff) {
      add(0, ['CFP NVR 4', 'NVR4']);
    } else if (address >= 0x8400 && address <= 0x847f) {
      add(0, ['Vendor NVR 1: Vendor data register', 'V-NVR1']);
    } else if (address >= 0x8480 && address <= 0x84ff) {
      add(0, ['Vendor NVR 2: Vendor data register', 'V-NVR2']);
    } else if (address >= 0x8800 && address <= 0x887f) {
      add(0, ['User NVR 1: User data register', 'U-NVR1']);
    } else if (address >= 0x8880 && address <= 0x88ff) {
      add(0, ['User NVR 2: User data register', 'U-NVR2']);
    } else if (address >= 0xa000 && address <= 0xa07f) {
      add(0, ['CFP Module VR 1: CFP Module level control and DDM register', 'Mod-VR1']);
    } else if (address >= 0xa080 && address <= 0xa0ff) {
      add(0, ['MLG VR 1: MLG Management Interface register', 'MLG-VR1']);
    }
  }
  return annotations;
}

function boundaryCommands(): MdioCommand[] {
  const commands: MdioCommand[] = [
    addressFrame(0x8000),
    readFrame(0x000e),
    readFrame(0x0000),
    writeFrame(0x1234),
    addressFrame(0x4321),
    readFrame(0x0001),
  ];
  for (const address of [0x8080, 0x8100, 0x8180, 0x8400, 0x8480, 0x8800, 0x8880, 0xa000, 0xa080]) {
    commands.push(addressFrame(address), readFrame(address & 0xffff));
  }
  return commands;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x43465000,
}: GenerationOptions = {}): Iterable<CfpCase> {
  const boundary = boundaryCommands();
  const boundaryStart = 9_007_199_254_740_990n;
  yield {
    name: 'cfp-register-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: boundaryStart,
    channels: { mdc: 1, mdio: 3 },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const plan = planMdioWaveform(boundary, boundaryStart);
      const annotations = decodedAnnotations(boundary, plan);
      yield {
        data: plan.runs,
        expected: [SUMMARY],
        expectedAnnotations: annotations,
        annotationCount: annotations.length,
        payloadBits: boundary.length * 64,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const framesPerBlock = 8192;
  const blockCount = Math.max(2, Math.ceil(required / (framesPerBlock * 64)));
  const random = randomWords(seed);
  const addresses = [0x8000, 0x8080, 0x8100, 0x8180, 0x8400, 0x8480, 0x8800, 0x8880, 0xa000, 0xa080, 0x1234] as const;
  const longCase: CfpCase = {
    name: 'seeded-long-cfp-register-reads',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { mdc: 0, mdio: 4 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      let sample = longCase.startSample;
      for (let block = 0; block < blockCount; block++) {
        const commands: MdioCommand[] = [];
        for (let pair = 0; pair < framesPerBlock / 2; pair++) {
          const address = addresses[pair % addresses.length]!;
          commands.push(addressFrame(address), readFrame(random() & 0xffff));
        }
        if (commands[1]) commands[1] = readFrame(0x000e);

        const plan = planMdioWaveform(commands, sample, { low: 1, high: 1, gap: 2, lead: 1 });
        sample = plan.endSample;
        const annotations = decodedAnnotations(commands, plan);
        yield {
          data: plan.runs,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: annotations.slice(0, 4),
          annotationCount: annotations.length,
          payloadBits: commands.length * 64,
        };
      }
    },
  };
  yield longCase;
}
