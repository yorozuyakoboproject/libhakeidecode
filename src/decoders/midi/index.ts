import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';
import {
  CONTROL_FUNCTIONS,
  DRUM_KIT,
  GM_INSTRUMENTS,
  PERCUSSION_NOTES,
  QUARTER_FRAME_TYPE,
  SMPTE_TYPE,
  STATUS_BYTES,
  SYSEX_MANUFACTURERS,
  noteName,
} from './tables.js';
import type { Pair, Triplet } from './tables.js';

type State =
  | 'IDLE'
  | 'HANDLE CHANNEL MSG'
  | 'HANDLE SYSEX MSG'
  | 'HANDLE SYSCOMMON MSG'
  | 'HANDLE SYSREALTIME MSG'
  | 'BUFFER GARBAGE MSG';

const hex = (value: number, digits = 2): string => value.toString(16).padStart(digits, '0');

export class MidiDecoder extends Decoder {
  static descriptor = descriptor;
  private state: State = 'IDLE';
  private statusByte = 0;
  private explicitStatusByte = false;
  private command: number[] = [];
  private ss: bigint | null = null;
  private es: bigint | null = null;
  private blockStart: bigint | null = null;
  private blockEnd: bigint | null = null;
  private outAnn = -1;

  override reset(): void {
    this.state = 'IDLE';
    this.statusByte = 0;
    this.explicitStatusByte = false;
    this.command = [];
    this.ss = null;
    this.es = null;
    this.blockStart = null;
    this.blockEnd = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putx(classIndex: number, texts: readonly string[]): void {
    if (this.blockStart === null || this.blockEnd === null) return;
    this.put(this.blockStart, this.blockEnd, this.outAnn, [classIndex, texts]);
  }

  private status(value: number): Triplet {
    return STATUS_BYTES.get(value) ?? ['undefined', 'undef', 'undef'];
  }

  private control(value: number): Triplet {
    return CONTROL_FUNCTIONS.get(value) ?? ['undefined', 'undef', 'undef'];
  }

  private instrument(value: number): string {
    return GM_INSTRUMENTS[value - 1] ?? 'undefined';
  }

  private getNoteName(channel: number, note: number): string {
    return channel === 10 ? `assuming ${PERCUSSION_NOTES.get(note) ?? 'undefined'}` : noteName(note);
  }

  private checkForGarbageFlush(flushed: boolean): void {
    if (!flushed) return;
    if (this.explicitStatusByte) {
      if (!this.command.length) {
        this.completeMessage();
        return;
      }
      this.command.unshift(this.statusByte);
    }
    this.handleGarbage(null);
  }

  private softClearStatusByte(): void {
    this.explicitStatusByte = false;
  }

  private hardClearStatusByte(): void {
    this.statusByte = 0;
    this.explicitStatusByte = false;
  }

  private setStatusByte(value: number): void {
    this.statusByte = value;
    this.explicitStatusByte = true;
  }

  private completeMessage(): void {
    this.command = [];
    this.state = 'IDLE';
    this.softClearStatusByte();
  }

  private handleChannelMsg0x80(flushed: boolean): void {
    if (this.command.length < 2) {
      this.checkForGarbageFlush(flushed);
      return;
    }
    this.blockEnd = this.es;
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      [note, velocity] = this.command,
      name = this.getNoteName(channel, note!),
      status = this.status(message);
    this.putx(0, [
      `Channel ${channel}: ${status[0]} (note = ${note} '${name}', velocity = ${velocity})`,
      `ch ${channel}: ${status[1]} ${note}, velocity = ${velocity}`,
      `${channel}: ${status[2]} ${note}, vel ${velocity}`,
    ]);
    this.completeMessage();
  }

  private handleChannelMsg0x90(flushed: boolean): void {
    if (this.command.length < 2) {
      this.checkForGarbageFlush(flushed);
      return;
    }
    this.blockEnd = this.es;
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      [note, velocity] = this.command,
      status = this.status(velocity === 0 ? 0x80 : message),
      name = this.getNoteName(channel, note!);
    this.putx(0, [
      `Channel ${channel}: ${status[0]} (note = ${note} '${name}', velocity = ${velocity})`,
      `ch ${channel}: ${status[1]} ${note}, velocity = ${velocity}`,
      `${channel}: ${status[2]} ${note}, vel ${velocity}`,
    ]);
    this.completeMessage();
  }

  private handleChannelMsg0xa0(flushed: boolean): void {
    if (this.command.length < 2) {
      this.checkForGarbageFlush(flushed);
      return;
    }
    this.blockEnd = this.es;
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      [note, pressure] = this.command,
      status = this.status(message),
      name = this.getNoteName(channel, note!);
    this.putx(0, [
      `Channel ${channel}: ${status[0]} of ${pressure} for note = ${note} '${name}'`,
      `ch ${channel}: ${status[1]} ${pressure} for note ${note}`,
      `${channel}: ${status[2]} ${pressure}, N ${note}`,
    ]);
    this.completeMessage();
  }

  private handleController0x44(): void {
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      value = this.command[1]!,
      legato = value <= 0x3f ? ['normal', 'no'] : ['legato', 'yes'],
      status = this.status(message),
      control = this.control(0x44);
    this.putx(0, [
      `Channel ${channel}: ${status[0]} '${control[0]}' = ${legato[0]}`,
      `ch ${channel}: ${status[1]} '${control[1]}' = ${legato[0]}`,
      `${channel}: ${status[2]} '${control[2]}' = ${legato[1]}`,
    ]);
  }

  private handleController0x54(): void {
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      note = this.command[1]!,
      name = this.getNoteName(channel, note),
      status = this.status(message),
      control = this.control(0x54);
    this.putx(0, [
      `Channel ${channel}: ${status[0]} '${control[0]}' (source note = ${note} / ${name})`,
      `ch ${channel}: ${status[1]} '${control[1]}' (source note = ${note})`,
      `${channel}: ${status[2]} '${control[2]}' (src N ${note})`,
    ]);
  }

  private handleControllerGeneric(): void {
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      [fn, parameter] = this.command,
      control =
        CONTROL_FUNCTIONS.get(fn!) ?? ([`undefined 0x${hex(fn!)}`, `undef 0x${hex(fn!)}`, `0x${hex(fn!)}`] as Triplet),
      status = this.status(message);
    this.putx(0, [
      `Channel ${channel}: ${status[0]} '${control[0]}' (param = 0x${hex(parameter!)})`,
      `ch ${channel}: ${status[1]} '${control[1]}' (param = 0x${hex(parameter!)})`,
      `${channel}: ${status[2]} '${control[2]}' is 0x${hex(parameter!)}`,
    ]);
  }

  private handleChannelMode(): void {
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      [mode, value] = this.command,
      modeFunction = CONTROL_FUNCTIONS.get(mode!) ?? (['undefined', 'undef', 'undef'] as Triplet),
      status = this.status(message);
    let description: Pair = ['', ''];
    if (mode === 122) {
      if (value === 0) description = ['off', 'off'];
      else if (value === 127) description = ['on', 'on'];
      else description = [`(non-standard param value of 0x${hex(value!)})`, `0x${hex(value!)}`];
    } else if (mode === 126) {
      description =
        value !== 0
          ? [`(${value} channels)`, `(${value} ch)`]
          : ["(channels 'basic' through 16)", "(ch 'basic' thru 16)"];
    } else if (value !== 0) {
      description = [`(non-standard param value of 0x${hex(value!)})`, `0x${hex(value!)}`];
    }
    this.putx(0, [
      `Channel ${channel}: ${status[0]} '${modeFunction[0]}' ${description[0]}`,
      `ch ${channel}: ${status[1]} '${modeFunction[1]}' ${description[1]}`,
      `${channel}: ${status[2]} '${modeFunction[2]}' ${description[1]}`,
    ]);
    this.completeMessage();
  }

  private handleChannelMsg0xb0(flushed: boolean): void {
    if (this.command.length < 2) {
      this.checkForGarbageFlush(flushed);
      return;
    }
    this.blockEnd = this.es;
    const control = this.command[0]!;
    if (control >= 0x78 && control <= 0x7f) {
      this.handleChannelMode();
      return;
    }
    if (control === 0x44) this.handleController0x44();
    else if (control === 0x54) this.handleController0x54();
    else this.handleControllerGeneric();
    this.completeMessage();
  }

  private handleChannelMsg0xc0(flushed: boolean): void {
    if (this.command.length < 1) {
      this.checkForGarbageFlush(flushed);
      return;
    }
    this.blockEnd = this.es;
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      program = this.command[0]! + 1,
      status = this.status(message);
    const changeType = channel === 10 ? 'drum kit' : 'instrument';
    const name = channel === 10 ? (DRUM_KIT[program] ?? 'undefined') : this.instrument(program);
    this.putx(0, [
      `Channel ${channel}: ${status[0]} to ${changeType} ${program} (assuming ${name})`,
      `ch ${channel}: ${status[1]} to ${changeType} ${program}`,
      `${channel}: ${status[2]} ${program}`,
    ]);
    this.completeMessage();
  }

  private handleChannelMsg0xd0(flushed: boolean): void {
    if (this.command.length < 1) {
      this.checkForGarbageFlush(flushed);
      return;
    }
    this.blockEnd = this.es;
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      value = this.command[0]!,
      status = this.status(message);
    this.putx(0, [
      `Channel ${channel}: ${status[0]} ${value}`,
      `ch ${channel}: ${status[1]} ${value}`,
      `${channel}: ${status[2]} ${value}`,
    ]);
    this.completeMessage();
  }

  private handleChannelMsg0xe0(flushed: boolean): void {
    if (this.command.length < 2) {
      this.checkForGarbageFlush(flushed);
      return;
    }
    this.blockEnd = this.es;
    const message = this.statusByte & 0xf0,
      channel = (this.statusByte & 0x0f) + 1,
      [low, high] = this.command,
      decimal = (high! << 7) + low!,
      status = this.status(message);
    this.putx(0, [
      `Channel ${channel}: ${status[0]} 0x${hex(low!)} 0x${hex(high!)} (${decimal})`,
      `ch ${channel}: ${status[1]} 0x${hex(low!)} 0x${hex(high!)} (${decimal})`,
      `${channel}: ${status[2]} (${decimal})`,
    ]);
    this.completeMessage();
  }

  private handleChannelMsgGeneric(): void {
    this.blockEnd = this.es;
    this.putx(2, [`Unknown channel message type: 0x${hex(this.statusByte & 0xf0)}`]);
    this.completeMessage();
  }

  private handleChannelMsg(newByte: number | null): void {
    if (newByte !== null) {
      if (newByte >= 0x80) this.setStatusByte(newByte);
      else this.command.push(newByte);
    }
    const message = this.statusByte & 0xf0;
    switch (message) {
      case 0x80:
        this.handleChannelMsg0x80(newByte === null);
        break;
      case 0x90:
        this.handleChannelMsg0x90(newByte === null);
        break;
      case 0xa0:
        this.handleChannelMsg0xa0(newByte === null);
        break;
      case 0xb0:
        this.handleChannelMsg0xb0(newByte === null);
        break;
      case 0xc0:
        this.handleChannelMsg0xc0(newByte === null);
        break;
      case 0xd0:
        this.handleChannelMsg0xd0(newByte === null);
        break;
      case 0xe0:
        this.handleChannelMsg0xe0(newByte === null);
        break;
      default:
        this.handleChannelMsgGeneric();
    }
  }

  private handleSysex(newByte: number | null): void {
    this.hardClearStatusByte();
    if (newByte !== 0xf7 && newByte !== null) {
      this.command.push(newByte);
      return;
    }
    this.blockEnd = this.es;
    const message = this.command.shift() ?? 0xf0;
    if (this.command.length < 1) {
      const status = this.status(message);
      this.putx(2, [
        `${status[0]}: truncated manufacturer code (<1 bytes)`,
        `${status[1]}: truncated manufacturer (<1 bytes)`,
        `${status[2]}: trunc. manu.`,
      ]);
      this.command = [];
      this.state = 'IDLE';
      return;
    }
    const first = this.command.shift()!,
      manufacturer = [first];
    if (first === 0) {
      if (this.command.length < 2) {
        const status = this.status(message);
        this.putx(2, [
          `${status[0]}: truncated manufacturer code (<3 bytes)`,
          `${status[1]}: truncated manufacturer (<3 bytes)`,
          `${status[2]}: trunc. manu.`,
        ]);
        this.command = [];
        this.state = 'IDLE';
        return;
      }
      manufacturer.push(this.command.shift()!, this.command.shift()!);
    }
    const key = manufacturer.map((value) => hex(value)).join(','),
      known = SYSEX_MANUFACTURERS.get(key);
    const manufacturerName: Pair = known
      ? [known, known]
      : manufacturer.length === 3
        ? [`undefined (0x${manufacturer.map((value) => hex(value)).join(' 0x')})`, 'undefined']
        : [`undefined (0x${hex(manufacturer[0]!)})`, 'undefined'];
    let payloadLong = '',
      payloadShort = '';
    while (this.command.length) {
      const value = this.command.shift()!;
      payloadLong += `0x${hex(value)} `;
      payloadShort += `${hex(value)} `;
    }
    if (!payloadLong) {
      payloadLong = '<empty>';
      payloadShort = '<>';
    }
    const status = this.status(message);
    this.putx(0, [
      `${status[0]}: for '${manufacturerName[0]}' with payload ${payloadLong}`,
      `${status[1]}: '${manufacturerName[1]}', payload ${payloadShort}`,
      `${status[2]}: '${manufacturerName[1]}', payload ${payloadShort}`,
    ]);
    this.command = [];
    this.state = 'IDLE';
  }

  private handleQuarterFrame(newByte: number | null): void {
    if (this.command.length < 2) {
      if (newByte === null) this.handleGarbage(null);
      return;
    }
    const message = this.command[0]!,
      value = this.command[1]!,
      type = (value & 0x70) >> 4,
      data = value & 0x0f,
      group: Triplet = ['System Common', 'SysCom', 'SC'],
      status = this.status(message),
      frame = QUARTER_FRAME_TYPE[type]!;
    this.blockEnd = this.es;
    if (type !== 7) {
      this.putx(0, [
        `${group[0]}: ${status[0]} of ${frame[0]}, value 0x${hex(data, 1)}`,
        `${group[1]}: ${status[1]} of ${frame[1]}, value 0x${hex(data, 1)}`,
        `${group[2]}: ${status[2]} of ${frame[1]}, value 0x${hex(data, 1)}`,
      ]);
    } else {
      const smpte = SMPTE_TYPE[(data & 0x6) >> 1]!;
      this.putx(0, [
        `${group[0]}: ${status[0]} of ${frame[0]}, value 0x${hex(data, 1)} for ${smpte}`,
        `${group[1]}: ${status[1]} of ${frame[1]}, value 0x${hex(data, 1)} for ${smpte}`,
        `${group[2]}: ${status[2]} of ${frame[1]}, value 0x${hex(data, 1)} for ${smpte}`,
      ]);
    }
    this.command = [];
    this.state = 'IDLE';
  }

  private handleSyscommon(newByte: number | null): void {
    this.hardClearStatusByte();
    if (newByte !== null) this.command.push(newByte);
    const message = this.command[0]!;
    const group: Triplet = ['System Common', 'SysCom', 'SC'];
    if (message === 0xf1) {
      this.handleQuarterFrame(newByte);
      return;
    }
    if (message === 0xf2) {
      if (this.command.length < 3) {
        if (newByte === null) this.handleGarbage(null);
        return;
      }
      const low = this.command[1]!,
        high = this.command[2]!,
        decimal = (high << 7) + low,
        status = this.status(message);
      this.blockEnd = this.es;
      this.putx(0, [
        `${group[0]}: ${status[0]} 0x${hex(low)} 0x${hex(high)} (${decimal})`,
        `${group[1]}: ${status[1]} 0x${hex(low)} 0x${hex(high)} (${decimal})`,
        `${group[2]}: ${status[2]} (${decimal})`,
      ]);
    } else if (message === 0xf3) {
      if (this.command.length < 2) {
        if (newByte === null) this.handleGarbage(null);
        return;
      }
      const song = this.command[1]!,
        status = this.status(message);
      this.blockEnd = this.es;
      this.putx(0, [
        `${group[0]}: ${status[0]} number ${song}`,
        `${group[1]}: ${status[1]} number ${song}`,
        `${group[2]}: ${status[2]} # ${song}`,
      ]);
    } else if (message === 0xf4 || message === 0xf5 || message === 0xf6) {
      const status = this.status(message);
      this.blockEnd = this.es;
      this.putx(0, [`${group[0]}: ${status[0]}`, `${group[1]}: ${status[1]}`, `${group[2]}: ${status[2]}`]);
    }
    this.command = [];
    this.state = 'IDLE';
  }

  private handleSysrealtime(newByte: number): void {
    const oldStart = this.blockStart,
      oldEnd = this.blockEnd;
    this.blockStart = this.ss;
    this.blockEnd = this.es;
    const status = this.status(newByte);
    this.putx(1, [`System Realtime: ${status[0]}`, `SysReal: ${status[1]}`, `SR: ${status[2]}`]);
    this.blockStart = oldStart;
    this.blockEnd = oldEnd;
  }

  private handleGarbage(newByte: number | null): void {
    this.blockEnd = this.es;
    if (newByte !== null) {
      this.command.push(newByte);
      return;
    }
    let payload = '<empty>';
    for (let index = 0; index < this.command.length; index++) {
      if (index === 16) {
        payload += ' ...';
        break;
      }
      payload = index === 0 ? `0x${hex(this.command[index]!)}` : `${payload} 0x${hex(this.command[index]!)}`;
    }
    this.putx(2, [`UNHANDLED DATA: ${payload}`, 'UNHANDLED', '???', '?']);
    this.command = [];
    this.state = 'IDLE';
    this.hardClearStatusByte();
  }

  private handleState(state: State, newByte: number | null): void {
    switch (state) {
      case 'HANDLE CHANNEL MSG':
        this.handleChannelMsg(newByte);
        break;
      case 'HANDLE SYSEX MSG':
        this.handleSysex(newByte);
        break;
      case 'HANDLE SYSCOMMON MSG':
        this.handleSyscommon(newByte);
        break;
      case 'HANDLE SYSREALTIME MSG':
        this.handleSysrealtime(newByte!);
        break;
      case 'BUFFER GARBAGE MSG':
        this.handleGarbage(newByte);
        break;
    }
  }

  private nextState(newByte: number): State {
    if (newByte >= 0x80 && newByte <= 0xef) return 'HANDLE CHANNEL MSG';
    if (newByte === 0xf0) return 'HANDLE SYSEX MSG';
    if (newByte >= 0xf1 && newByte <= 0xf6) return 'HANDLE SYSCOMMON MSG';
    if (newByte >= 0xf8) return 'HANDLE SYSREALTIME MSG';
    if (newByte === 0xf7) return 'BUFFER GARBAGE MSG';
    if (this.statusByte < 0x80) return 'BUFFER GARBAGE MSG';
    return this.nextState(this.statusByte);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const [packetType, , payload] = data as [string, number, [number, unknown]];
    if (packetType !== 'DATA') return;
    const value = payload[0];
    let state: State = 'IDLE';
    if (value >= 0x80 && value !== 0xf7) {
      state = this.nextState(value);
      if (state !== 'HANDLE SYSREALTIME MSG' && this.state !== 'IDLE') this.handleState(this.state, null);
      this.ss = ss;
      this.es = es;
      if (state !== 'HANDLE SYSREALTIME MSG') this.blockStart = ss;
    } else if (this.state === 'IDLE' || this.state === 'BUFFER GARBAGE MSG') {
      this.ss = ss;
      this.es = es;
      if (this.state === 'IDLE') this.blockStart = ss;
      state = this.nextState(value);
    } else {
      this.ss = ss;
      this.es = es;
      state = this.state;
    }
    if (state !== 'HANDLE SYSREALTIME MSG') this.state = state;
    if (state === 'BUFFER GARBAGE MSG') this.statusByte = 0;
    this.handleState(state, value);
  }
}

export default MidiDecoder;
