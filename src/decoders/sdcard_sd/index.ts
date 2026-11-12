import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';
import { ACCEPTED_VOLTAGES, commandName } from './tables.js';

interface TokenBit {
  value: number;
  ss: bigint;
  es: bigint;
}

type State = 'COMMAND' | `HANDLE ${number}` | 'R1' | 'R1B' | 'R2' | 'R3' | 'R6' | 'R7';

const ANN = Object.freeze({
  CMD_BASE: 0,
  ACMD_BASE: 64,
  R1: 128,
  R1B: 129,
  R2: 130,
  R3: 131,
  R6: 132,
  R7: 133,
  STATUS_BASE: 134,
  CID_BASE: 161,
  CSD_BASE: 170,
  BIT_0: 201,
  BIT_1: 202,
  START: 203,
  TRANSMISSION: 204,
  CMD_FIELD: 205,
  ARG_FIELD: 206,
  CRC_FIELD: 207,
  END: 208,
  DECODED_FIELD: 210,
});

const FIELDS = Object.freeze({
  START: ['Start bit', 'Start', 'S'],
  END: ['End bit', 'End', 'E'],
  CRC: ['CRC', 'CRC', 'C'],
  STUFF: ['Stuff bits', 'Stuff', 'SB', 'S'],
  RESERVED: ['Reserved', 'Res', 'R'],
  RCA: ['RCA', 'R'],
});

export class SdcardSdDecoder extends Decoder {
  static descriptor = descriptor;

  private outAnn = -1;
  private state: State = 'COMMAND';
  private token: TokenBit[] = [];
  private isAcmd = false;
  private cmd = 0;
  private lastCmd = 0;
  private arg = 0;
  private cmdStr = '';
  private crc = 0;

  constructor() {
    super();
    this.reset();
  }

  override reset(): void {
    this.state = 'COMMAND';
    this.token = [];
    this.isAcmd = false;
    this.cmd = 0;
    this.lastCmd = 0;
    this.arg = 0;
    this.cmdStr = '';
    this.crc = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putAt(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private putf(start: number, end: number, classIndex: number, texts: readonly string[]): void {
    this.putAt(this.token[start]!.ss, this.token[end]!.es, classIndex, texts);
  }

  private puta(start: number, end: number, classIndex: number, texts: readonly string[]): void {
    this.putf(47 - 8 - end, 47 - 8 - start, classIndex, texts);
  }

  private putToken(classIndex: number, texts: readonly string[], length = 48): void {
    this.putAt(this.token[0]!.ss, this.token[length - 1]!.es, classIndex, texts);
  }

  private putc(description: string): void {
    const classIndex = (this.isAcmd ? ANN.ACMD_BASE : ANN.CMD_BASE) + this.cmd;
    this.lastCmd = this.cmd;
    this.putToken(classIndex, [`${this.cmdStr}: ${description}`, this.cmdStr, this.cmdStr.split(' ')[0]!]);
  }

  private putResponse(classIndex: number, response: string, length = 48): void {
    this.putToken(classIndex, [`Response: ${response}`], length);
  }

  private argument(): number {
    return this.arg >>> 0;
  }

  private appendBit(value: number): boolean {
    const now = this.samplenum;
    if (this.token.length) this.token[this.token.length - 1]!.es = now;
    this.token.push({ value, ss: now, es: now });
    const host = this.token.length === 2 && this.token[1]!.value === 1;
    if (host) this.state = 'COMMAND';
    return host;
  }

  private completeBitrun(): void {
    const last = this.token[this.token.length - 1]!,
      previous = this.token[this.token.length - 2]!;
    last.es += last.ss - previous.ss;
  }

  private handleCommonTokenFields(): void {
    for (let index = 0; index < this.token.length; index++)
      this.putf(index, index, this.token[index]!.value === 0 ? ANN.BIT_0 : ANN.BIT_1, [
        String(this.token[index]!.value),
      ]);
    this.putf(0, 0, ANN.START, FIELDS.START);
    const host = this.token[1]!.value === 1;
    this.putf(1, 1, ANN.TRANSMISSION, [`Transmission: ${host ? 'host' : 'card'}`, `T: ${host ? 'host' : 'card'}`, 'T']);
    this.cmd = this.token.slice(2, 8).reduce((value, bit) => (value << 1) | bit.value, 0);
    const name = commandName(this.cmd, this.isAcmd),
      shown = `${name} (${this.cmd})`;
    this.putf(2, 7, ANN.CMD_FIELD, [`Command: ${shown}`, `Cmd: ${shown}`, `CMD${this.cmd}`, 'Cmd', 'C']);
    this.arg = this.token.slice(8, 40).reduce((value, bit) => ((value << 1) | bit.value) >>> 0, 0);
    this.putf(8, 39, ANN.ARG_FIELD, [`Argument: 0x${this.argument().toString(16).padStart(8, '0')}`, 'Arg', 'A']);
    this.crc = this.token.slice(40, 47).reduce((value, bit) => (value << 1) | bit.value, 0);
    this.putf(40, 46, ANN.CRC_FIELD, [`CRC: 0x${this.crc.toString(16)}`, 'CRC', 'C']);
    this.putf(47, 47, ANN.END, FIELDS.END);
  }

  private finishCommand(): void {
    const prefix = this.isAcmd ? 'ACMD' : 'CMD',
      name = commandName(this.cmd, this.isAcmd);
    this.cmdStr = `${prefix}${this.cmd} (${name})`;
    const application = this.isAcmd,
      index = this.cmd;
    if (application) {
      if (index === 6) {
        this.putc('Read SD config register (SCR)');
        this.state = 'R1';
      } else if (index === 13) {
        this.puta(0, 31, ANN.DECODED_FIELD, FIELDS.STUFF);
        this.putc('Set SD status');
        this.state = 'R1';
      } else if (index === 41) {
        this.puta(0, 23, ANN.DECODED_FIELD, ['VDD voltage window', 'VDD volt', 'VDD', 'V']);
        this.puta(24, 24, ANN.DECODED_FIELD, ['S18R']);
        this.puta(25, 27, ANN.DECODED_FIELD, FIELDS.RESERVED);
        this.puta(28, 28, ANN.DECODED_FIELD, ['XPC']);
        this.puta(29, 29, ANN.DECODED_FIELD, ['Reserved for eSD', 'Reserved', 'Res', 'R']);
        this.puta(30, 30, ANN.DECODED_FIELD, ['Host capacity support info', 'Host capacity', 'HCS', 'H']);
        this.puta(31, 31, ANN.DECODED_FIELD, FIELDS.RESERVED);
        this.putc('Send HCS info and activate the card init process');
        this.state = 'R3';
      } else if (index === 51) {
        this.putc('Read SD config register (SCR)');
        this.state = 'R1';
      } else {
        this.putc(`${prefix}${index}`);
        this.state = 'R1';
      }
    } else if (index === 0) {
      this.puta(0, 31, ANN.DECODED_FIELD, FIELDS.STUFF);
      this.putc('Reset all SD cards');
      this.state = 'COMMAND';
    } else if (index === 2) {
      this.puta(0, 31, ANN.DECODED_FIELD, FIELDS.STUFF);
      this.putc('Ask card for CID number');
      this.state = 'R2';
    } else if (index === 3) {
      this.puta(0, 31, ANN.DECODED_FIELD, FIELDS.STUFF);
      this.putc('Ask card for new relative card address (RCA)');
      this.state = 'R6';
    } else if (index === 6) {
      this.putc('Switch/check card function');
      this.state = 'R1';
    } else if (index === 7) {
      this.putc('Select / deselect card');
      this.state = 'R6';
    } else if (index === 8) {
      this.puta(12, 31, ANN.DECODED_FIELD, FIELDS.RESERVED);
      this.puta(8, 11, ANN.DECODED_FIELD, ['Supply voltage', 'Voltage', 'VHS', 'V']);
      this.puta(0, 7, ANN.DECODED_FIELD, ['Check pattern', 'Check pat', 'Check', 'C']);
      this.putc('Send interface condition to card');
      this.state = 'R7';
    } else if (index === 9) {
      this.puta(16, 31, ANN.DECODED_FIELD, FIELDS.RCA);
      this.puta(0, 15, ANN.DECODED_FIELD, FIELDS.STUFF);
      this.putc('Send card-specific data (CSD)');
      this.state = 'R2';
    } else if (index === 10) {
      this.puta(16, 31, ANN.DECODED_FIELD, FIELDS.RCA);
      this.puta(0, 15, ANN.DECODED_FIELD, FIELDS.STUFF);
      this.putc('Send card identification data (CID)');
      this.state = 'R2';
    } else if (index === 13) {
      this.puta(16, 31, ANN.DECODED_FIELD, FIELDS.RCA);
      this.puta(0, 15, ANN.DECODED_FIELD, FIELDS.STUFF);
      this.putc('Send card status register');
      this.state = 'R1';
    } else if (index === 16) {
      this.puta(0, 31, ANN.DECODED_FIELD, ['Block length', 'Blocklen', 'BL', 'B']);
      this.putc(`Set the block length to ${this.argument()} bytes`);
      this.state = 'R1';
    } else if (index === 55) {
      this.puta(16, 31, ANN.DECODED_FIELD, FIELDS.RCA);
      this.puta(0, 15, ANN.DECODED_FIELD, FIELDS.STUFF);
      this.putc('Next command is an application-specific command');
      this.isAcmd = true;
      this.state = 'R1';
    } else {
      this.putc(`${prefix}${index}`);
      this.state = 'R1';
    }
    if (this.isAcmd && index !== 55 && index !== 63) this.isAcmd = false;
    this.token = [];
  }

  private statusField(start: number, end: number, classIndex: number, texts: readonly string[]): void {
    this.putf(start, end, classIndex, texts);
  }

  private handleCardStatus(): void {
    this.statusField(8, 8, 134, ['OUT_OF_RANGE']);
    this.statusField(9, 9, 135, ['ADDRESS_ERROR']);
    this.statusField(10, 10, 136, ['BLOCK_LEN_ERROR']);
    this.statusField(11, 11, 137, ['ERASE_SEQ_ERROR']);
    this.statusField(12, 12, 138, ['ERASE_PARAM']);
    this.statusField(13, 13, 139, ['WP_VIOLATION']);
    this.statusField(14, 14, 140, ['CARD_IS_LOCKED']);
    this.statusField(15, 15, 141, ['LOCK_UNLOCK_FAILED']);
    this.statusField(16, 16, 142, ['COM_CRC_ERROR']);
    this.statusField(17, 17, 143, ['ILLEGAL_COMMAND']);
    this.statusField(18, 18, 144, ['CARD_ECC_FAILED']);
    this.statusField(19, 19, 145, ['CC_ERROR']);
    this.statusField(20, 20, 146, ['ERROR']);
    this.statusField(21, 21, 154, ['Reserved', 'RSVD', 'R']);
    this.statusField(22, 22, 147, ['Reserved for DEFERRED_RESPONSE', 'RSVD_DEFERRED_RESPONSE']);
    this.statusField(23, 23, 148, ['CSD_OVERWRITE']);
    this.statusField(24, 24, 149, ['WP_ERASE_SKIP']);
    this.statusField(25, 25, 150, ['CARD_ECC_DISABLED']);
    this.statusField(26, 26, 151, ['ERASE_RESET']);
    this.statusField(27, 30, 152, ['CURRENT_STATE']);
    this.statusField(31, 31, 153, ['READY_FOR_DATA']);
    this.statusField(32, 32, 154, ['RSVD']);
    this.statusField(33, 33, 155, ['FX_EVENT']);
    this.statusField(34, 34, 156, ['APP_CMD']);
    this.statusField(35, 35, 157, ['Reserved for SDIO card', 'RSVD_SDIO']);
    this.statusField(36, 36, 158, ['AKE_SEQ_ERROR']);
    this.statusField(37, 37, 159, ['Reserved for application specific commands', 'RSVD_APP_CMD']);
    this.statusField(38, 39, 160, ['Reserved for manufacturer test mode', 'RSVD_TESTMODE']);
  }

  private handleCidFields(): void {
    this.putf(8, 15, 161, ['Manufacturer ID', 'MID']);
    this.putf(16, 31, 162, ['OEM/application ID', 'OID']);
    this.putf(32, 71, 163, ['Product name', 'PNM']);
    this.putf(72, 79, 164, ['Product revision', 'PRV']);
    this.putf(80, 111, 165, ['Product serial number', 'PSN']);
    this.putf(112, 115, 166, ['Reserved', 'RSVD', 'R']);
    this.putf(116, 127, 167, ['Manufacturing date', 'MDT']);
    this.putf(128, 134, 168, ['CRC7 checksum', 'CRC']);
    this.putf(135, 135, 169, ['Always 1', '1']);
  }

  private handleCsdFields(): void {
    this.putf(8, 9, 170, ['CSD structure', 'CSD_STRUCTURE']);
    this.putf(10, 15, 171, FIELDS.RESERVED);
    this.putf(16, 23, 172, ['Data read access-time - 1', 'TAAC']);
    this.putf(24, 31, 173, ['Data read access-time - 2 in CLK cycles (NSAC * 100)', 'NSAC']);
    this.putf(32, 39, 174, ['Max. data transfer rate', 'TRAN_SPEED']);
    this.putf(40, 51, 175, ['Card command classes', 'CCC']);
    this.putf(52, 55, 176, ['Max. read data block length', 'READ_BL_LEN']);
    this.putf(56, 56, 177, ['Partial blocks for read allowed', 'READ_BL_PARTIAL']);
    this.putf(57, 57, 178, ['Write block misalignment', 'WRITE_BLK_MISALIGN']);
    this.putf(58, 58, 179, ['Read block misalignment', 'READ_BLK_MISALIGN']);
    this.putf(59, 59, 180, ['DSR implemented', 'DSR_IMP']);
    this.putf(60, 61, 171, FIELDS.RESERVED);
    this.putf(62, 73, 181, ['Device size', 'C_SIZE']);
    this.putf(74, 76, 182, ['Max. read current @VDD min', 'VDD_R_CURR_MIN']);
    this.putf(77, 79, 183, ['Max. read current @VDD max', 'VDD_R_CURR_MAX']);
    this.putf(80, 82, 184, ['Max. write current @VDD min', 'VDD_W_CURR_MIN']);
    this.putf(83, 85, 185, ['Max. write current @VDD max', 'VDD_W_CURR_MAX']);
    this.putf(86, 88, 186, ['Device size multiplier', 'C_SIZE_MULT']);
    this.putf(89, 89, 187, ['Erase single block enable', 'ERASE_BLK_EN']);
    this.putf(90, 96, 188, ['Erase sector size', 'SECTOR_SIZE']);
    this.putf(97, 103, 189, ['Write protect group size', 'WP_GRP_SIZE']);
    this.putf(104, 104, 190, ['Write protect group enable', 'WP_GRP_ENABLE']);
    this.putf(105, 106, 171, FIELDS.RESERVED);
    this.putf(107, 109, 191, ['Write speed factor', 'R2W_FACTOR']);
    this.putf(110, 113, 192, ['Max. write data block length', 'WRITE_BL_LEN']);
    this.putf(114, 114, 193, ['Partial blocks for write allowed', 'WRITE_BL_PARTIAL']);
    this.putf(115, 119, 171, ['Reserved', 'RSVD']);
    this.putf(120, 120, 194, ['File format group', 'FILE_FORMAT_GRP']);
    this.putf(121, 121, 195, ['Copy flag', 'COPY']);
    this.putf(122, 122, 196, ['Permanent write protection', 'PERM_WRITE_PROTECT']);
    this.putf(123, 123, 197, ['Temporary write protection', 'TMP_WRITE_PROTECT']);
    this.putf(124, 125, 198, ['File format', 'FILE_FORMAT']);
    this.putf(126, 127, 171, FIELDS.RESERVED);
    this.putf(128, 134, 199, ['CRC', 'CRC', 'C']);
    this.putf(135, 135, 200, ['Always 1', '1']);
  }

  private handleResponseR1(): void {
    this.handleCommonTokenFields();
    this.putResponse(ANN.R1, 'R1');
    this.puta(0, 31, ANN.DECODED_FIELD, ['Card status', 'Status', 'S']);
    this.handleCardStatus();
    this.state = 'COMMAND';
    this.token = [];
  }

  private handleResponseR1b(): void {
    this.handleCommonTokenFields();
    this.puta(0, 31, ANN.DECODED_FIELD, ['Card status', 'Status', 'S']);
    this.putResponse(ANN.R1B, 'R1b');
    this.state = 'COMMAND';
    this.token = [];
  }

  private handleResponseR2(): void {
    for (let index = 0; index < this.token.length; index++)
      this.putf(index, index, this.token[index]!.value === 0 ? ANN.BIT_0 : ANN.BIT_1, [
        String(this.token[index]!.value),
      ]);
    this.putf(0, 0, ANN.START, FIELDS.START);
    const host = this.token[1]!.value === 1;
    this.putf(1, 1, ANN.TRANSMISSION, [`Transmission: ${host ? 'host' : 'card'}`, `T: ${host ? 'host' : 'card'}`, 'T']);
    this.putf(2, 7, ANN.CMD_FIELD, FIELDS.RESERVED);
    this.putf(8, 134, ANN.ARG_FIELD, ['Argument', 'Arg', 'A']);
    this.putf(135, 135, ANN.END, FIELDS.END);
    this.putf(8, 134, ANN.DECODED_FIELD, ['CID/CSD register', 'CID/CSD', 'C']);
    this.putResponse(ANN.R2, 'R2', 136);
    if (this.lastCmd === 2 || this.lastCmd === 10) this.handleCidFields();
    else if (this.lastCmd === 9) this.handleCsdFields();
    this.state = 'COMMAND';
    this.token = [];
  }

  private handleResponseR3(): void {
    this.putResponse(ANN.R3, 'R3');
    for (let index = 0; index < this.token.length; index++)
      this.putf(index, index, this.token[index]!.value === 0 ? ANN.BIT_0 : ANN.BIT_1, [
        String(this.token[index]!.value),
      ]);
    this.putf(0, 0, ANN.START, FIELDS.START);
    const host = this.token[1]!.value === 1;
    this.putf(1, 1, ANN.TRANSMISSION, [`Transmission: ${host ? 'host' : 'card'}`, `T: ${host ? 'host' : 'card'}`, 'T']);
    this.putf(2, 7, ANN.CMD_FIELD, FIELDS.RESERVED);
    this.putf(8, 39, ANN.ARG_FIELD, ['Argument', 'Arg', 'A']);
    this.putf(40, 46, ANN.CRC_FIELD, FIELDS.RESERVED);
    this.putf(47, 47, ANN.END, FIELDS.END);
    this.puta(0, 31, ANN.DECODED_FIELD, ['OCR register', 'OCR reg', 'OCR', 'O']);
    this.state = 'COMMAND';
    this.token = [];
  }

  private handleResponseR6(): void {
    this.handleCommonTokenFields();
    this.puta(0, 15, ANN.DECODED_FIELD, ['Card status bits', 'Status', 'S']);
    this.puta(16, 31, ANN.DECODED_FIELD, ['Relative card address', 'RCA', 'R']);
    this.putResponse(ANN.R6, 'R6');
    this.state = 'COMMAND';
    this.token = [];
  }

  private handleResponseR7(): void {
    this.handleCommonTokenFields();
    this.putResponse(ANN.R7, 'R7');
    this.puta(12, 31, ANN.DECODED_FIELD, FIELDS.RESERVED);
    const voltage = this.token.slice(28, 32).reduce((value, bit) => (value << 1) | bit.value, 0);
    const accepted = ACCEPTED_VOLTAGES[voltage] ?? 'Unknown';
    this.puta(8, 11, ANN.DECODED_FIELD, [`Voltage accepted: ${accepted}`, 'Voltage', 'Volt', 'V']);
    this.puta(0, 7, ANN.DECODED_FIELD, ['Echo-back of check pattern', 'Echo', 'E']);
    this.state = 'COMMAND';
    this.token = [];
  }

  private finishResponse(): void {
    if (this.state === 'R1') this.handleResponseR1();
    else if (this.state === 'R1B') this.handleResponseR1b();
    else if (this.state === 'R2') this.handleResponseR2();
    else if (this.state === 'R3') this.handleResponseR3();
    else if (this.state === 'R6') this.handleResponseR6();
    else if (this.state === 'R7') this.handleResponseR7();
  }

  *decode(): LogicGenerator {
    if (!this.hasChannel('cmd') || !this.hasChannel('clk')) throw new Error('CMD and CLK channels are required.');
    while (true) {
      const pins = yield this.wait({ clk: 'r' }),
        command = Number(pins[0]);
      if (this.state === 'COMMAND') {
        if (!this.token.length && command !== 0) continue;
        this.appendBit(command);
        if (this.token.length < 48) continue;
        this.completeBitrun();
        this.handleCommonTokenFields();
        this.finishCommand();
      } else if (typeof this.state === 'string' && this.state.startsWith('HANDLE ')) {
        this.finishCommand();
      } else {
        if (!this.token.length && command !== 0) continue;
        if (this.appendBit(command)) continue;
        const length = this.state === 'R2' ? 136 : 48;
        if (this.token.length < length) continue;
        this.completeBitrun();
        this.finishResponse();
      }
    }
  }
}

export default SdcardSdDecoder;
