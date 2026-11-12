import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

type Direction = 0 | 1;
type Track = { command: string; start: bigint | null };
const RX = 0,
  TX = 1;

export class Pan1321Decoder extends Decoder {
  static descriptor = descriptor;
  private tracks: [Track, Track] = [
    { command: '', start: null },
    { command: '', start: null },
  ];
  private outAnn = -1;

  override reset(): void {
    this.tracks = [
      { command: '', start: null },
      { command: '', start: null },
    ];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private annotate(start: bigint, end: bigint, classIndex: number, text: string): void {
    this.put(start, end, this.outAnn, [classIndex, [text]]);
  }

  private handleHostCommand(command: string, start: bigint, end: bigint): void {
    if (command.startsWith('AT+JAAC')) {
      const parameter = command.slice(command.indexOf('=') + 1);
      if (parameter !== '0' && parameter !== '1') {
        this.annotate(start, end, 2, `Warning: Invalid JAAC parameter "${parameter}"`);
        return;
      }
      const action = parameter === '1' ? 'Auto' : "Don't auto";
      this.annotate(start, end, 0, `${action}-accept new connections`);
      this.annotate(start, end, 1, `${action}-accept connections`);
    } else if (command.startsWith('AT+JPRO')) {
      const parameter = command.slice(command.indexOf('=') + 1);
      if (parameter !== '0' && parameter !== '1') {
        this.annotate(start, end, 2, `Warning: Invalid JPRO parameter "${parameter}"`);
        return;
      }
      const onoff = parameter === '0' ? 'off' : 'on';
      const action = parameter === '0' ? 'Leaving' : 'Entering';
      this.annotate(start, end, 0, `${action} production mode`);
      this.annotate(start, end, 1, `Production mode = ${onoff}`);
    } else if (command.startsWith('AT+JRES')) {
      if (command !== 'AT+JRES') {
        this.annotate(start, end, 2, 'Warning: Invalid JRES usage.');
        return;
      }
      this.annotate(start, end, 0, 'Triggering a software reset');
      this.annotate(start, end, 1, 'Reset');
    } else if (command.startsWith('AT+JSDA')) {
      const [lengthText, data] = command.slice(command.indexOf('=') + 1).split(',');
      const length = Number(lengthText);
      if (!/^\d+$/.test(lengthText ?? ''))
        this.annotate(start, end, 2, `Warning: Invalid data length "${lengthText}".`);
      if (length !== data?.length)
        this.annotate(start, end, 2, `Warning: Data length mismatch (${length} != ${data?.length}).`);
      const hex = Array.from(data ?? '', (character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join(
        ' ',
      );
      this.annotate(start, end, 0, `Sending ${length} data bytes: ${hex}`);
      this.annotate(start, end, 1, `Send ${length} = ${hex}`);
    } else if (command.startsWith('AT+JSEC')) {
      const pin = command.slice(-4);
      this.annotate(start, end, 0, `Host set the Bluetooth PIN to "${pin}"`);
      this.annotate(start, end, 1, `PIN = ${pin}`);
    } else if (command.startsWith('AT+JSLN')) {
      const name = command.slice(command.indexOf(',') + 1);
      this.annotate(start, end, 0, `Host set the Bluetooth name to "${name}"`);
      this.annotate(start, end, 1, `BT name = ${name}`);
    } else {
      this.annotate(start, end, 0, `Host sent unsupported command: ${command}`);
      this.annotate(start, end, 1, `Unsupported command: ${command}`);
    }
  }

  private handleDeviceReply(start: bigint, end: bigint, reply: string): void {
    if (reply === 'ROK') {
      this.annotate(start, end, 0, 'Device initialized correctly');
      this.annotate(start, end, 1, 'Init');
    } else if (reply === 'OK') {
      this.annotate(start, end, 0, 'Device acknowledged last command');
      this.annotate(start, end, 1, 'ACK');
    } else if (reply.startsWith('ERR')) {
      const error = reply.slice(reply.indexOf('=') + 1);
      this.annotate(start, end, 0, `Device sent error code ${error}`);
      this.annotate(start, end, 1, `ERR = ${error}`);
    } else {
      this.annotate(start, end, 0, `Device sent an unknown reply: ${reply}`);
      this.annotate(start, end, 1, `Unknown reply: ${reply}`);
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const [packetType, direction, payload] = data as [string, Direction, [number, unknown]];
    if (packetType !== 'DATA') return;
    const track = this.tracks[direction];
    if (!track.command) track.start = ss;
    track.command += String.fromCharCode(payload[0]);
    if (!track.command.endsWith('\r\n')) return;
    const command = track.command.slice(0, -2);
    const start = track.start ?? ss;
    track.command = '';
    track.start = null;
    if (direction === RX) this.handleDeviceReply(start, es, command);
    else if (direction === TX) this.handleHostCommand(command, start, es);
  }
}

export default Pan1321Decoder;
