import { descriptor } from './descriptor.js';
import {
  Decoder,
  OUTPUT_ANN,
  OUTPUT_BINARY,
  OUTPUT_PROTOCOL,
  SRD_CONF_SAMPLERATE,
} from '../../libhakeidecode/index.js';
import type {
  AnnotationData,
  BinaryData,
  DecoderContext,
  LogicGenerator,
  WaitCondition,
} from '../../libhakeidecode/index.js';
export type UARTDirection = 0 | 1;
export type UARTSignal = number | boolean;
export type UARTDataBit = [signal: UARTSignal, ss: bigint, es: bigint];
export interface UARTOptions {
  baudrate: number;
  data_bits: number;

  parity: string;
  stop_bits: number;
  bit_order: string;
  format: string;
  invert_rx: string;
  invert_tx: string;
  sample_point: number;
  rx_packet_delim: number;
  tx_packet_delim: number;
  rx_packet_len: number;
  tx_packet_len: number;
}
export type UARTProtocolPacket =
  | [kind: 'DATA', direction: UARTDirection, payload: [value: number, bits: UARTDataBit[]]]
  | [kind: 'FRAME', direction: UARTDirection, payload: [value: number, valid: boolean | null]]
  | [
      kind: 'STARTBIT' | 'PARITYBIT' | 'STOPBIT' | 'INVALID STARTBIT' | 'INVALID STOPBIT',
      direction: UARTDirection,
      signal: UARTSignal,
    ]
  | [kind: 'PARITY ERROR', direction: UARTDirection, payload: [number, number]]
  | [kind: 'BREAK' | 'IDLE', direction: UARTDirection, payload: 0];
type Pair<T> = [T, T];
type FrameState = 'WAIT FOR START BIT' | 'GET START BIT' | 'GET DATA BITS' | 'GET PARITY BIT' | 'GET STOP BITS';
const RX = 0,
  TX = 1;
export const UART_ANN = Object.freeze({
  RX_DATA: 0,
  TX_DATA: 1,
  RX_START: 2,
  TX_START: 3,
  RX_PARITY_OK: 4,
  TX_PARITY_OK: 5,
  RX_PARITY_ERR: 6,
  TX_PARITY_ERR: 7,
  RX_STOP: 8,
  TX_STOP: 9,
  RX_WARN: 10,
  TX_WARN: 11,
  RX_DATA_BIT: 12,
  TX_DATA_BIT: 13,
  RX_BREAK: 14,
  TX_BREAK: 15,
  RX_PACKET: 16,
  TX_PACKET: 17,
});
function parityOk(type: UARTOptions['parity'], parity: UARTSignal, data: number): boolean {
  if (type === 'ignore') return true;
  if (type === 'zero') return Number(parity) === 0;
  if (type === 'one') return Number(parity) === 1;
  const ones =
    data
      .toString(2)
      .split('')
      .filter((bit) => bit === '1').length + Number(parity);
  if (type === 'odd') return ones % 2 === 1;
  if (type === 'even') return ones % 2 === 0;
  return false;
}
function pair<T>(value: T): Pair<T> {
  return [structuredClone(value), structuredClone(value)];
}

export class UARTDecoder extends Decoder<UARTOptions> {
  samplerate!: number | null;
  bit_width!: number | null;
  frame_start!: Pair<bigint>;
  frame_valid!: Pair<boolean | null>;
  cur_frame_bit!: Pair<number | null>;
  startbit!: Pair<UARTSignal>;
  cur_data_bit!: Pair<number>;
  datavalue!: Pair<number>;
  paritybit!: Pair<UARTSignal>;
  stopbits!: Pair<UARTSignal[]>;
  startsample!: Pair<bigint>;
  state!: Pair<FrameState>;
  databits!: Pair<UARTDataBit[]>;
  break_start!: Pair<bigint | null>;
  packet_cache!: Pair<number[]>;
  ss_packet!: Pair<bigint | null>;
  es_packet!: Pair<bigint | null>;
  idle_start!: Pair<bigint | null>;
  out_python!: number;
  out_binary!: number;
  out_ann!: number;
  bw!: number;
  frame_len_sample_count!: number;
  break_min_sample_count!: number;
  static descriptor = descriptor;
  constructor(options: Partial<UARTOptions> = {}) {
    super(options);
    this.reset();
  }
  reset() {
    this.samplerate = null;
    this.bit_width = null;
    this.frame_start = pair(-1n);
    this.frame_valid = pair(null);
    this.cur_frame_bit = pair(null);
    this.startbit = pair(-1);
    this.cur_data_bit = pair(0);
    this.datavalue = pair(0);
    this.paritybit = pair(-1);
    this.stopbits = pair([]);
    this.startsample = pair(-1n);
    this.state = pair('WAIT FOR START BIT');
    this.databits = pair([]);
    this.break_start = pair(null);
    this.packet_cache = pair([]);
    this.ss_packet = pair(null);
    this.es_packet = pair(null);
    this.idle_start = pair(null);
  }
  start(ctx: DecoderContext): void {
    super.start(ctx);
    this.out_python = this.register(OUTPUT_PROTOCOL);
    this.out_binary = this.register(OUTPUT_BINARY);
    this.out_ann = this.register(OUTPUT_ANN);
    this.bw = Math.floor((this.options.data_bits + 7) / 8);
    if (
      !(this.options.baudrate > 0) ||
      !Number.isInteger(this.options.data_bits) ||
      this.options.data_bits < 1 ||
      this.options.data_bits > 32
    )
      throw new Error('Invalid baudrate or data_bits.');
  }
  metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) {
      this.samplerate = value;
      this.bit_width = value / this.options.baudrate;
    }
  }
  private clampStart(ss: bigint): bigint {
    return ss < 0n ? 0n : ss;
  }
  putx(rxtx: UARTDirection, data: AnnotationData): void {
    this.put(
      this.clampStart(this.startsample[rxtx] - BigInt(Math.floor(this.bit_width! / 2))),
      this.samplenum + BigInt(Math.ceil(this.bit_width! / 2)),
      this.out_ann,
      data,
    );
  }
  putx_packet(rxtx: UARTDirection, data: AnnotationData): void {
    this.put(
      this.clampStart(this.ss_packet[rxtx]! - BigInt(Math.floor(this.bit_width! / 2))),
      this.samplenum + BigInt(Math.ceil(this.bit_width! / 2)),
      this.out_ann,
      data,
    );
  }
  putpx(rxtx: UARTDirection, data: UARTProtocolPacket): void {
    this.put(
      this.clampStart(this.startsample[rxtx] - BigInt(Math.floor(this.bit_width! / 2))),
      this.samplenum + BigInt(Math.ceil(this.bit_width! / 2)),
      this.out_python,
      data,
    );
  }
  putg(data: AnnotationData): void {
    this.put(
      this.clampStart(this.samplenum - BigInt(Math.floor(this.bit_width! / 2))),
      this.samplenum + BigInt(Math.ceil(this.bit_width! / 2)),
      this.out_ann,
      data,
    );
  }
  putp(data: UARTProtocolPacket): void {
    this.put(
      this.clampStart(this.samplenum - BigInt(Math.floor(this.bit_width! / 2))),
      this.samplenum + BigInt(Math.ceil(this.bit_width! / 2)),
      this.out_python,
      data,
    );
  }
  putgse(ss: bigint, es: bigint, data: AnnotationData): void {
    this.put(this.clampStart(ss), es, this.out_ann, data);
  }
  putpse(ss: bigint, es: bigint, data: UARTProtocolPacket): void {
    this.put(this.clampStart(ss), es, this.out_python, data);
  }
  putbin(rxtx: UARTDirection, data: BinaryData): void {
    this.put(
      this.clampStart(this.startsample[rxtx] - BigInt(Math.floor(this.bit_width! / 2))),
      this.samplenum + BigInt(Math.ceil(this.bit_width! / 2)),
      this.out_binary,
      data,
    );
  }
  get_sample_point(rxtx: UARTDirection, bitnum: number): bigint {
    let perc = this.options.sample_point || 50;
    if (!Number.isInteger(perc) || perc < 1 || perc > 99) perc = 50;
    return this.frame_start[rxtx] + BigInt(Math.ceil((this.bit_width! - 1) * (perc / 100) + bitnum * this.bit_width!));
  }
  wait_for_start_bit(rxtx: UARTDirection, signal: UARTSignal): void {
    this.frame_start[rxtx] = this.samplenum;
    this.frame_valid[rxtx] = true;
    this.cur_frame_bit[rxtx] = 0;
    this.advance_state(rxtx, signal);
  }
  get_start_bit(rxtx: UARTDirection, signal: UARTSignal): void {
    this.startbit[rxtx] = signal;
    this.cur_frame_bit[rxtx]! += 1;
    if (Number(signal) !== 0) {
      this.putp(['INVALID STARTBIT', rxtx, signal]);
      this.putg([UART_ANN.RX_WARN + rxtx, ['Frame error', 'Frame err', 'FE']]);
      this.frame_valid[rxtx] = false;
      const es = this.samplenum + BigInt(Math.ceil(this.bit_width! / 2));
      this.putpse(this.frame_start[rxtx], es, ['FRAME', rxtx, [this.datavalue[rxtx], false]]);
      this.advance_state(rxtx, signal, true, es);
      return;
    }
    this.cur_data_bit[rxtx] = 0;
    this.datavalue[rxtx] = 0;
    this.paritybit[rxtx] = -1;
    this.stopbits[rxtx] = [];
    this.startsample[rxtx] = -1n;
    this.databits[rxtx] = [];
    this.putp(['STARTBIT', rxtx, signal]);
    this.putg([UART_ANN.RX_START + rxtx, ['Start bit', 'Start', 'S']]);
    this.advance_state(rxtx, signal);
  }
  handle_packet(rxtx: UARTDirection): void {
    const direction = rxtx === RX ? 'rx' : 'tx';
    const delim = this.options[`${direction}_packet_delim`],
      plen = this.options[`${direction}_packet_len`];
    if (delim === -1 && plen === -1) return;
    if (!this.packet_cache[rxtx].length) this.ss_packet[rxtx] = this.startsample[rxtx];
    this.packet_cache[rxtx].push(this.datavalue[rxtx]);
    if (this.datavalue[rxtx] === delim || this.packet_cache[rxtx].length === plen) {
      this.es_packet[rxtx] = this.samplenum;
      const text = this.packet_cache[rxtx]
        .map((value) => this.format_value(value))
        .join(this.options.format === 'ascii' ? '' : ' ');
      this.putx_packet(rxtx, [UART_ANN.RX_PACKET + rxtx, [text]]);
      this.packet_cache[rxtx] = [];
    }
  }
  get_data_bits(rxtx: UARTDirection, signal: UARTSignal): void {
    if (this.startsample[rxtx] === -1n) this.startsample[rxtx] = this.samplenum;
    this.putg([UART_ANN.RX_DATA_BIT + rxtx, [String(Number(signal))]]);
    const s = this.samplenum,
      halfbit = BigInt(Math.floor(this.bit_width! / 2));
    this.databits[rxtx].push([signal, s - halfbit, s + halfbit]);
    this.cur_frame_bit[rxtx]! += 1;
    this.cur_data_bit[rxtx] += 1;
    if (this.cur_data_bit[rxtx] < this.options.data_bits) return;
    const bits = this.databits[rxtx].map((bit) => bit[0]);
    if (this.options.bit_order === 'msb-first') bits.reverse();
    this.datavalue[rxtx] = bits.reduce<number>((value, bit, index) => value + Number(bit) * 2 ** index, 0);
    this.putpx(rxtx, ['DATA', rxtx, [this.datavalue[rxtx], this.databits[rxtx]]]);
    const b = this.datavalue[rxtx],
      formatted = this.format_value(b);
    if (formatted != null) this.putx(rxtx, [rxtx, [formatted]]);
    const bytes = Uint8Array.from(
      { length: this.bw },
      (_, index) => Math.floor(b / 256 ** (this.bw - index - 1)) % 256,
    );
    this.putbin(rxtx, [rxtx, bytes]);
    this.putbin(rxtx, [2, bytes]);
    this.handle_packet(rxtx);
    this.databits[rxtx] = [];
    this.advance_state(rxtx, signal);
  }
  format_value(value: number): string | null {
    const fmt = this.options.format,
      bits = this.options.data_bits;
    if (fmt === 'ascii')
      return value >= 32 && value <= 126
        ? String.fromCharCode(value)
        : `[${value
            .toString(16)
            .toUpperCase()
            .padStart(bits <= 8 ? 2 : 3, '0')}]`;
    if (fmt === 'dec') return String(value);
    if (fmt === 'hex')
      return value
        .toString(16)
        .toUpperCase()
        .padStart(Math.ceil(bits / 4), '0');
    if (fmt === 'oct') return value.toString(8).padStart(Math.ceil(bits / 3), '0');
    if (fmt === 'bin') return value.toString(2).padStart(bits, '0');
    return null;
  }
  get_parity_bit(rxtx: UARTDirection, signal: UARTSignal): void {
    this.paritybit[rxtx] = signal;
    this.cur_frame_bit[rxtx]! += 1;
    if (parityOk(this.options.parity, signal, this.datavalue[rxtx])) {
      this.putp(['PARITYBIT', rxtx, signal]);
      this.putg([UART_ANN.RX_PARITY_OK + rxtx, ['Parity bit', 'Parity', 'P']]);
    } else {
      this.putp(['PARITY ERROR', rxtx, [0, 1]]);
      this.putg([UART_ANN.RX_PARITY_ERR + rxtx, ['Parity error', 'Parity err', 'PE']]);
      this.frame_valid[rxtx] = false;
    }
    this.advance_state(rxtx, signal);
  }
  get_stop_bits(rxtx: UARTDirection, signal: UARTSignal): void {
    this.stopbits[rxtx].push(signal);
    this.cur_frame_bit[rxtx]! += 1;
    if (Number(signal) !== 1) {
      this.putp(['INVALID STOPBIT', rxtx, signal]);
      this.putg([UART_ANN.RX_WARN + rxtx, ['Frame error', 'Frame err', 'FE']]);
      this.frame_valid[rxtx] = false;
    }
    this.putp(['STOPBIT', rxtx, signal]);
    this.putg([UART_ANN.RX_STOP + rxtx, ['Stop bit', 'Stop', 'T']]);
    if (this.stopbits[rxtx].length < this.options.stop_bits) return;
    this.advance_state(rxtx, signal);
  }
  advance_state(
    rxtx: UARTDirection,
    _signal: UARTSignal | null = null,
    fatal = false,
    idle: bigint | null = null,
  ): void {
    const frame_end = this.frame_start[rxtx] + BigInt(this.frame_len_sample_count);
    if (idle !== null) this.idle_start[rxtx] = idle;
    if (fatal) {
      this.state[rxtx] = 'WAIT FOR START BIT';
      return;
    }
    if (this.state[rxtx] === 'WAIT FOR START BIT') {
      this.state[rxtx] = 'GET START BIT';
      return;
    }
    if (this.state[rxtx] === 'GET START BIT') {
      this.state[rxtx] = 'GET DATA BITS';
      return;
    }
    if (this.state[rxtx] === 'GET DATA BITS') {
      this.state[rxtx] = 'GET PARITY BIT';
      if (this.options.parity !== 'none') return;
    }
    if (this.state[rxtx] === 'GET PARITY BIT') {
      this.state[rxtx] = 'GET STOP BITS';
      if (this.options.stop_bits) return;
    }
    if (this.state[rxtx] === 'GET STOP BITS') {
      this.handle_frame(rxtx, this.frame_start[rxtx], this.samplenum + BigInt(Math.ceil(this.bit_width! / 2)));
      this.state[rxtx] = 'WAIT FOR START BIT';
      this.idle_start[rxtx] = frame_end;
      return;
    }
    this.state[rxtx] = 'WAIT FOR START BIT';
  }
  handle_frame(rxtx: UARTDirection, ss: bigint, es: bigint): void {
    this.putpse(ss, es, ['FRAME', rxtx, [this.datavalue[rxtx], this.frame_valid[rxtx]]]);
  }
  handle_idle(rxtx: UARTDirection, ss: bigint, es: bigint): void {
    this.putpse(ss, es, ['IDLE', rxtx, 0]);
  }
  handle_break(rxtx: UARTDirection, ss: bigint, es: bigint): void {
    this.putpse(ss, es, ['BREAK', rxtx, 0]);
    this.putgse(ss, es, [UART_ANN.RX_BREAK + rxtx, ['Break condition', 'Break', 'Brk', 'B']]);
    this.state[rxtx] = 'WAIT FOR START BIT';
  }
  get_wait_cond(rxtx: UARTDirection, inv: boolean): WaitCondition {
    if (this.state[rxtx] === 'WAIT FOR START BIT') return { [rxtx]: inv ? 'r' : 'f' };
    return { skip: this.get_sample_point(rxtx, this.cur_frame_bit[rxtx]!) - this.samplenum };
  }
  get_idle_cond(rxtx: UARTDirection): WaitCondition | null {
    if (this.idle_start[rxtx] === null) return null;
    const end = this.idle_start[rxtx]! + BigInt(this.frame_len_sample_count);
    return end < this.samplenum ? null : { skip: end - this.samplenum };
  }
  inspect_sample(rxtx: UARTDirection, signal: UARTSignal, inv: boolean): void {
    if (inv) signal = !signal;
    switch (this.state[rxtx]) {
      case 'WAIT FOR START BIT':
        this.wait_for_start_bit(rxtx, signal);
        break;
      case 'GET START BIT':
        this.get_start_bit(rxtx, signal);
        break;
      case 'GET DATA BITS':
        this.get_data_bits(rxtx, signal);
        break;
      case 'GET PARITY BIT':
        this.get_parity_bit(rxtx, signal);
        break;
      case 'GET STOP BITS':
        this.get_stop_bits(rxtx, signal);
        break;
    }
  }
  inspect_edge(rxtx: UARTDirection, signal: UARTSignal, inv: boolean): void {
    if (inv) signal = !signal;
    if (!signal) {
      this.break_start[rxtx] = this.samplenum;
      return;
    }
    if (this.break_start[rxtx] === null) return;
    if (this.samplenum - this.break_start[rxtx]! >= this.break_min_sample_count)
      this.handle_break(rxtx, this.frame_start[rxtx], this.samplenum);
    this.break_start[rxtx] = null;
  }
  inspect_idle(rxtx: UARTDirection, signal: UARTSignal, inv: boolean): void {
    if (inv) signal = !signal;
    if (!signal) {
      this.idle_start[rxtx] = null;
      return;
    }
    if (this.idle_start[rxtx] === null) this.idle_start[rxtx] = this.samplenum;
    if (this.samplenum - this.idle_start[rxtx]! < this.frame_len_sample_count) return;
    this.handle_idle(rxtx, this.idle_start[rxtx]!, this.samplenum);
    this.idle_start[rxtx] = this.samplenum;
  }
  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    const has_pin = [this.hasChannel(RX), this.hasChannel(TX)];
    if (!has_pin.some(Boolean)) throw new Error('Need at least one of TX or RX pins.');
    const inv = [this.options.invert_rx === 'yes', this.options.invert_tx === 'yes'];
    this.frame_len_sample_count = Math.ceil(
      (1 + this.options.data_bits + (this.options.parity === 'none' ? 0 : 1) + this.options.stop_bits) *
        this.bit_width!,
    );
    this.break_min_sample_count = this.frame_len_sample_count;
    while (true) {
      const conds: WaitCondition[] = [],
        data_index = pair<number | null>(null),
        edge_index = pair<number | null>(null),
        idle_index = pair<number | null>(null);
      for (const line of [RX, TX] as const) {
        if (!has_pin[line]) continue;
        data_index[line] = conds.length;
        conds.push(this.get_wait_cond(line, inv[line]));
        edge_index[line] = conds.length;
        conds.push({ [line]: 'e' });
        const idle = this.get_idle_cond(line);
        if (idle) {
          idle_index[line] = conds.length;
          conds.push(idle);
        }
      }
      const pins = yield this.wait(conds);
      for (const line of [RX, TX] as const) {
        if (data_index[line] !== null && this.matched![data_index[line]!])
          this.inspect_sample(line, pins[line], inv[line]);
        if (edge_index[line] !== null && this.matched![edge_index[line]!]) {
          this.inspect_edge(line, pins[line], inv[line]);
          this.inspect_idle(line, pins[line], inv[line]);
        }
        if (idle_index[line] !== null && this.matched![idle_index[line]!])
          this.inspect_idle(line, pins[line], inv[line]);
      }
    }
  }
}
export default UARTDecoder;
