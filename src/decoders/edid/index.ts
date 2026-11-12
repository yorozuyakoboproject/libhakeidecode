import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import type { I2CProtocolPacket } from '../i2c/index.js';
import { descriptor } from './descriptor.js';
import { lookupPnpId } from './pnpids.js';

const HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00] as const;
const OFF_VENDOR = 8,
  OFF_VERSION = 18,
  OFF_BASIC = 20,
  OFF_CHROM = 25,
  OFF_EST_TIMING = 35,
  OFF_STD_TIMING = 38,
  OFF_DET_TIMING = 54,
  OFF_NUM_EXT = 126,
  OFF_CHECKSUM = 127;

const EST_MODES = [
  '720x400@70Hz',
  '720x400@88Hz',
  '640x480@60Hz',
  '640x480@67Hz',
  '640x480@72Hz',
  '640x480@75Hz',
  '800x600@56Hz',
  '800x600@60Hz',
  '800x600@72Hz',
  '800x600@75Hz',
  '832x624@75Hz',
  '1024x768@87Hz(i)',
  '1024x768@60Hz',
  '1024x768@70Hz',
  '1024x768@75Hz',
  '1280x1024@75Hz',
  '1152x870@75Hz',
] as const;

const RATIOS = [
  [16, 10],
  [4, 3],
  [5, 4],
  [16, 9],
] as const;

const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

interface Span {
  ss: bigint;
  es: bigint;
}

type State = 'OFFSET' | 'EXTENSIONS' | 'HEADER' | 'EDID' | null;

function dataEnd(_ss: bigint, es: bigint): bigint {
  return es;
}

function sevenBitAddress(address: number): number {
  return address > 0x7f ? address >>> 1 : address;
}

function resizeSpans(spans: Span[], length: number): Span[] {
  if (spans.length > length) spans.length = length;
  while (spans.length < length) spans.push({ ss: 0n, es: 0n });
  return spans;
}

function resizeBytes(bytes: number[], length: number): number[] {
  if (bytes.length > length) bytes.length = length;
  while (bytes.length < length) bytes.push(0);
  return bytes;
}

function decodeCp437(bytes: readonly number[]): string {
  return bytes
    .map((value) => {
      if (value < 0x20) return ' ';
      if (value < 0x7f) return String.fromCharCode(value);
      return CP437[value - 0x80] ?? '?';
    })
    .join('');
}

export class EdidDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private state: State = null;
  private cnt = 0;
  private rootSn: Span[] = [];
  private rootCache: number[] = [];
  private sn: Span[] = this.rootSn;
  private cache: number[] = this.rootCache;
  private extension = 0;
  private extSn: Span[][] = [[]];
  private extCache: number[][] = [[]];
  private offset = 0;
  private havePreferredTiming = false;
  private addressStart = 0n;
  private lastDirection: 'read' | 'write' | null = null;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = null;
    this.cnt = 0;
    this.rootSn = [];
    this.rootCache = [];
    this.sn = this.rootSn;
    this.cache = this.rootCache;
    this.extension = 0;
    this.extSn = [[]];
    this.extCache = [[]];
    this.offset = 0;
    this.havePreferredTiming = false;
    this.addressStart = 0n;
    this.lastDirection = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private annField(start: number, end: number, texts: readonly string[] | string): void {
    const first = this.sn[start],
      last = this.sn[end];
    if (!first || !last) return;
    this.annotate(first.ss, last.es, 0, typeof texts === 'string' ? [texts] : texts);
  }

  private section(start: number, es: bigint, text: string): void {
    const span = this.sn[start];
    if (span) this.annotate(span.ss, es, 1, [text]);
  }

  private selectOffset(offset: number): void {
    this.offset = offset;
    this.extension = Math.floor(offset / 128);
    this.cnt = offset % 128;
    if (this.extension > 0) {
      while (this.extSn.length < this.extension) this.extSn.push([]);
      while (this.extCache.length < this.extension) this.extCache.push([]);
      this.sn = resizeSpans(this.extSn[this.extension - 1]!, this.cnt);
      this.cache = resizeBytes(this.extCache[this.extension - 1]!, this.cnt);
    } else {
      this.sn = resizeSpans(this.rootSn, this.cnt);
      this.cache = resizeBytes(this.rootCache, this.cnt);
    }
  }

  private decodeVid(): void {
    const offset = this.cache.length - 10,
      b0 = this.cache[offset]!,
      b1 = this.cache[offset + 1]!,
      pnpId =
        String.fromCharCode(64 + ((b0 & 0x7c) >> 2)) +
        String.fromCharCode(64 + (((b0 & 0x03) << 3) | ((b1 & 0xe0) >> 5))) +
        String.fromCharCode(64 + (b1 & 0x1f)),
      vendor = lookupPnpId(pnpId);
    this.annField(offset, offset + 1, vendor ? `${pnpId} (${vendor})` : pnpId);
  }

  private decodePid(): void {
    const offset = this.cache.length - 8;
    this.annField(
      offset,
      offset + 1,
      `Product 0x${this.cache[offset + 1]!.toString(16).padStart(2, '0')}${this.cache[offset]!.toString(16).padStart(
        2,
        '0',
      )}`,
    );
  }

  private decodeSerial(): void {
    const offset = this.cache.length - 6,
      bytes = this.cache.slice(offset, offset + 4),
      serial = bytes[3]! * 0x1000000 + bytes[2]! * 0x10000 + bytes[1]! * 0x100 + bytes[0]!;
    let text = '',
      alphanumeric = true;
    for (let index = 3; index >= 0; index--) {
      const value = bytes[index]!;
      if (!/[A-Za-z0-9]/.test(String.fromCharCode(value))) {
        alphanumeric = false;
        break;
      }
      text += String.fromCharCode(value);
    }
    this.annField(offset, offset + 3, `Serial ${alphanumeric ? text : serial}`);
  }

  private decodeManufactureDate(): void {
    const offset = this.cache.length - 2,
      week = this.cache[offset]!,
      year = 1990 + this.cache[offset + 1]!,
      text = `${week ? `week ${week}, ` : ''}${year}`;
    this.annField(offset, offset + 1, [`Manufactured ${text}`, text]);
  }

  private decodeBasicDisplay(): void {
    const offset = this.cache.length - 5,
      video = this.cache[offset]!;
    if (video & 0x80) {
      this.annField(offset, offset, 'Video input: VESA DFP 1.');
    } else {
      this.annField(offset, offset, `Signal level standard: ${((video & 60) >>> 5).toString(16).padStart(2, '0')}`);
      if (video & 0x10) this.annField(offset, offset, 'Blank-to-black setup expected');
      const syncs: string[] = [];
      if (video & 0x08) syncs.push('separate syncs');
      if (video & 0x04) syncs.push('composite syncs');
      if (video & 0x02) syncs.push('sync on green');
      if (video & 0x01) syncs.push('Vsync serration required');
      if (syncs.length) this.annField(offset, offset, `Supported syncs: ${syncs.join(', ')}`);
    }
    if (this.cache[offset + 1] && this.cache[offset + 2])
      this.annField(offset + 1, offset + 2, `Physical size: ${this.cache[offset + 1]}x${this.cache[offset + 2]}cm`);
    if (this.cache[offset + 3] !== 0xff)
      this.annField(offset + 3, offset + 3, `Gamma: ${((this.cache[offset + 3]! + 100) / 100).toFixed(2)}`);
    const features = this.cache[offset + 4]!,
      dpms: string[] = [];
    if (features & 0x80) dpms.push('standby');
    if (features & 0x40) dpms.push('suspend');
    if (features & 0x20) dpms.push('active off');
    if (dpms.length) this.annField(offset + 4, offset + 4, `DPMS support: ${dpms.join(', ')}`);
    const displayType = (features & 0x18) >>> 3,
      types = ['Monochrome', 'RGB color', 'non-RGB multicolor'];
    if (types[displayType]) this.annField(offset + 4, offset + 4, `Display type: ${types[displayType]}`);
    if (features & 0x04) this.annField(offset + 4, offset + 4, 'Color space: standard sRGB');
    this.havePreferredTiming = (features & 0x02) === 0x02;
    this.annField(offset + 4, offset + 4, `Generalized timing formula: ${features & 0x01 ? '' : 'not '}supported`);
  }

  private convertColor(value: number): number {
    let output = 0;
    for (let index = 0; index < 10; index++) {
      if (value & 1) output += 2 ** -(10 - index);
      value >>>= 1;
    }
    return output;
  }

  private decodeChromaticity(): void {
    const offset = this.cache.length - 10,
      b0 = this.cache[offset]!,
      b1 = this.cache[offset + 1]!,
      redX = (this.cache[offset + 2]! << 2) | ((b0 & 0xc0) >>> 6),
      redY = (this.cache[offset + 3]! << 2) | ((b0 & 0x30) >>> 4),
      greenX = (this.cache[offset + 4]! << 2) | ((b0 & 0x0c) >>> 2),
      greenY = (this.cache[offset + 5]! << 2) | (b0 & 0x03),
      blueX = (this.cache[offset + 6]! << 2) | ((b1 & 0xc0) >>> 6),
      blueY = (this.cache[offset + 7]! << 2) | ((b1 & 0x30) >>> 4),
      whiteX = (this.cache[offset + 8]! << 2) | ((b1 & 0x0c) >>> 2),
      whiteY = (this.cache[offset + 9]! << 2) | (b1 & 0x03);
    this.annField(
      offset,
      offset + 9,
      `Chromacity red: X ${this.convertColor(redX).toFixed(3)}, Y ${this.convertColor(redY).toFixed(3)}`,
    );
    this.annField(
      offset,
      offset + 9,
      `Chromacity green: X ${this.convertColor(greenX).toFixed(3)}, Y ${this.convertColor(greenY).toFixed(3)}`,
    );
    this.annField(
      offset,
      offset + 9,
      `Chromacity blue: X ${this.convertColor(blueX).toFixed(3)}, Y ${this.convertColor(blueY).toFixed(3)}`,
    );
    this.annField(
      offset,
      offset + 9,
      `Chromacity white: X ${this.convertColor(whiteX).toFixed(3)}, Y ${this.convertColor(whiteY).toFixed(3)}`,
    );
  }

  private decodeEstablishedTimings(): void {
    const offset = this.cache.length - 3,
      bitmap = (this.cache[offset]! << 9) + (this.cache[offset + 1]! << 1) + ((this.cache[offset + 2]! & 0x80) >>> 7),
      modes: string[] = [];
    for (let index = 0; index < 17; index++) if (bitmap & (1 << (16 - index))) modes.push(EST_MODES[index]!);
    if (modes.length) this.annField(offset, offset + 2, `Supported established modes: ${modes.join(', ')}`);
  }

  private decodeStandardTimings(): void {
    const offset = this.cache.length - 16,
      modes: string[] = [];
    for (let index = 0; index < 16; index += 2) {
      if (this.cache[offset + index] === 0x01 && this.cache[offset + index + 1] === 0x01) continue;
      const width = (this.cache[offset + index]! + 31) * 8,
        ratio = (this.cache[offset + index + 1]! & 0xc0) >>> 6,
        [ratioX, ratioY] = RATIOS[ratio]!,
        height = Math.trunc((width / ratioX) * ratioY),
        refresh = (this.cache[offset + index + 1]! & 0x3f) + 60;
      modes.push(`${width}x${height}@${refresh}Hz`);
    }
    if (modes.length) this.annField(offset, offset + 15, `Supported standard modes: ${modes.join(', ')}`);
  }

  private decodeDetailedTiming(cache: readonly number[], sn: readonly Span[], base: number, first: boolean): void {
    const section = first && this.havePreferredTiming ? 'Preferred timing descriptor' : 'Detailed timing descriptor';
    this.annotate(sn[0]!.ss, sn[17]!.es, 1, [section]);
    const pixelClock = ((cache[1]! << 8) + cache[0]!) / 100;
    this.annField(base, base + 1, `Pixel clock: ${pixelClock.toFixed(2)} MHz`);
    const horizontalActive = ((cache[4]! & 0xf0) << 4) + cache[2]!,
      horizontalBlank = ((cache[4]! & 0x0f) << 8) + cache[3]!;
    this.annField(base + 2, base + 4, `Horizontal active: ${horizontalActive}, blanking: ${horizontalBlank}`);
    const verticalActive = ((cache[7]! & 0xf0) << 4) + cache[5]!,
      verticalBlank = ((cache[7]! & 0x0f) << 8) + cache[6]!;
    this.annField(base + 5, base + 7, `Vertical active: ${verticalActive}, blanking: ${verticalBlank}`);
    const horizontalOffset = ((cache[11]! & 0xc0) << 2) + cache[8]!,
      horizontalPulse = ((cache[11]! & 0x30) << 4) + cache[9]!,
      verticalOffset = ((cache[11]! & 0x0c) << 2) + ((cache[10]! & 0xf0) >>> 4),
      verticalPulse = ((cache[11]! & 0x03) << 4) + (cache[10]! & 0x0f);
    this.annField(base + 8, base + 11, [
      `Horizontal sync offset: ${horizontalOffset}, pulse width: ${horizontalPulse}, ` +
        `Vertical sync offset: ${verticalOffset}, pulse width: ${verticalPulse}`,
      `HSync off: ${horizontalOffset}, pw: ${horizontalPulse}, ` + `VSync off: ${verticalOffset}, pw: ${verticalPulse}`,
    ]);
    const horizontalSize = ((cache[14]! & 0xf0) << 4) + cache[12]!,
      verticalSize = ((cache[14]! & 0x0f) << 8) + cache[13]!;
    this.annField(base + 12, base + 14, `Physical size: ${horizontalSize}x${verticalSize}mm`);
    this.annField(base + 15, base + 15, `Horizontal border: ${cache[15]} pixels`);
    this.annField(base + 16, base + 16, `Vertical border: ${cache[16]} lines`);
    const flags = cache[17]!,
      features: string[] = [];
    if (flags & 0x80) features.push('interlaced');
    const stereo = (flags & 0x60) >>> 5;
    if (stereo) {
      if (flags & 0x01)
        features.push(
          `2-way interleaved stereo (${['right image on even lines', 'left image on even lines', 'side-by-side'][stereo - 1]})`,
        );
      else
        features.push(
          `field sequential stereo (${['right image on sync=1', 'left image on sync=1', '4-way interleaved'][stereo - 1]})`,
        );
    }
    const sync = (flags & 0x18) >>> 3,
      syncDetail = (flags & 0x06) >>> 1,
      polarity = ['negative', 'positive'];
    let syncText: string;
    if (sync === 0x00) syncText = 'analog composite (serrate on RGB)';
    else if (sync === 0x01) syncText = 'bipolar analog composite (serrate on RGB)';
    else if (sync === 0x02) syncText = `digital composite (serrate on composite polarity ${polarity[syncDetail & 1]})`;
    else
      syncText = `digital separate (Vsync polarity ${polarity[(syncDetail & 2) >>> 1]}, Hsync polarity ${polarity[syncDetail & 1]})`;
    features.push(`sync type ${syncText}`);
    this.annField(base + 17, base + 17, `Flags: ${features.join(', ')}`);
  }

  private decodeDescriptor(cache: readonly number[], sn: readonly Span[], base: number): void {
    const tag = cache[3]!;
    this.annField(base, base + 1, 'Flag');
    this.annField(base + 2, base + 2, 'Flag (reserved)');
    this.annField(base + 3, base + 3, `Tag: ${tag.toString(16).toUpperCase()}`);
    this.annField(base + 4, base + 4, 'Flag');
    const text = decodeCp437(cache.slice(5, 18)).trim();
    if (tag === 0xff) {
      this.annotate(sn[0]!.ss, sn[17]!.es, 1, ['Serial number']);
      this.annField(base + 5, base + 17, text);
    } else if (tag === 0xfe) {
      this.annotate(sn[0]!.ss, sn[17]!.es, 1, ['Text']);
      this.annField(base + 5, base + 17, text);
    } else if (tag === 0xfc) {
      this.annotate(sn[0]!.ss, sn[17]!.es, 1, ['Monitor name']);
      this.annField(base + 5, base + 17, text);
    } else if (tag === 0xfd) {
      this.annotate(sn[0]!.ss, sn[17]!.es, 1, ['Monitor range limits']);
      this.annField(base + 5, base + 5, [`Minimum vertical rate: ${cache[5]}Hz`, `VSync >= ${cache[5]}Hz`]);
      this.annField(base + 6, base + 6, [`Maximum vertical rate: ${cache[6]}Hz`, `VSync <= ${cache[6]}Hz`]);
      this.annField(base + 7, base + 7, [`Minimum horizontal rate: ${cache[7]}kHz`, `HSync >= ${cache[7]}kHz`]);
      this.annField(base + 8, base + 8, [`Maximum horizontal rate: ${cache[8]}kHz`, `HSync <= ${cache[8]}kHz`]);
      this.annField(base + 9, base + 9, [
        `Maximum pixel clock: ${cache[9]! * 10}MHz`,
        `PixClk <= ${cache[9]! * 10}MHz`,
      ]);
      if (cache[10] === 0x02) {
        this.annField(base + 10, base + 10, ['Secondary timing formula supported', '2nd GTF: yes']);
        this.annField(base + 11, base + 17, 'GTF');
      } else {
        this.annField(base + 10, base + 10, ['Secondary timing formula unsupported', '2nd GTF: no']);
        this.annField(base + 11, base + 17, 'Padding');
      }
    } else if (tag === 0xfb) {
      this.annotate(sn[0]!.ss, sn[17]!.es, 1, ['Additional color point data']);
    } else if (tag === 0xfa) {
      this.annotate(sn[0]!.ss, sn[17]!.es, 1, ['Additional standard timing definitions']);
    } else {
      this.annotate(sn[0]!.ss, sn[17]!.es, 1, ['Unknown descriptor']);
    }
  }

  private decodeDescriptors(offset: number): void {
    const count = Math.abs(offset) / 18,
      start = this.cache.length - count * 18;
    for (let index = 0; index < count; index++) {
      const base = start + index * 18,
        cache = this.cache.slice(base, base + 18),
        sn = this.sn.slice(base, base + 18);
      if (cache.length < 18 || sn.length < 18) continue;
      if (cache[0] !== 0 || cache[1] !== 0) this.decodeDetailedTiming(cache, sn, base, index === 0);
      else if (cache[2] === 0 || cache[4] === 0) this.decodeDescriptor(cache, sn, base);
    }
  }

  private decodeDataBlock(tag: number, cache: readonly number[], sn: readonly Span[]): void {
    const codes: Readonly<Record<number, readonly string[]>> = {
      0: ['0: Reserved'],
      1: ['1: Audio Data Block', 'Audio'],
      2: ['2: Video Data Block', 'Video'],
      3: ['3: Vendor Specific Data Block', 'VSDB'],
      4: ['4: Speacker Allocation Data Block', 'SADB'],
      5: ['5: VESA DTC Data Block', 'DTC'],
      6: ['6: Reserved'],
      7: ['7: Extended', 'Ext'],
    };
    const extCodes: Readonly<Record<number, readonly string[]>> = {
      0: ['0: Video Capability Data Block', 'VCDB'],
      1: ['1: Vendor Specific Video Data Block', 'VSVDB'],
      17: ['17: Vendor Specific Audio Data Block', 'VSADB'],
    };
    let code: readonly string[],
      data: string,
      extLength = 0;
    if (tag < 7) {
      code = codes[tag] ?? ['Unknown'];
      if (tag === 1) {
        const audioFormats: Readonly<Record<number, string>> = { 1: '1 (LPCM)' },
          rates = ['192', '176', '96', '88', '48', '44', '32'],
          audioFormat = cache[1]! >>> 3,
          supported = Array.from({ length: 8 }, (_, index) => index).filter((index) => (1 << index) & cache[2]!),
          format = audioFormats[audioFormat] ?? String(audioFormat);
        data =
          `Format: ${format} Channels: ${(cache[1]! & 0x07) + 1}` +
          ` Rates: ${supported
            .map((index) => rates[6 - index])
            .filter(Boolean)
            .join(' ')}` +
          ` Extra: [${cache[3]!.toString(16).padStart(2, '0').toUpperCase()}]`;
      } else if (tag === 2) {
        data = `VIC: ${cache
          .slice(1)
          .map((value) => `${value & 0x7f}${value >>> 7 ? ' (Native)' : ''}`)
          .join(', ')}`;
      } else if (tag === 3) {
        const oui = cache.slice(1, 4).reverse(),
          ouiText = oui.map((value) => value.toString(16).padStart(2, '0').toUpperCase()).join(' '),
          known = ouiText === '00 0C 03' ? 'HDMI Licensing, LLC' : undefined;
        data =
          `OUI: ${ouiText}` +
          (known ? ` (${known})` : '') +
          `, PhyAddr: ${cache[4]! >>> 4}.${cache[4]! & 0x0f}.${cache[5]! >>> 4}.${cache[5]! & 0x0f}` +
          `, [${cache
            .slice(6)
            .map((value) => value.toString(16).padStart(2, '0').toUpperCase())
            .join(' ')}]`;
      } else if (tag === 4) {
        const speakers = ['FL/FR', 'LFE', 'FC', 'RL/RR', 'RC', 'FLC/FRC', 'RLC/RRC', 'FLW/FRW', 'FLH/FRH', 'TC', 'FCH'],
          supported = cache[1]! + (cache[2]! << 8);
        data = `Speakers: ${speakers.filter((_, index) => supported & (1 << index)).join(' ')}`;
      } else {
        data = cache
          .slice(1)
          .map((value) => value.toString(16).padStart(2, '0').toUpperCase())
          .join(' ');
      }
    } else {
      extLength = 1;
      const extended = extCodes[cache[1]!] ?? ['Unknown', '?'],
        primary = codes[7] ?? ['Extended'],
        first = `${primary[0]}, ${extended[0]}`,
        second = `${primary[1] ?? 'Ext'}, ${extended[1] ?? '?'}`;
      code = [first, second];
      data = cache
        .slice(2)
        .map((value) => value.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
    }
    const firstSpan = sn[0],
      codeEnd = sn[extLength];
    if (firstSpan && codeEnd) this.annotate(firstSpan.ss, codeEnd.es, 0, code);
    const dataStart = sn[1 + extLength],
      dataLast = sn[cache.length - 1];
    if (dataStart && dataLast) this.annotate(dataStart.ss, dataLast.es, 0, [data]);
  }

  private decodeDataBlockCollection(cache: readonly number[], sn: readonly Span[]): void {
    let offset = 0;
    while (offset < cache.length) {
      const header = cache[offset]!,
        length = 1 + (header & 0x1f),
        tag = header >>> 5,
        block = cache.slice(offset, offset + length),
        spans = sn.slice(offset, offset + length);
      if (!block.length || !spans.length) break;
      this.decodeDataBlock(tag, block, spans);
      offset += length;
    }
  }

  private decodeReadByte(ss: bigint, es: bigint, value: number): void {
    this.cnt++;
    const end = dataEnd(ss, es);
    this.sn.push({ ss, es: end });
    this.cache.push(value);

    if (this.state === null || this.state === 'HEADER') {
      if (this.cnt >= 8) {
        const tail = this.cache.slice(-8);
        if (tail.every((byte, index) => byte === HEADER[index])) {
          this.sn = this.sn.slice(-8);
          this.cache = this.cache.slice(-8);
          if (this.extension > 0) {
            this.extSn[this.extension - 1] = this.sn;
            this.extCache[this.extension - 1] = this.cache;
          } else {
            this.rootSn = this.sn;
            this.rootCache = this.cache;
          }
          this.cnt = 8;
          this.state = 'EDID';
          this.section(0, end, 'Header');
          this.annField(0, 7, 'Header pattern');
        }
      }
      return;
    }

    if (this.state === 'EDID') {
      if (this.cnt === OFF_VERSION) {
        this.decodeVid();
        this.decodePid();
        this.decodeSerial();
        this.decodeManufactureDate();
        this.section(OFF_VENDOR, end, 'Vendor/product');
      } else if (this.cnt === OFF_BASIC) {
        this.section(OFF_VERSION, end, 'EDID Version');
        this.annField(OFF_VERSION, OFF_VERSION, `Version ${this.cache[OFF_VERSION]}`);
        this.annField(OFF_VERSION + 1, OFF_VERSION + 1, `Revision ${this.cache[OFF_VERSION + 1]}`);
      } else if (this.cnt === OFF_CHROM) {
        this.section(OFF_BASIC, end, 'Basic display');
        this.decodeBasicDisplay();
      } else if (this.cnt === OFF_EST_TIMING) {
        this.section(OFF_CHROM, end, 'Color characteristics');
        this.decodeChromaticity();
      } else if (this.cnt === OFF_STD_TIMING) {
        this.section(OFF_EST_TIMING, end, 'Established timings');
        this.decodeEstablishedTimings();
      } else if (this.cnt === OFF_DET_TIMING) {
        this.section(OFF_STD_TIMING, end, 'Standard timings');
        this.decodeStandardTimings();
      } else if (this.cnt === OFF_NUM_EXT) {
        this.decodeDescriptors(-72);
      } else if (this.cnt === OFF_CHECKSUM) {
        this.annField(OFF_NUM_EXT, OFF_NUM_EXT, `Extensions present: ${this.cache[OFF_NUM_EXT]}`);
      } else if (this.cnt === OFF_CHECKSUM + 1) {
        const checksum = this.cache.reduce((sum, byte) => sum + byte, 0);
        this.annotateChecksum(ss, end, this.cache[OFF_CHECKSUM]!, checksum % 256 === 0);
        this.state = 'EXTENSIONS';
      }
      return;
    }

    if (this.state !== 'EXTENSIONS' || this.extension <= 0) return;
    const cache = this.cache,
      sn = this.sn,
      current = cache[this.cnt - 1]!,
      dtdOffset = cache[2] ?? 0;
    if (this.cnt === 1) {
      this.annotate(ss, end, 1, current === 2 ? ['Extensions Tag', 'Tag'] : ['Bad Tag']);
    } else if (this.cnt === 2) {
      this.annotate(ss, end, 1, ['Version']);
      this.annotate(ss, end, 0, [String(current)]);
    } else if (this.cnt === 3) {
      this.annotate(ss, end, 1, ['DTD offset']);
      this.annotate(ss, end, 0, [String(current)]);
    } else if (this.cnt === 4) {
      const support =
        `Underscan: ${current & 0x80 ? 'yes' : 'no'}, ` +
        `${current & 0x40 ? 'Basic' : 'No'} Audio, ` +
        `YCbCr: ${['None', '422', '444', '422+444'][(current & 0x30) >>> 4]}`;
      this.annotate(ss, end, 1, ['Format support | DTD count']);
      this.annotate(ss, end, 0, [`${support}, DTDs: ${current & 0x0f}`]);
    } else if (this.cnt <= dtdOffset) {
      if (this.cnt === dtdOffset) {
        this.section(4, end, 'Data block collection');
        this.decodeDataBlockCollection(cache.slice(4), sn.slice(4));
      }
    } else if ((this.cnt - dtdOffset) % 18 === 0) {
      const descriptor = (this.cnt - dtdOffset) / 18;
      if (descriptor <= (cache[3]! & 0x0f)) {
        this.section(this.cnt - 18, end, 'DTD');
        this.decodeDescriptors(-18);
      }
    } else if (this.cnt === 127) {
      const dtdLast = dtdOffset + (cache[3]! & 0x0f) * 18,
        span = sn[dtdLast];
      if (span) this.annotate(span.ss, end, 1, ['Padding']);
    } else if (this.cnt === 128) {
      const checksum = cache.reduce((sum, byte) => sum + byte, 0);
      this.annotateChecksum(ss, end, cache[this.cnt - 1]!, checksum % 256 === 0, 'Wrong');
    }
  }

  private annotateChecksum(ss: bigint, es: bigint, value: number, valid: boolean, invalid = 'WRONG!'): void {
    this.annotate(ss, es, 0, [`Checksum: ${value} (${valid ? 'OK' : invalid})`]);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as I2CProtocolPacket;
    if (packet[0] === 'ADDRESS') {
      const address = sevenBitAddress(packet[2]);
      if (address !== 0x50) return;
      this.lastDirection = packet[1];
      if (packet[1] === 'write') {
        this.state = 'OFFSET';
        this.addressStart = ss;
      } else {
        if (this.extension > 0) {
          this.state = 'EXTENSIONS';
          this.annotate(ss, es, 1, [`Extension: ${this.extension}`, `X: ${this.extension}`, String(this.extension)]);
        } else {
          this.state = 'HEADER';
          this.annotate(ss, es, 1, ['EDID']);
        }
      }
      return;
    }
    if (packet[0] === 'DATA') {
      if (packet[1] === 'write' && this.state === 'OFFSET' && this.lastDirection === 'write') {
        this.selectOffset(packet[2]);
        this.annotate(this.addressStart || ss, dataEnd(ss, es), 1, [
          `Offset: ${packet[2]}`,
          `O: ${packet[2]}`,
          String(packet[2]),
        ]);
      } else if (packet[1] === 'read' && this.lastDirection === 'read' && this.state !== 'OFFSET') {
        this.decodeReadByte(ss, es, packet[2]);
      }
    }
  }
}

export default EdidDecoder;
