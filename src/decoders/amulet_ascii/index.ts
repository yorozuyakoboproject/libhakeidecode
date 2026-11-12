import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { AnnotationData, DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface AmuletOptions {
  ms_chan: 'RX' | 'TX';
  sm_chan: 'RX' | 'TX';
}

type UartData = readonly ['DATA', 0 | 1, readonly [value: number, bits: unknown]];

interface CommandInfo {
  readonly code: number;
  readonly id: string;
  readonly name: string;
}

const COMMANDS: readonly CommandInfo[] = [
  { code: 0xa0, id: 'PAGE', name: 'Jump to page' },
  { code: 0xd0, id: 'GBV', name: 'Get byte variable' },
  { code: 0xd1, id: 'GWV', name: 'Get word variable' },
  { code: 0xd2, id: 'GSV', name: 'Get string variable' },
  { code: 0xd3, id: 'GLV', name: 'Get label variable' },
  { code: 0xd4, id: 'GRPC', name: 'Get RPC buffer' },
  { code: 0xd5, id: 'SBV', name: 'Set byte variable' },
  { code: 0xd6, id: 'SWV', name: 'Set word variable' },
  { code: 0xd7, id: 'SSV', name: 'Set string variable' },
  { code: 0xd8, id: 'RPC', name: 'Invoke RPC' },
  { code: 0xd9, id: 'LINE', name: 'Draw line' },
  { code: 0xda, id: 'RECT', name: 'Draw rectangle' },
  { code: 0xdb, id: 'FRECT', name: 'Draw filled rectangle' },
  { code: 0xdc, id: 'PIXEL', name: 'Draw pixel' },
  { code: 0xdd, id: 'GBVA', name: 'Get byte variable array' },
  { code: 0xde, id: 'GWVA', name: 'Get word variable array' },
  { code: 0xdf, id: 'SBVA', name: 'Set byte variable array' },
  { code: 0xe0, id: 'GBVR', name: 'Get byte variable reply' },
  { code: 0xe1, id: 'GWVR', name: 'Get word variable reply' },
  { code: 0xe2, id: 'GSVR', name: 'Get string variable reply' },
  { code: 0xe3, id: 'GLVR', name: 'Get label variable reply' },
  { code: 0xe4, id: 'GRPCR', name: 'Get RPC buffer reply' },
  { code: 0xe5, id: 'SBVR', name: 'Set byte variable reply' },
  { code: 0xe6, id: 'SWVR', name: 'Set word variable reply' },
  { code: 0xe7, id: 'SSVR', name: 'Set string variable reply' },
  { code: 0xe8, id: 'RPCR', name: 'Invoke RPC reply' },
  { code: 0xe9, id: 'LINER', name: 'Draw line reply' },
  { code: 0xea, id: 'RECTR', name: 'Draw rectangle' },
  { code: 0xeb, id: 'FRECTR', name: 'Draw filled rectangle reply' },
  { code: 0xec, id: 'PIXELR', name: 'Draw pixel reply' },
  { code: 0xed, id: 'GBVAR', name: 'Get byte variable array reply' },
  { code: 0xee, id: 'GWVAR', name: 'Get word variable array reply' },
  { code: 0xef, id: 'SBVAR', name: 'Set byte variable array reply' },
  { code: 0xf0, id: 'ACK', name: 'Acknowledgment' },
  { code: 0xf1, id: 'NACK', name: 'Negative acknowledgment' },
  { code: 0xf2, id: 'SWVA', name: 'Set word variable array' },
  { code: 0xf3, id: 'SWVAR', name: 'Set word variable array reply' },
  { code: 0xf4, id: 'GCV', name: 'Get color variable' },
  { code: 0xf5, id: 'GCVR', name: 'Get color variable reply' },
  { code: 0xf6, id: 'SCV', name: 'Set color variable' },
  { code: 0xf7, id: 'SCVR', name: 'Set color variable reply' },
];

const HIGH_BYTE_COMMANDS = new Set([0xa0, 0xd7, 0xe2, 0xe3, 0xe7]);
const COMMAND_INDEX = new Map(COMMANDS.map((command, index) => [command.code, index]));
const COMMAND_BY_CODE = new Map(COMMANDS.map((command) => [command.code, command]));
const FIELD = 42;
const BIT = 41;
const WARNING = 43;

export class AmuletAsciiDecoder extends Decoder<AmuletOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private state: number | null = null;
  private cmdstate = 0;
  private ss = 0n;
  private es = 0n;
  private ssCmd = 0n;
  private esCmd = 0n;
  private ssField = 0n;
  private esField = 0n;
  private addr = 0;
  private checksum = 0;
  private page: [number, number] = [0, 0];
  private value: number | string = 0;
  private flags = 0;
  private coords: [number, number, number, number] = [0, 0, 0, 0];

  private readonly handlers: Readonly<Record<number, (value: number) => void>> = {
    0xa0: (value) => this.handlePage(value),
    0xd0: (value) => this.handleRead(value, 1),
    0xd1: (value) => this.handleRead(value, 2),
    0xd2: (value) => this.handleRead(value, 3),
    0xd3: (value) => this.handleRead(value, 4),
    0xd4: (value) => this.handleGrpc(value),
    0xd5: (value) => this.handleSbv(value, 6),
    0xd6: (value) => this.handleSwv(value, 7),
    0xd7: (value) => this.handleString(value, 8),
    0xd8: (value) => this.handleRead(value, 9),
    0xd9: (value) => this.handleDrawing(value, 10, 'Line pattern / Color not implemented'),
    0xda: (value) => this.handleDrawing(value, 11, 'Line pattern / Color not implemented'),
    0xdb: (value) => this.handleDrawing(value, 12, 'Fill pattern / Color not implemented'),
    0xdc: (value) => this.handlePixel(value),
    0xdd: (value) => this.handleRead(value, 14),
    0xde: (value) => this.handleRead(value, 15),
    0xdf: (value) => this.handleByteArray(value, 16),
    0xe0: (value) => this.handleByteReply(value),
    0xe1: (value) => this.handleWordReply(value),
    0xe2: (value) => this.handleString(value, 19),
    0xe3: (value) => this.handleString(value, 20),
    0xe4: (value) => this.handleGrpcr(value),
    0xe5: (value) => this.handleSbv(value, 22),
    0xe6: (value) => this.handleSwv(value, 23),
    0xe7: (value) => this.handleString(value, 24),
    0xe8: (value) => this.handleRead(value, 25),
    0xe9: (value) => this.handleDrawing(value, 26, 'Line pattern / Color not implemented'),
    0xea: (value) => this.handleDrawing(value, 27, 'Line pattern / Color not implemented'),
    0xeb: (value) => this.handleDrawing(value, 28, 'Fill pattern / Color not implemented'),
    0xec: (value) => this.handlePixel(value),
    0xed: (value) => this.handleByteArray(value, 30),
    0xee: (value) => this.handleWordArray(value, 31),
    0xef: (value) => this.handleByteArray(value, 32),
    0xf0: (value) => this.handleAck(value, 33),
    0xf1: (value) => this.handleAck(value, 34),
    0xf2: (value) => this.handleWordArray(value, 35),
    0xf3: (value) => this.handleWordArray(value, 36),
    0xf4: (value) => this.handleColor(value, 37),
    0xf5: (value) => this.handleColor(value, 38),
    0xf6: (value) => this.handleColor(value, 39),
    0xf7: (value) => this.handleColor(value, 40),
  };

  constructor(options: Partial<AmuletOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = null;
    this.cmdstate = 0;
    this.ss = 0n;
    this.es = 0n;
    this.ssCmd = 0n;
    this.esCmd = 0n;
    this.ssField = 0n;
    this.esField = 0n;
    this.addr = 0;
    this.checksum = 0;
    this.page = [0, 0];
    this.value = 0;
    this.flags = 0;
    this.coords = [0, 0, 0, 0];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putx(data: AnnotationData): void {
    this.put(this.ss, this.es, this.outAnn, data);
  }

  private putf(data: AnnotationData): void {
    this.put(this.ssField, this.esField, this.outAnn, data);
  }

  private putc(data: AnnotationData): void {
    this.put(this.ssCmd, this.esCmd, this.outAnn, data);
  }

  private commandInfo(): CommandInfo {
    const command = this.state === null ? undefined : COMMAND_BY_CODE.get(this.state);
    if (!command) throw new Error('No active Amulet command');
    return command;
  }

  private commandTexts(): string[] {
    const { id, name } = this.commandInfo();
    return [`Command: ${name} (${id})`, `Command: ${name}`, `Cmd: ${name}`, `Cmd: ${id}`, id];
  }

  private emitCommandByte(): void {
    this.ssCmd = this.ss;
    this.esCmd = this.es;
    this.putx([FIELD, this.commandTexts()]);
  }

  private emitCommandEnd(
    classIndex = this.state === null ? WARNING : (COMMAND_INDEX.get(this.state) ?? WARNING),
  ): void {
    this.esCmd = this.es;
    this.putc([classIndex, this.commandTexts()]);
    this.state = null;
    this.cmdstate = 0;
  }

  private warn(texts: readonly string[]): void {
    this.putx([WARNING, texts]);
  }

  private nibble(value: number): number {
    const character = String.fromCharCode(value);
    if (/^[0-9a-fA-F]$/.test(character)) return Number.parseInt(character, 16);
    this.warn([`Invalid hex digit: 0x${value.toString(16).padStart(2, '0')}`, 'Invalid hex']);
    return 0;
  }

  private emitAddrBytes(value: number): void {
    const character = String.fromCharCode(value);
    if (this.cmdstate === 2) {
      this.ssField = this.ss;
      this.esField = this.es;
      this.addr = this.nibble(value) << 4;
      this.putx([BIT, [`Address high nibble: ${character}`, `Addr high 0x${character}`, `Addr h 0x${character}`]]);
    } else if (this.cmdstate === 3) {
      this.esField = this.es;
      this.addr |= this.nibble(value);
      this.putx([BIT, [`Address low nibble: ${character}`, `Addr low 0x${character}`, `Addr l 0x${character}`]]);
      const address = this.addr.toString(16).padStart(2, '0').toUpperCase();
      this.putf([FIELD, [`Address: 0x${address}`, `Addr: 0x${address}`, `0x${address}`]]);
    }
  }

  private handleRead(value: number, classIndex: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    this.emitAddrBytes(value);
    if (this.cmdstate === 3) this.emitCommandEnd(classIndex);
    else this.cmdstate++;
  }

  private handlePage(value: number): void {
    if (this.cmdstate === 1) {
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2) {
      if (value !== 0x02) {
        this.warn(['Illegal second byte for page change', 'Illegal byte']);
        this.state = null;
        this.cmdstate = 0;
        return;
      }
      this.ssField = this.ssCmd;
      this.esField = this.es;
      this.putf([FIELD, this.commandTexts()]);
      this.checksum = 0xa2;
      this.cmdstate = 3;
      return;
    }
    if (this.cmdstate === 3) {
      this.ssField = this.ss;
      this.checksum = (this.checksum + value) & 0xff;
      this.page[0] = value;
    } else if (this.cmdstate === 4) {
      this.checksum = (this.checksum + value) & 0xff;
      this.page[1] = value;
      this.esField = this.es;
      if (this.page[0] === 0xff && this.page[1] === 0xff) {
        this.putf([WARNING, ['Soft reset', 'Reset']]);
      } else {
        const page = String.fromCharCode(this.page[0], this.page[1]);
        this.putf([FIELD, [`Page index: 0x${page}`, `Page: 0x${page}`, `0x${page}`]]);
      }
    } else if (this.cmdstate === 5) {
      this.checksum = (this.checksum + value) & 0xff;
      this.putx(this.checksum === 0 ? [FIELD, ['Checksum OK', 'OK']] : [WARNING, ['Checksum error', 'Error', 'ERR']]);
      this.emitCommandEnd(0);
      return;
    }
    this.cmdstate++;
  }

  private handleSbv(value: number, classIndex: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2 || this.cmdstate === 3) {
      this.emitAddrBytes(value);
      this.cmdstate++;
      return;
    }
    if (this.cmdstate === 4) {
      this.ssField = this.ss;
      this.value = this.nibble(value) << 4;
      this.cmdstate = 5;
      return;
    }
    this.value = (Number(this.value) | this.nibble(value)) & 0xff;
    this.esField = this.es;
    const text = Number(this.value).toString(16).padStart(2, '0').toUpperCase();
    this.putf([FIELD, [`Value: 0x${text}`, `Val: 0x${text}`, `0x${text}`]]);
    this.emitCommandEnd(classIndex);
  }

  private handleSwv(value: number, classIndex: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2 || this.cmdstate === 3) {
      this.emitAddrBytes(value);
      this.cmdstate++;
      return;
    }
    if (this.cmdstate === 4) {
      this.ssField = this.ss;
      this.value = 0;
    }
    const shift = 12 - (this.cmdstate - 4) * 4;
    this.value = Number(this.value) | (this.nibble(value) << shift);
    if (this.cmdstate === 7) {
      this.esField = this.es;
      const text = Number(this.value).toString(16).padStart(4, '0');
      this.putf([FIELD, [`Value: 0x${text}`, `Val: 0x${text}`, `0x${text}`]]);
      this.emitCommandEnd(classIndex);
      return;
    }
    this.cmdstate++;
  }

  private handleString(value: number, classIndex: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2 || this.cmdstate === 3) {
      this.emitAddrBytes(value);
      this.cmdstate++;
      return;
    }
    if (this.cmdstate === 4) {
      this.ssField = this.ss;
      this.value = '';
    }
    if (value === 0) {
      this.esField = this.es;
      this.putx([BIT, ['NULL']]);
      this.putf([FIELD, [`Value: ${this.value}`, `Val: ${this.value}`, `${this.value}`]]);
      this.emitCommandEnd(classIndex);
      return;
    }
    this.value = String(this.value) + String.fromCharCode(value);
    this.putx([BIT, [String.fromCharCode(value)]]);
    this.cmdstate++;
  }

  private handleGrpc(value: number): void {
    if (this.cmdstate === 1) {
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2) {
      this.ssField = this.ss;
      this.esField = this.es;
      this.flags = this.nibble(value) << 4;
      this.cmdstate = 3;
      return;
    }
    this.flags |= this.nibble(value);
    this.esField = this.es;
    this.putf([FIELD, [`RPC flag: 0x${this.flags.toString(16).padStart(2, '0').toUpperCase()}`]]);
    this.emitCommandEnd(5);
  }

  private handleByteArray(value: number, classIndex: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2 || this.cmdstate === 3) {
      this.emitAddrBytes(value);
      this.cmdstate++;
      return;
    }
    if ((this.cmdstate & 1) === 0) {
      if (value === 0) {
        this.esCmd = this.es;
        this.putc([classIndex, this.commandTexts()]);
        this.state = null;
        this.cmdstate = 0;
        return;
      }
      this.ssField = this.ss;
      this.value = this.nibble(value) << 4;
    } else {
      this.value = (Number(this.value) | this.nibble(value)) & 0xff;
      this.esField = this.es;
      const text = Number(this.value).toString(16).padStart(2, '0').toUpperCase();
      this.putf([FIELD, [`Value 0x${text}`, `0x${text}`]]);
    }
    this.cmdstate++;
  }

  private handleWordArray(value: number, classIndex: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2 || this.cmdstate === 3) {
      this.emitAddrBytes(value);
      this.cmdstate++;
      return;
    }
    const nibbleIndex = (this.cmdstate - 4) % 4;
    if (nibbleIndex === 0) {
      if (value === 0) {
        this.esCmd = this.es;
        this.putc([classIndex, this.commandTexts()]);
        this.state = null;
        this.cmdstate = 0;
        return;
      }
      this.ssField = this.ss;
      this.value = 0;
    }
    this.value = Number(this.value) | (this.nibble(value) << (12 - nibbleIndex * 4));
    if (nibbleIndex === 3) {
      this.esField = this.es;
      const text = Number(this.value).toString(16).padStart(4, '0').toUpperCase();
      this.putf([FIELD, [`Value 0x${text}`, `0x${text}`]]);
    }
    this.cmdstate++;
  }

  private handleByteReply(value: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2 || this.cmdstate === 3) {
      this.emitAddrBytes(value);
      this.cmdstate++;
      return;
    }
    const character = String.fromCharCode(value);
    if (this.cmdstate === 4) {
      this.ssField = this.ss;
      this.value = this.nibble(value) << 4;
      this.putx([BIT, [`High nibble 0x${character}`, `0x${character}`]]);
      this.cmdstate = 5;
      return;
    }
    this.value = (Number(this.value) | this.nibble(value)) & 0xff;
    this.esField = this.es;
    this.putx([BIT, [`Low nibble 0x${character}`, `0x${character}`]]);
    const text = Number(this.value).toString(16).padStart(2, '0').toUpperCase();
    this.putf([FIELD, [`Value: 0x${text}`, `0x${text}`]]);
    this.emitCommandEnd(17);
  }

  private handleWordReply(value: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2 || this.cmdstate === 3) {
      this.emitAddrBytes(value);
      this.cmdstate++;
      return;
    }
    const nibbleIndex = this.cmdstate - 4;
    if (nibbleIndex === 0) {
      this.ssField = this.ss;
      this.value = 0;
    }
    this.value = Number(this.value) | (this.nibble(value) << (12 - nibbleIndex * 4));
    this.putx([BIT, [`0x${String.fromCharCode(value)}`]]);
    if (nibbleIndex === 3) {
      this.esField = this.es;
      const text = Number(this.value).toString(16).padStart(4, '0');
      this.putf([FIELD, [`Value: 0x${text}`, `0x${text.toUpperCase()}`]]);
      this.emitCommandEnd(18);
      return;
    }
    this.cmdstate++;
  }

  private handleGrpcr(value: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2 || this.cmdstate === 3) {
      this.emitAddrBytes(value);
      this.cmdstate++;
      return;
    }
    if ((this.cmdstate & 1) === 0) {
      if (value === 0) {
        this.esCmd = this.es;
        this.putc([21, this.commandTexts()]);
        this.state = null;
        this.cmdstate = 0;
        return;
      }
      this.ssField = this.ss;
      this.value = this.nibble(value) << 4;
      this.putx([BIT, [`0x${String.fromCharCode(value)}`]]);
    } else {
      this.value = (Number(this.value) | this.nibble(value)) & 0xff;
      this.esField = this.es;
      this.putx([BIT, [`0x${String.fromCharCode(value)}`]]);
      const text = Number(this.value).toString(16).padStart(2, '0').toUpperCase();
      this.putf([FIELD, [`0x${text}`]]);
    }
    this.cmdstate++;
  }

  private handleDrawing(value: number, classIndex: number, warning: string): void {
    if (this.cmdstate === 1) {
      this.coords = [0, 0, 0, 0];
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate >= 2 && this.cmdstate <= 17) {
      const coordinate = Math.floor((this.cmdstate - 2) / 4);
      const nibbleIndex = (this.cmdstate - 2) % 4;
      if (nibbleIndex === 0) this.ssField = this.ss;
      this.coords[coordinate] = (this.coords[coordinate]! | (this.nibble(value) << (12 - nibbleIndex * 4))) & 0xffff;
      if (nibbleIndex === 3) {
        this.esField = this.es;
        const text = this.coords[coordinate]!.toString(16).padStart(4, '0').toUpperCase();
        this.putf([FIELD, [`Coordinate 0x${text}`, `0x${text}`]]);
      }
    } else if (this.cmdstate === 19) {
      this.esCmd = this.es;
      this.putc([classIndex, this.commandTexts()]);
      this.putc([WARNING, [warning]]);
      this.state = null;
      this.cmdstate = 0;
      return;
    }
    this.cmdstate++;
  }

  private handlePixel(_value: number): void {
    this.esCmd = this.es;
    this.putc([WARNING, ['Draw pixel documentation is missing.', 'Undocumented']]);
    this.state = null;
    this.cmdstate = 0;
  }

  private handleColor(value: number, classIndex: number): void {
    if (this.cmdstate === 1) {
      this.addr = 0;
      this.cmdstate = 2;
      return;
    }
    if (this.cmdstate === 2 || this.cmdstate === 3) {
      this.emitAddrBytes(value);
      this.cmdstate++;
      return;
    }
    if (this.cmdstate === 8) {
      this.esCmd = this.es;
      this.putc([WARNING, ['Command not decoded', 'Not decoded']]);
      this.emitCommandEnd(classIndex);
      return;
    }
    this.cmdstate++;
  }

  private handleAck(_value: number, classIndex: number): void {
    this.esCmd = this.es;
    this.putc([classIndex, this.commandTexts()]);
    this.state = null;
    this.cmdstate = 0;
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const [packetType, , payload] = data as UartData;
    if (packetType !== 'DATA') return;
    this.ss = ss;
    this.es = es;
    const value = payload[0];
    const abortCurrent = value >= 0xd0 && value <= 0xf7 && this.state !== null && !HIGH_BYTE_COMMANDS.has(this.state);
    if (abortCurrent) {
      this.warn(['Command aborted by invalid byte', 'Abort']);
      this.state = value;
      this.cmdstate = 1;
      this.emitCommandByte();
    } else if (this.state === null) {
      if (!COMMAND_BY_CODE.has(value)) {
        this.warn([`Unknown command: 0x${value.toString(16).padStart(2, '0')}`]);
        return;
      }
      this.state = value;
      this.cmdstate = 1;
      this.emitCommandByte();
    }
    const handler = this.state === null ? undefined : this.handlers[this.state];
    if (!handler) {
      if (this.state !== null) this.warn([`Unknown command: 0x${this.state.toString(16).padStart(2, '0')}`]);
      this.state = null;
      this.cmdstate = 0;
      return;
    }
    handler(value);
  }
}

export default AmuletAsciiDecoder;
