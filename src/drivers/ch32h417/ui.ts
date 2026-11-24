import { USB_VID, USB_PID } from './descriptor.js';
import { ComponentError } from '../../components.js';
import type { UsbApi } from './transport.js';
import { selectUsb, type TransportMode } from './relay.js';

export async function authorize(initialization?: unknown): Promise<unknown> {
  const browser = (globalThis.navigator as (Navigator & { usb?: UsbApi }) | undefined)?.usb;
  const init = initialization as { transportMode?: TransportMode; relayPort?: number } | undefined;
  const mode = init?.transportMode ?? 'auto';
  const { api: usb } = await selectUsb(mode, browser, init?.relayPort);
  if (!usb) throw new ComponentError('driver.ch32h417.error.browser');
  const device = await usb.requestDevice({ filters: [{ vendorId: USB_VID, productId: USB_PID }] });
  if (!device.serialNumber?.startsWith('H417-')) throw new ComponentError('driver.ch32h417.error.identity');
  return {
    serialNumber: device.serialNumber,
    vendorId: device.vendorId,
    productId: device.productId,
    transportMode: mode,
    ...(init?.relayPort === undefined ? {} : { relayPort: init.relayPort }),
  };
}
