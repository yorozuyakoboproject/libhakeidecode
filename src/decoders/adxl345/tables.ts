export const ERROR_MESSAGES = {
  interrupt: ['Interrupt'],
  undesirable: ['Undesirable behavior'],
  dis_single: ['Disable single tap'],
  dis_double: ['Disable double tap'],
  dis_single_double: ['Disable single/double tap'],
} as const;

export const RATE_CODES = [
  0.1, 0.2, 0.39, 0.78, 1.56, 3.13, 6.25, 12.5, 25, 50, 100, 200, 400, 800, 1600, 3200,
] as const;

export const FIFO_MODES = ['Bypass', 'FIFO', 'Stream', 'Trigger'] as const;
export const OPERATIONS = [
  ['WRITE REG', 'WRITE', 'W'],
  ['READ REG', 'READ', 'R'],
] as const;
export const NUMBER_BYTES = [
  ['SINGLE BYTE', 'SING BYTE', '1 BYTE', '1B'],
  ['MULTIPLE BYTES', 'MULTI BYTES', 'n*BYTES', 'n*B'],
] as const;

export const REGISTERS: Readonly<Record<number, readonly string[]>> = {
  0x00: ['DEVID', 'DID', 'ID'],
  0x1d: ['THRESH_TAP', 'TH_TAP', 'TH_T'],
  0x1e: ['OFSX', 'OFX'],
  0x1f: ['OFSY', 'OFY'],
  0x20: ['OFSZ', 'OFZ'],
  0x21: ['DUR'],
  0x22: ['Latent', 'Lat'],
  0x23: ['Window', 'Win'],
  0x24: ['THRESH_ACT', 'TH_ACT', 'TH_A'],
  0x25: ['THRESH_INACT', 'TH_INACT', 'TH_I'],
  0x26: ['TIME_INACT', 'TI_INACT', 'TI_I'],
  0x27: ['ACT_INACT_CTL', 'ACT_I_CTL', 'A_I_C'],
  0x28: ['THRESH_FF', 'TH_FF'],
  0x29: ['TIME_FF', 'TI_FF'],
  0x2a: ['TAP_AXES', 'TAP_AX', 'TP_AX'],
  0x2b: ['ACT_TAP_STATUS', 'ACT_TAP_STAT', 'ACT_TP_ST', 'A_T_S'],
  0x2c: ['BW_RATE', 'BW_R'],
  0x2d: ['POWER_CTL', 'PW_CTL', 'PW_C'],
  0x2e: ['INT_ENABLE', 'INT_EN', 'I_EN'],
  0x2f: ['INT_MAP', 'I_M'],
  0x30: ['INT_SOURCE', 'INT_SRC', 'I_SRC', 'I_S'],
  0x31: ['DATA_FORMAT', 'DATA_FRM', 'D_FRM', 'D_F'],
  0x32: ['DATAX0', 'DX0', 'X0'],
  0x33: ['DATAX1', 'DX1', 'X1'],
  0x34: ['DATAY0', 'DY0', 'Y0'],
  0x35: ['DATAY1', 'DY1', 'Y1'],
  0x36: ['DATAZ0', 'DZ0', 'Z0'],
  0x37: ['DATAZ1', 'DZ1', 'Z1'],
  0x38: ['FIFO_CTL', 'FIF_CT', 'F_C'],
  0x39: ['FIFO_STATUS', 'FIFO_STAT', 'FIF_ST', 'F_S'],
};
