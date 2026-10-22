import { USB_VID, USB_PID } from './descriptor.js';
import { ComponentError } from '../../components.js';
import type { UsbApi } from './transport.js';

export async function authorize(): Promise<unknown> {
  const usb = (globalThis.navigator as Navigator & { usb?: UsbApi } | undefined)?.usb;
  if (!usb) throw new ComponentError('driver.ch32h417.error.browser');
  const device = await usb.requestDevice({ filters: [{ vendorId: USB_VID, productId: USB_PID }] });
  if (!device.serialNumber?.startsWith('H417-')) throw new ComponentError('driver.ch32h417.error.identity');
  return { serialNumber: device.serialNumber, vendorId: device.vendorId, productId: device.productId };
}
