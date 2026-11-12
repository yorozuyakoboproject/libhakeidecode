import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pins } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface DaliOptions {
  polarity: 'active-low' | 'active-high';
}

type DaliState = 'IDLE' | 'PHASE0' | 'PHASE1';
type Label = readonly [long: string, short: string];

const ANN = Object.freeze({
  BIT: 0,
  START: 1,
  SELECT: 2,
  YBIT: 3,
  ADDRESS: 4,
  COMMAND: 5,
  REPLY: 6,
  RAW: 7,
});

const EXTENDED_COMMANDS = new Map<number, Label>([
  [0xa1, ['Terminate special processes', 'Terminate']],
  [0xa3, ['DTR = DATA', 'DTR']],
  [0xa5, ['INITIALISE', 'INIT']],
  [0xa7, ['RANDOMISE', 'RAND']],
  [0xa9, ['COMPARE', 'COMP']],
  [0xab, ['WITHDRAW', 'WDRAW']],
  [0xb1, ['SET SEARCH H', 'SAH']],
  [0xb3, ['SET SEARCH M', 'SAM']],
  [0xb5, ['SET SEARCH L', 'SAL']],
  [0xb7, ['Program Short Address', 'ProgSA']],
  [0xb9, ['Verify Short Address', 'VfySA']],
  [0xbb, ['Query Short Address', 'QryShort']],
  [0xbd, ['Physical Selection', 'PysSel']],
  [0xc1, ['Enable Device Type X', 'EnTyp']],
  [0xc3, ['DTR1 = DATA', 'DTR1']],
  [0xc5, ['DTR2 = DATA', 'DTR2']],
  [0xc7, ['Write Memory Location', 'WRI']],
]);

const COMMANDS = new Map<number, Label>([
  [0x00, ['Immediate Off', 'IOFF']],
  [0x01, ['Up 200ms', 'Up']],
  [0x02, ['Down 200ms', 'Down']],
  [0x03, ['Step Up', 'Step+']],
  [0x04, ['Step Down', 'Step-']],
  [0x05, ['Recall Maximum Level', 'Recall Max']],
  [0x06, ['Recall Minimum Level', 'Recall Min']],
  [0x07, ['Step down and off', 'Down Off']],
  [0x08, ['Step ON and UP', 'On Up']],
  [0x20, ['Reset', 'Rst']],
  [0x21, ['Store Dim Level in DTR', 'Level -> DTR']],
  [0x2a, ['Store DTR as Max Level', 'DTR->Max']],
  [0x2b, ['Store DTR as Min Level', 'DTR->Min']],
  [0x2c, ['Store DTR as Fail Level', 'DTR->Fail']],
  [0x2d, ['Store DTR as Power On Level', 'DTR->Poweron']],
  [0x2e, ['Store DTR as Fade Time', 'DTR->Fade']],
  [0x2f, ['Store DTR as Fade Rate', 'DTR->Rate']],
  [0x80, ['Store DTR as Short Address', 'DTR->Add']],
  [0x81, ['Enable Memory Write', 'WEn']],
  [0x90, ['Query Status', 'Status']],
  [0x91, ['Query Ballast', 'Ballast']],
  [0x92, ['Query Lamp Failure', 'LmpFail']],
  [0x93, ['Query Power On', 'Power On']],
  [0x94, ['Query Limit Error', 'Limit Err']],
  [0x95, ['Query Reset', 'Reset State']],
  [0x96, ['Query Missing Short Address', 'NoSrt']],
  [0x97, ['Query Version', 'Ver']],
  [0x98, ['Query DTR', 'GetDTR']],
  [0x99, ['Query Device Type', 'Type']],
  [0x9a, ['Query Physical Minimum', 'PhysMin']],
  [0x9b, ['Query Power Fail', 'PowerFailed']],
  [0x9c, ['Query DTR1', 'GetDTR1']],
  [0x9d, ['Query DTR2', 'GetDTR2']],
  [0xa0, ['Query Level', 'GetLevel']],
  [0xa1, ['Query Max Level', 'GetMax']],
  [0xa2, ['Query Min Level', 'GetMin']],
  [0xa3, ['Query Power On', 'GetPwrOn']],
  [0xa4, ['Query Fail Level', 'GetFail']],
  [0xa5, ['Query Fade Rate', 'GetRate']],
  [0xa6, ['Query Power Fail', 'PwrFail']],
  [0xc0, ['Query Groups 0-7', 'GetGrpsL']],
  [0xc1, ['Query Groups 7-15', 'GetGrpsH']],
  [0xc2, ['Query BRNH', 'BRNH']],
  [0xc3, ['Query BRNM', 'BRNM']],
  [0xc4, ['Query BRNL', 'BRNL']],
  [0xc5, ['Query Memory', 'GetMem']],
]);

const DEVICE_TYPE_8 = new Map<number, Label>([
  [0xe0, ['Set Temp X-Y Coordinate', 'Set X-Y']],
  [0xe2, ['Activate Colour Set point', 'Activate SetPoint']],
  [0xe7, ['Set Colour Temperature Tc', 'DTRs->ColTemp']],
  [0xf9, ['Query Features', 'QryFeats']],
  [0xfa, ['Query Current Setpoint Colour', 'GetSetPoint']],
]);

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

export class DaliDecoder extends Decoder<DaliOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private samplerate: number | null = null;
  private halfbit = 0;
  private oldDali = 1;
  private edges: bigint[] = [];
  private bits: Array<[bigint, number]> = [];
  private ssEsBits: Array<[bigint, bigint]> = [];
  private state: DaliState = 'IDLE';
  private phase0 = 0;
  private devType: number | null = null;

  constructor(options: Partial<DaliOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.halfbit = 0;
    this.oldDali = 1;
    this.edges = [];
    this.bits = [];
    this.ssEsBits = [];
    this.state = 'IDLE';
    this.phase0 = 0;
    this.devType = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.oldDali = 1;
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.halfbit = Math.trunc((value * 0.0008333) / 2);
  }

  private resetFrame(): void {
    this.edges = [];
    this.bits = [];
    this.ssEsBits = [];
    this.state = 'IDLE';
  }

  private putBits(first: number, last: number, data: readonly [number, readonly string[]]): void {
    const range = this.ssEsBits;
    this.put(range[first]![0], range[last]![1], this.outAnn, data);
  }

  private handleBits(length: number): void {
    const bits = this.bits;
    this.ssEsBits = [];
    for (let index = 0; index < length; index++) {
      const ss = index === 0 ? (bits[0]![0] > 0n ? bits[0]![0] : 0n) : this.ssEsBits[index - 1]![1];
      const es = bits[index]![0] + BigInt(this.halfbit * 2);
      this.ssEsBits.push([ss, es]);
      this.putBits(index, index, [ANN.BIT, [String(bits[index]![1])]]);
    }

    const start = bits[0]![1];
    const startTexts = [`Startbit: ${start}`, `ST: ${start}`, 'ST', 'S', 'S'];
    this.putBits(0, 0, [ANN.START, startTexts]);
    this.putBits(0, 0, [ANN.RAW, startTexts]);

    let firstByte = 0;
    for (let index = 0; index < 8; index++) firstByte |= bits[1 + index]![1] << (7 - index);

    if (length === 9) {
      const value = hex(firstByte);
      this.putBits(1, 8, [ANN.RAW, [`Reply: ${value}`, `Rply: ${value}`, `Rep: ${value}`, `R: ${value}`, 'R']]);
      this.putBits(1, 8, [
        ANN.REPLY,
        [`Reply: ${firstByte}`, `Rply: ${firstByte}`, `Rep: ${firstByte}`, `R: ${firstByte}`, 'R'],
      ]);
      return;
    }

    let command = 0;
    for (let index = 0; index < 8; index++) command |= bits[9 + index]![1] << (7 - index);
    this.putBits(1, 8, [
      ANN.RAW,
      [`Raw data: ${hex(firstByte)}`, `Raw: ${hex(firstByte)}`, `Raw: ${hex(firstByte)}`, `R: ${hex(firstByte)}`, 'R'],
    ]);
    this.putBits(9, 16, [
      ANN.RAW,
      [`Raw data: ${hex(command)}`, `Raw: ${hex(command)}`, `Raw: ${hex(command)}`, `R: ${hex(command)}`, 'R'],
    ]);

    this.putBits(8, 8, [
      ANN.START,
      bits[8]![1] === 1 ? ['Command', 'Comd', 'COM', 'CO', 'C'] : ['Arc Power Level', 'Arc Pwr', 'ARC', 'AC', 'A'],
    ]);

    if (firstByte >= 254) {
      this.putBits(1, 7, [ANN.COMMAND, ['BROADCAST', 'Brdcast', 'BC', 'B', 'B']]);
    } else if (firstByte >= 160) {
      if (firstByte === 0xc1) this.devType = -1;
      const label = EXTENDED_COMMANDS.get(firstByte) ?? ['Unknown', 'Unk'];
      this.putBits(1, 8, [
        ANN.COMMAND,
        [
          `Extended Command: ${hex(firstByte)} (${label[0]})`,
          `XC: ${hex(firstByte)} (${label[1]})`,
          `XC: ${hex(firstByte)}`,
          `X: ${hex(firstByte)}`,
          'X',
        ],
      ]);
    } else {
      this.putBits(1, 1, [ANN.YBIT, [`YBit: ${bits[1]![1]}`, `YB: ${bits[1]![1]}`, 'YB', 'Y', 'Y']]);
      if (firstByte >= 128) {
        const group = (firstByte & 0x7f) >> 1;
        this.putBits(2, 7, [
          ANN.ADDRESS,
          [`Group address: ${group}`, `Group: ${group}`, `GP: ${group}`, `G: ${group}`, 'G'],
        ]);
      } else {
        const address = firstByte >> 1;
        this.putBits(2, 7, [
          ANN.ADDRESS,
          [`Short address: ${address}`, `Addr: ${address}`, `Addr: ${address}`, `A: ${address}`, 'A'],
        ]);
      }
    }

    if (firstByte >= 160 && firstByte < 254) {
      if (this.devType === -1) {
        this.devType = command;
        this.putBits(9, 16, [
          ANN.COMMAND,
          [`Type: ${command}`, `Typ: ${command}`, `Typ: ${command}`, `T: ${command}`, 'D'],
        ]);
      } else {
        this.devType = null;
        this.putBits(9, 16, [
          ANN.COMMAND,
          [`Data: ${command}`, `Dat: ${command}`, `Dat: ${command}`, `D: ${command}`, 'D'],
        ]);
      }
    } else if (bits[8]![1] === 1) {
      const upper = command & 0xf0;
      const lower = command & 0x0f;
      let label: readonly [string, string];
      if (upper === 0x10) label = [`Recall Scene ${lower}`, `SC ${lower}`];
      else if (upper === 0x40) label = [`Store DTR as Scene ${lower}`, `SC ${lower} = DTR`];
      else if (upper === 0x50) label = [`Delete Scene ${lower}`, `DEL SC ${lower}`];
      else if (upper === 0x60) label = [`Add to Group ${lower}`, `Grp ${lower} Add`];
      else if (upper === 0x70) label = [`Remove from Group ${lower}`, `Grp ${lower} Del`];
      else if (upper === 0xb0) label = [`Query Scene ${lower} Level`, `Sc ${lower} Level`];
      else if (command >= 224)
        label =
          this.devType === 8
            ? (DEVICE_TYPE_8.get(command) ?? ['Unknown App', 'Unk'])
            : [`Application Specific Command ${command}`, `App Cmd ${command}`];
      else label = COMMANDS.get(command) ?? ['Unknown', 'Unk'];
      this.putBits(9, 16, [
        ANN.COMMAND,
        [`Command: ${command} (${label[0]})`, `Com: ${command} (${label[1]})`, `Com: ${command}`, `C: ${command}`, 'C'],
      ]);
    } else {
      this.putBits(9, 16, [
        ANN.COMMAND,
        [`Arc Power Level: ${command}`, `Level: ${command}`, `Lev: ${command}`, `L: ${command}`, 'L'],
      ]);
    }
  }

  *decode(): LogicGenerator {
    if (!this.samplerate || this.halfbit < 1) throw new Error('Cannot decode without samplerate.');
    const activeHigh = this.options.polarity === 'active-high';
    let pins: Pins = yield this.wait({ dali: 'e' });
    while (true) {
      const raw = Number(pins[0]);
      const level = activeHigh ? raw ^ 1 : raw;

      if (this.state === 'IDLE') {
        if (this.oldDali === level) {
          pins = yield this.wait({ dali: 'e' });
          continue;
        }
        this.edges.push(this.samplenum);
        this.state = 'PHASE0';
        this.oldDali = level;
      } else {
        const lastEdge = this.edges.at(-1);
        if (lastEdge === undefined) {
          this.resetFrame();
          pins = yield this.wait({ dali: 'e' });
          continue;
        }

        if (level !== this.oldDali) this.edges.push(this.samplenum);
        else {
          const deadline = lastEdge + BigInt(Math.trunc(this.halfbit * 1.5));
          if (this.samplenum !== deadline) {
            const delay = deadline - this.samplenum;
            pins = yield delay > 0n ? this.wait([{ dali: 'e' }, { skip: delay }]) : this.wait({ dali: 'e' });
            continue;
          }
          this.edges.push(this.samplenum - BigInt(Math.trunc(this.halfbit * 0.5)));
        }

        const bit = this.oldDali;
        if (this.state === 'PHASE0') {
          this.phase0 = bit;
          this.state = 'PHASE1';
        } else if (bit === 1 && this.phase0 === 1) {
          if (this.bits.length === 17 || this.bits.length === 9) this.handleBits(this.bits.length);
          this.resetFrame();
          pins = yield this.wait({ dali: 'e' });
          continue;
        } else {
          const start = this.edges.at(-3);
          if (start !== undefined) this.bits.push([start, bit]);
          this.state = 'PHASE0';
        }
        this.oldDali = level;
      }

      const deadline = this.edges.at(-1)! + BigInt(Math.trunc(this.halfbit * 1.5));
      const delay = deadline - this.samplenum;
      pins = yield delay > 0n ? this.wait([{ dali: 'e' }, { skip: delay }]) : this.wait({ dali: 'e' });
    }
  }
}

export default DaliDecoder;
