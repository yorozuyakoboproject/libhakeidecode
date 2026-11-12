export interface FlashChip {
  readonly vendor: string;
  readonly model: string;
  readonly pageSize: number;
  readonly sectorSize: number | null;
  readonly blockSize: number | null;
}

export interface FlashCommand {
  readonly code: number;
  readonly name: string;
  readonly description: string;
  readonly classIndex: number;
}

const COMMAND_LIST = [
  [0x01, 'WRSR', 'Write status register', 0],
  [0x02, 'PP', 'Page program', 1],
  [0x03, 'READ', 'Read data', 2],
  [0x04, 'WRDI', 'Write disable', 3],
  [0x05, 'RDSR', 'Read status register', 4],
  [0x06, 'WREN', 'Write enable', 5],
  [0x0b, 'FAST/READ', 'Fast read data', 6],
  [0x20, 'SE', 'Sector erase', 7],
  [0x2b, 'RDSCUR', 'Read security register', 8],
  [0x2f, 'WRSCUR', 'Write security register', 9],
  [0x35, 'RDSR2', 'Read status register 2', 10],
  [0x60, 'CE', 'Chip erase', 11],
  [0x70, 'ESRY', 'Enable SO to output RY/BY#', 12],
  [0x80, 'DSRY', 'Disable SO to output RY/BY#', 13],
  [0x82, 'WRITE1', 'Main memory page program through buffer 1 with built-in erase', 14],
  [0x85, 'WRITE2', 'Main memory page program through buffer 2 with built-in erase', 15],
  [0x90, 'REMS', 'Read electronic manufacturer & device ID', 16],
  [0x9f, 'RDID', 'Read identification', 17],
  [0xab, 'RDP/RES', 'Release from deep powerdown / Read electronic ID', 18],
  [0xad, 'CP', 'Continuously program mode', 19],
  [0xb1, 'ENSO', 'Enter secured OTP', 20],
  [0xb9, 'DP', 'Deep power down', 21],
  [0xbb, '2READ', '2x I/O read', 22],
  [0xc1, 'EXSO', 'Exit secured OTP', 23],
  [0xc7, 'CE2', 'Chip erase 2', 24],
  [0xd7, 'STATUS', 'Status register read', 25],
  [0xd8, 'BE', 'Block erase', 26],
  [0xef, 'REMS2', 'Read ID for 2x I/O mode', 27],
] as const;

export const FLASH_COMMANDS: readonly FlashCommand[] = COMMAND_LIST.map(([code, name, description, classIndex]) => ({
  code,
  name,
  description,
  classIndex,
}));

export const FLASH_BY_CODE = new Map(FLASH_COMMANDS.map((command) => [command.code, command]));

export const FLASH_CHIPS: Readonly<Record<string, FlashChip>> = {
  adesto_at45db161e: {
    vendor: 'Adesto',
    model: 'AT45DB161E',
    pageSize: 528,
    sectorSize: 128 * 1024,
    blockSize: 4 * 1024,
  },
  atmel_at25128: { vendor: 'Atmel', model: 'AT25128', pageSize: 64, sectorSize: null, blockSize: null },
  atmel_at25256: { vendor: 'Atmel', model: 'AT25256', pageSize: 64, sectorSize: null, blockSize: null },
  fidelix_fm25q32: {
    vendor: 'FIDELIX',
    model: 'FM25Q32',
    pageSize: 256,
    sectorSize: 4 * 1024,
    blockSize: 64 * 1024,
  },
  macronix_mx25l1605d: {
    vendor: 'Macronix',
    model: 'MX25L1605D',
    pageSize: 256,
    sectorSize: 4 * 1024,
    blockSize: 64 * 1024,
  },
  macronix_mx25l3205d: {
    vendor: 'Macronix',
    model: 'MX25L3205D',
    pageSize: 256,
    sectorSize: 4 * 1024,
    blockSize: 64 * 1024,
  },
  macronix_mx25l6405d: {
    vendor: 'Macronix',
    model: 'MX25L6405D',
    pageSize: 256,
    sectorSize: 4 * 1024,
    blockSize: 64 * 1024,
  },
  macronix_mx25l8006: {
    vendor: 'Macronix',
    model: 'MX25L8006',
    pageSize: 256,
    sectorSize: 4 * 1024,
    blockSize: 64 * 1024,
  },
  winbond_w25q80dv: {
    vendor: 'Winbond',
    model: 'W25Q80DV',
    pageSize: 256,
    sectorSize: 4 * 1024,
    blockSize: 64 * 1024,
  },
};

const DEVICE_NAMES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  adesto: { 0x00: 'AT45Dxxx family, standard series' },
  fidelix: { 0x15: 'FM25Q32' },
  macronix: {
    0x13: 'MX25L8006',
    0x14: 'MX25L1605D',
    0x15: 'MX25L3205D',
    0x16: 'MX25L6405D',
  },
  winbond: { 0x13: 'W25Q80DV' },
};

export function flashDeviceName(vendor: string, deviceId: number): string {
  return DEVICE_NAMES[vendor]?.[deviceId] ?? 'Unknown';
}
