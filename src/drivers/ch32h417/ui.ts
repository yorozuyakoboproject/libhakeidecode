import { USB_VID, USB_PID } from './descriptor.js';
import { ComponentError } from '../../components.js';
import type { UsbApi } from './transport.js';
import { selectUsb, type TransportMode } from './relay.js';

export async function authorize(initialization?: unknown): Promise<unknown> {
  const browser = (globalThis.navigator as (Navigator & { usb?: UsbApi }) | undefined)?.usb;
  const mode = (initialization as { transportMode?: TransportMode } | undefined)?.transportMode ?? 'auto';
  const { api: usb } = await selectUsb(mode, browser);
  if (!usb) throw new ComponentError('driver.ch32h417.error.browser');
  const device = await usb.requestDevice({ filters: [{ vendorId: USB_VID, productId: USB_PID }] });
  if (!device.serialNumber?.startsWith('H417-')) throw new ComponentError('driver.ch32h417.error.identity');
  return { serialNumber: device.serialNumber, vendorId: device.vendorId, productId: device.productId };
}
