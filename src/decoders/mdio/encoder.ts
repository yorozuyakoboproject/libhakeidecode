import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { RoundtripCase, WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { MdioProtocolData } from './index.js';

export interface MdioRun {
  readonly mdc: 0 | 1;
  readonly mdio: 0 | 1;
  readonly samples: number;
}

export interface MdioCommand {
  readonly clause45: boolean;
  readonly opcode: number;
  readonly portAddress: number;
  readonly deviceAddress: number;
  readonly data: number;
}

export interface MdioTiming {
  readonly low: number;
  readonly high: number;
  readonly gap: number;
  readonly lead: number;
}

export interface MdioFramePlan {
  readonly ss: bigint;
  readonly es: bigint;
  readonly edges: readonly bigint[];
  readonly protocol: MdioProtocolData | null;
}

export interface MdioWaveformPlan {
  readonly runs: MdioRun[];
  readonly frames: MdioFramePlan[];
  readonly endSample: bigint;
}

export const MDIO_TIMING: MdioTiming = Object.freeze({ low: 2, high: 2, gap: 2, lead: 1 });

function appendBits(bits: number[], value: number, width: number): void {
  for (let shift = width - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1);
}

export function mdioCommandBits(command: MdioCommand): number[] {
  if (!Number.isInteger(command.opcode) || command.opcode < 0 || command.opcode > 3)
    throw new RangeError('MDIO opcode must be an integer from 0 through 3.');
  if (!Number.isInteger(command.portAddress) || command.portAddress < 0 || command.portAddress > 31)
    throw new RangeError('MDIO port address must be an integer from 0 through 31.');
  if (!Number.isInteger(command.deviceAddress) || command.deviceAddress < 0 || command.deviceAddress > 31)
    throw new RangeError('MDIO device address must be an integer from 0 through 31.');
  if (!Number.isInteger(command.data) || command.data < 0 || command.data > 0xffff)
    throw new RangeError('MDIO data must be an integer from 0 through 65535.');

  const bits: number[] = Array.from({ length: 32 }, () => 1);
  bits.push(...(command.clause45 ? [0, 0] : [0, 1]));
  if (command.clause45) bits.push((command.opcode >>> 1) & 1, command.opcode & 1);
  else bits.push(command.opcode === 0 ? 0 : 1, command.opcode === 0 ? 1 : 0);
  appendBits(bits, command.portAddress, 5);
  appendBits(bits, command.deviceAddress, 5);
  bits.push(command.clause45 ? (command.opcode < 2 ? 1 : 0) : command.opcode === 0 ? 1 : 0, 0);
  appendBits(bits, command.data, 16);
  return bits;
}

export function planMdioWaveform(
  commands: readonly MdioCommand[],
  startSample: bigint,
  timing: MdioTiming = MDIO_TIMING,
): MdioWaveformPlan {
  for (const [name, value] of Object.entries(timing))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`MDIO ${name} timing must be a positive integer.`);

  const runs: MdioRun[] = [];
  const frames: MdioFramePlan[] = [];
  const period = BigInt(timing.low + timing.high);
  let cursor = startSample;
  let clause45Address = -1;

  runs.push({ mdc: 0, mdio: 1, samples: timing.lead });
  cursor += BigInt(timing.lead);

  for (let frameIndex = 0; frameIndex < commands.length; frameIndex++) {
    if (frameIndex) {
      runs.push({ mdc: 0, mdio: 1, samples: timing.gap });
      cursor += BigInt(timing.gap);
    }

    const command = commands[frameIndex]!;
    const bits = mdioCommandBits(command);
    const edges: bigint[] = [];
    for (const bit of bits) {
      const mdio = bit as 0 | 1;
      runs.push({ mdc: 0, mdio, samples: timing.low });
      cursor += BigInt(timing.low);
      edges.push(cursor);
      runs.push({ mdc: 1, mdio, samples: timing.high });
      cursor += BigInt(timing.high);
    }

    let protocol: MdioProtocolData | null = null;
    if (command.clause45 && command.opcode === 0) clause45Address = command.data;
    else if (command.opcode > 0 || !command.clause45) {
      const read = command.clause45 ? command.opcode > 1 : command.opcode !== 0;
      protocol = [[command.clause45, clause45Address, read, command.portAddress, command.deviceAddress, command.data]];
    }
    if (command.clause45 && command.opcode === 2 && clause45Address !== -1) clause45Address++;

    frames.push({
      ss: edges[0]!,
      es: edges[edges.length - 1]! + period,
      edges,
      protocol,
    });
  }

  runs.push({ mdc: 0, mdio: 1, samples: timing.gap });
  cursor += BigInt(timing.gap);
  return { runs, frames, endSample: cursor };
}

export function createEncoder(config: RoundtripCase<MdioRun>): WaveformEncoder<MdioRun> {
  const writer = new PackedWaveformWriter(config);
  const mdcBit = config.channels.mdc;
  const mdioBit = config.channels.mdio;
  if (mdcBit === undefined || mdioBit === undefined)
    throw new Error('MDIO encoder requires the mdc and mdio channels.');
  if (mdcBit === mdioBit) throw new Error('MDIO channels must use different inputs.');
  let started = false;

  const write = function* (value: number, samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(value, samples);
  };

  return {
    *push(runs) {
      for (const run of runs) {
        if (!Number.isSafeInteger(run.samples) || run.samples < 1)
          throw new RangeError('MDIO run length must be a positive integer.');
        started = true;
        yield* write((run.mdc << mdcBit) | (run.mdio << mdioBit), run.samples);
      }
    },
    *finish() {
      if (!started) yield* write(1 << mdioBit, 2);
      yield* writer.finish();
    },
  };
}
