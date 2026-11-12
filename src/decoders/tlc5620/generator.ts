import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Tlc5620Command {
  readonly bits: number;
  readonly bitCount?: number;
  readonly load?: boolean;
  readonly ldac?: 0 | 1;
  readonly ldacFall?: boolean;
}

export interface Tlc5620Case extends RoundtripCase<Tlc5620Command> {}

const DAC_NAMES = ['DACA', 'DACB', 'DACC', 'DACD'] as const;
const VREFS = [3.3, 3.3, 3.3, 3.3] as const;

export function wordBits(dac: number, gain: number, value: number): number {
  return ((dac & 3) << 9) | (((gain - 1) & 1) << 8) | (value & 0xff);
}

function summary(): ExpectedFrame {
  return { protoId: 'tlc5620', kind: 'summary' };
}

function commandAnnotations(bits: number, ldac: 0 | 1 = 1, vrefs: readonly number[] = VREFS): ExpectedFrame[] {
  const dacIndex = (bits >> 9) & 3;
  const gain = 1 + ((bits >> 8) & 1);
  const value = bits & 0xff;
  const dac = DAC_NAMES[dacIndex]!;
  const result: ExpectedFrame[] = [
    { classIndex: 0, texts: [`DAC select: ${dac}`, `DAC sel: ${dac}`, `DAC: ${dac}`, `D: ${dac}`, dac, dac[3]] },
    { classIndex: 1, texts: [`Gain: x${gain}`, `G: x${gain}`, `x${gain}`] },
    {
      classIndex: 2,
      texts: [`DAC value: ${value}`, `Value: ${value}`, `Val: ${value}`, `V: ${value}`, `${value}`],
    },
  ];
  for (let index = 0; index <= 10; index++) result.push({ classIndex: 5, texts: [`${(bits >> (10 - index)) & 1}`] });
  result.push({ classIndex: 3, texts: ['Falling edge on LOAD', 'LOAD fall', 'F'] });
  const voltage = `${(vrefs[dacIndex]! * (value / 256) * gain).toFixed(2)}V`;
  result.push({
    classIndex: ldac ? 6 : 7,
    texts: [`Setting ${dac} ${ldac ? 'register value' : 'voltage'} to ${voltage}`, `${dac}=${voltage}`],
  });
  return result;
}

function ldacAnnotations(vrefs: readonly number[] = VREFS): ExpectedFrame[] {
  const values = DAC_NAMES.map((dac, index) => {
    const value = index === 0 ? 0 : index === 1 ? 128 : index === 3 ? 255 : null;
    return value === null ? '?' : `${(vrefs[index]! * (value / 256) * (index === 3 ? 2 : 1)).toFixed(2)}V`;
  });
  const full = DAC_NAMES.map((dac, index) => `${dac}=${values[index]}`).join(' ');
  const short = values.map((value, index) => `${'ABCD'[index]}=${value}`).join(' ');
  return [
    { classIndex: 4, texts: ['Falling edge on LDAC', 'LDAC fall', 'LDAC', 'L'] },
    { classIndex: 8, texts: [`Updating voltages: ${full}`, full, short] },
  ];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x544c4335,
}: GenerationOptions = {}): Iterable<Tlc5620Case> {
  const commands: Tlc5620Command[] = [
    { bits: wordBits(0, 1, 0), ldac: 0 },
    { bits: wordBits(3, 2, 255), ldac: 0 },
    { bits: wordBits(1, 1, 128), ldac: 1 },
    { bits: 0, bitCount: 0, load: false, ldacFall: true },
  ];
  const expectedAnnotations = [
    ...commandAnnotations(commands[0]!.bits, 0),
    ...commandAnnotations(commands[1]!.bits, 0),
    ...commandAnnotations(commands[2]!.bits),
    ...ldacAnnotations(),
  ];
  yield {
    name: 'min-max-fields-and-ldac',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 29n,
    channels: { clk: 0, data: 2, load: 4, ldac: 6 },
    options: { vref_a: 3.3, vref_b: 3.3, vref_c: 3.3, vref_d: 3.3 },
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: commands,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: commands.reduce((sum, item) => sum + (item.bitCount ?? 11), 0),
      };
    },
  };

  const short: Tlc5620Command = { bits: 0b101, bitCount: 3 };
  const register = wordBits(3, 2, 1);
  yield {
    name: 'short-command-and-register',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { clk: 0, data: 2, load: 4 },
    options: { vref_a: 1.8, vref_b: 2.5, vref_c: 2.5, vref_d: 4.096 },
    chunkSamples: [2, 31, 257],
    minimumPayloadBits: 0,
    *generate() {
      const vrefs = [1.8, 2.5, 2.5, 4.096];
      const registerAnnotations = commandAnnotations(register, 1, vrefs);
      const data = [short, { bits: register }];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: [{ classIndex: 9, texts: ['Command too short'] }, ...registerAnnotations],
        annotationCount: 1 + registerAnnotations.length,
        payloadBits: 3 + 11,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 8192;
  const blocks = Math.ceil(required / (perBlock * 11));
  yield {
    name: 'seeded-long',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { clk: 0, data: 2, load: 4 },
    options: { vref_a: 3.3, vref_b: 3.3, vref_c: 3.3, vref_d: 3.3 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: Tlc5620Command[] = [];
        let last = 0;
        for (let index = 0; index < perBlock; index++) {
          last = random() & 0x7ff;
          data.push({ bits: last, load: index === perBlock - 1 });
        }
        const dac = DAC_NAMES[(last >> 9) & 3]!;
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: [
            {
              classIndex: 0,
              texts: [`DAC select: ${dac}`, `DAC sel: ${dac}`, `DAC: ${dac}`, `D: ${dac}`, dac, dac[3]],
            },
          ],
          annotationCount: 16,
          payloadBits: perBlock * 11,
        };
      }
    },
  };
}
