import { deadline, type UsbDevice } from './transport.js';

function checksum(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

export async function configureInputs(device: UsbDevice, mask: number): Promise<void> {
  const endpoints = device.configuration?.interfaces.find((item) => item.interfaceNumber === 0)?.alternates[0]
    ?.endpoints;
  const input = endpoints?.find((item) => item.endpointNumber === 4 && item.direction === 'in');
  if (!input) throw new Error('H417 management interface is unavailable');
  await device.claimInterface(0);
  try {
    const sequence = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const frame = new Uint8Array(18),
      header = new DataView(frame.buffer);
    header.setUint16(0, 0x4834, true);
    header.setUint8(2, 1);
    header.setUint8(3, 0x60);
    header.setUint16(6, 2, true);
    header.setUint32(8, sequence, true);
    frame.set([9, mask], 16);
    header.setUint32(12, checksum(frame), true);
    await deadline(
      (async () => {
        const output = await device.transferOut(3, frame);
        if (output.status !== 'ok' || output.bytesWritten !== frame.length)
          throw new Error('H417 channel configuration write failed');
        while (true) {
          const response = await device.transferIn(4, input.packetSize);
          if (response.status !== 'ok' || !response.data || response.data.byteLength < 16)
            throw new Error('Invalid H417 management response');
          const view = response.data,
            bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
          const expected = view.getUint32(12, true);
          new DataView(bytes.buffer).setUint32(12, 0, true);
          if (
            view.getUint16(0, true) !== 0x4834 ||
            view.getUint8(2) !== 1 ||
            view.byteLength !== 16 + view.getUint16(6, true) ||
            checksum(bytes) !== expected
          )
            throw new Error('Invalid H417 management frame');
          if (view.getUint8(3) === 0x20 || view.getUint32(8, true) !== sequence) continue;
          if (view.getUint8(3) !== 0x61 || view.getUint16(4, true) & ~1 || bytes.length !== 32 || bytes[16] !== 9)
            throw new Error('Invalid H417 channel configuration response');
          if (bytes[17] || !bytes[19] || bytes[27] !== mask || bytes[28] !== 1)
            throw new Error(`H417 could not select the requested inputs (status ${bytes[17]}, mask ${bytes[27]})`);
          return;
        }
      })(),
      5000,
      'H417 channel configuration timed out',
    );
  } catch (error) {
    await device.close().catch(() => {});
    throw error;
  } finally {
    await device.releaseInterface(0).catch(() => {});
  }
}
