import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { MdioProtocolData } from '../mdio/index.js';
import { descriptor } from './descriptor.js';

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

const CFP_ANN = Object.freeze({ REGISTER: 0, DECODE: 1 });

export class CfpDecoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;

  private outAnn = -1;

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const packet of data as unknown as MdioProtocolData) {
      if (!Array.isArray(packet) || packet.length < 6) continue;
      const [, address, read, , , value] = packet;
      if (!read || !Number.isInteger(address) || !Number.isInteger(value)) continue;

      if (address >= 0x8000 && address <= 0x807f) {
        this.annotate(ss, es, CFP_ANN.REGISTER, ['CFP NVR 1: Basic ID register', 'NVR1']);
        if (address === 0x8000) {
          const module = MODULE_ID[value] ?? 'Reserved';
          this.annotate(ss, es, CFP_ANN.DECODE, [`Module identifier: ${module}`]);
        }
      } else if (address >= 0x8080 && address <= 0x80ff) {
        this.annotate(ss, es, CFP_ANN.REGISTER, ['CFP NVR 2: Extended ID register', 'NVR2']);
      } else if (address >= 0x8100 && address <= 0x817f) {
        this.annotate(ss, es, CFP_ANN.REGISTER, ['CFP NVR 3: Network lane specific register', 'NVR3']);
      } else if (address >= 0x8180 && address <= 0x81ff) {
        this.annotate(ss, es, CFP_ANN.REGISTER, ['CFP NVR 4', 'NVR4']);
      } else if (address >= 0x8400 && address <= 0x847f) {
        this.annotate(ss, es, CFP_ANN.REGISTER, ['Vendor NVR 1: Vendor data register', 'V-NVR1']);
      } else if (address >= 0x8480 && address <= 0x84ff) {
        this.annotate(ss, es, CFP_ANN.REGISTER, ['Vendor NVR 2: Vendor data register', 'V-NVR2']);
      } else if (address >= 0x8800 && address <= 0x887f) {
        this.annotate(ss, es, CFP_ANN.REGISTER, ['User NVR 1: User data register', 'U-NVR1']);
      } else if (address >= 0x8880 && address <= 0x88ff) {
        this.annotate(ss, es, CFP_ANN.REGISTER, ['User NVR 2: User data register', 'U-NVR2']);
      } else if (address >= 0xa000 && address <= 0xa07f) {
        this.annotate(ss, es, CFP_ANN.REGISTER, [
          'CFP Module VR 1: CFP Module level control and DDM register',
          'Mod-VR1',
        ]);
      } else if (address >= 0xa080 && address <= 0xa0ff) {
        this.annotate(ss, es, CFP_ANN.REGISTER, ['MLG VR 1: MLG Management Interface register', 'MLG-VR1']);
      }
    }
  }
}

export default CfpDecoder;
