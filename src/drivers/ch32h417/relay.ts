export type TransportMode = 'auto' | 'native' | 'webusb';
export type TransportKind = Exclude<TransportMode, 'auto'>;
export const RELAY_URL = 'http://127.0.0.1:17641';

type Endpoint = { endpointNumber: number; direction: 'in' | 'out'; type: string; packetSize: number };
type Alternate = { alternateSetting: number; interfaceClass: number; endpoints: Endpoint[] };
type Configuration = {
  configurationValue: number;
  interfaces: { interfaceNumber: number; alternate: Alternate; alternates: Alternate[] }[];
};
type Identity = {
  vendorId: number;
  productId: number;
  serialNumber?: string;
  productName?: string;
  manufacturerName?: string;
  deviceClass?: number;
  deviceSubclass?: number;
  deviceProtocol?: number;
  usbVersionMajor?: number;
  usbVersionMinor?: number;
  usbVersionSubminor?: number;
  configuration?: Configuration;
  configurations: Configuration[];
};
type InResult = { status: 'ok'; data: DataView };
type OutResult = { status: 'ok'; bytesWritten: number };
type Setup = { requestType: 'vendor'; recipient: 'device'; request: number; value: number; index: number };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> };

async function relayFetch(path: string): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1000);
  try {
    const response = await fetch(RELAY_URL + path, { signal: abort.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`USB relay HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}
export async function relayAvailable(): Promise<boolean> {
  try {
    const status = await (await relayFetch('/api/status')).json();
    return status.service === 'h417-usb-relay' && status.protocol === 1;
  } catch {
    return false;
  }
}

export class RelayDevice implements Identity {
  readonly transport = 'native';
  vendorId!: number;
  productId!: number;
  serialNumber?: string;
  productName?: string;
  manufacturerName?: string;
  deviceClass?: number;
  deviceSubclass?: number;
  deviceProtocol?: number;
  usbVersionMajor?: number;
  usbVersionMinor?: number;
  usbVersionSubminor?: number;
  configuration?: Configuration;
  configurations!: Configuration[];
  opened = false;
  private socket?: WebSocket;
  private sequence = 0;
  private sessionId?: string;
  private stream?: Promise<ReadableStreamDefaultReader<Uint8Array>>;
  private streamAbort?: AbortController;
  private streamPending: Promise<unknown> = Promise.resolve();
  private streamChunk: Uint8Array = new Uint8Array(0);
  private streamOffset = 0;
  private recordRemaining = 0;
  private streamError?: Error;
  private closing?: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  constructor(
    identity: Identity,
    private readonly lost: (device: RelayDevice) => void,
  ) {
    Object.assign(this, identity);
  }
  private fail(message: string): void {
    const wasOpen = this.opened;
    this.opened = false;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    this.pending.clear();
    if (wasOpen) this.lost(this);
  }
  async open(): Promise<void> {
    if (this.opened) return;
    this.streamError = undefined;
    const socket = new WebSocket(RELAY_URL.replace('http:', 'ws:') + '/usb');
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
      if (this.socket !== socket) return;
      if (typeof data === 'string') {
        const message = JSON.parse(data) as { id: number; result?: unknown; error?: string; event?: string };
        if (message.event === 'fault') {
          this.streamError = new Error(message.error ?? 'Native USB relay failed');
          if (this.stream) void this.stream.then((reader) => reader.cancel()).catch(() => {});
          return;
        }
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error));
        else item.resolve(message.result);
      } else {
        const header = new DataView(data);
        const id = header.getUint32(0, true);
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        clearTimeout(item.timer);
        item.resolve({ status: 'ok', data: new DataView(data, 8) } satisfies InResult);
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) this.fail('USB relay disconnected; capture stopped');
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('USB relay connection timed out'));
      }, 2000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('USB relay unavailable'));
      };
    });
    try {
      const opened = await this.rpc<{ device: Identity; sessionId: string }>('open', {
        serialNumber: this.serialNumber,
      });
      Object.assign(this, opened.device);
      this.sessionId = opened.sessionId;
      this.opened = true;
    } catch (error) {
      socket.close();
      throw error;
    }
  }
  private request<T>(send: (id: number) => void, timeout = 5000): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('USB relay is not connected'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const item: Pending = { resolve: (value) => resolve(value as T), reject };
      if (timeout)
        item.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('USB relay request timed out'));
          this.socket?.close();
        }, timeout);
      this.pending.set(id, item);
      try {
        send(id);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(item.timer);
        reject(error);
      }
    });
  }
  private rpc<T = void>(op: string, arguments_: Record<string, unknown> = {}, timeout?: number): Promise<T> {
    return this.request((id) => this.socket!.send(JSON.stringify({ id, op, ...arguments_ })), timeout);
  }
  private async stopStream(): Promise<void> {
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    if (this.stream) await this.stream.then((reader) => reader.cancel()).catch(() => {});
    await this.streamPending.catch(() => {});
    this.stream = undefined;
    this.streamChunk = new Uint8Array(0);
    this.streamOffset = 0;
    this.recordRemaining = 0;
    this.streamPending = Promise.resolve();
    this.streamError = undefined;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.opened = false;
    this.closing = (async () => {
      try {
        await this.stopStream();
        if (this.socket?.readyState === WebSocket.OPEN) await this.rpc('close').catch(() => {});
      } finally {
        const socket = this.socket;
        this.socket = undefined;
        socket?.close();
        this.fail('USB session closed');
      }
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
  async selectConfiguration(value: number): Promise<void> {
    if (this.configuration?.configurationValue !== value)
      throw new Error('USB relay requires the current configuration');
  }
  claimInterface(iface: number): Promise<void> {
    return this.rpc('claim', { iface });
  }
  async releaseInterface(iface: number): Promise<void> {
    if (iface === 1) await this.stopStream();
    await this.rpc('release', { iface });
  }
  async selectAlternateInterface(iface: number, alternate: number): Promise<void> {
    if (iface === 1) await this.stopStream();
    await this.rpc('alternate', { iface, alternate });
    const item = this.configuration?.interfaces.find((i) => i.interfaceNumber === iface);
    const setting = item?.alternates.find((a) => a.alternateSetting === alternate);
    if (item && setting) item.alternate = setting;
  }
  clearHalt(direction: 'in' | 'out', endpoint: number): Promise<void> {
    return this.rpc('clear', { endpoint: endpoint | (direction === 'in' ? 128 : 0) });
  }
  controlTransferIn(setup: Setup, length: number): Promise<InResult> {
    return this.rpc('controlIn', { ...setup, length });
  }
  controlTransferOut(setup: Setup, data?: Uint8Array): Promise<OutResult> {
    return this.rpc('controlOut', { ...setup, data: data ? [...data] : [] });
  }
  transferIn(endpoint: number, length: number): Promise<InResult> {
    if (endpoint !== 2) return this.rpc('read', { endpoint, length }, 0);
    if (!this.stream) {
      this.streamAbort = new AbortController();
      this.stream = fetch(`${RELAY_URL}/stream/${this.sessionId}/130?length=${length}`, {
        cache: 'no-store',
        signal: this.streamAbort.signal,
      }).then((response) => {
        if (!response.ok || !response.body) throw new Error(`USB relay stream HTTP ${response.status}`);
        return response.body.getReader();
      });
    }
    const stream = this.stream;
    const run = this.streamPending.then(async () => {
      const reader = await stream;
      const take = async (size: number): Promise<Uint8Array<ArrayBuffer>> => {
        const data = new Uint8Array(size);
        let written = 0;
        while (written < size) {
          if (this.streamOffset === this.streamChunk.length) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('USB relay stream ended; capture stopped');
            this.streamChunk = chunk.value;
            this.streamOffset = 0;
          }
          const count = Math.min(size - written, this.streamChunk.length - this.streamOffset);
          data.set(this.streamChunk.subarray(this.streamOffset, this.streamOffset + count), written);
          written += count;
          this.streamOffset += count;
        }
        return data;
      };
      if (!this.recordRemaining) {
        const header = await take(4);
        this.recordRemaining = new DataView(header.buffer).getUint32(0, true);
        if (this.recordRemaining < 1 || this.recordRemaining > 2097152) throw new Error('Invalid USB relay record');
      }
      const count = Math.min(length, this.recordRemaining);
      if (this.streamOffset === this.streamChunk.length) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('USB relay stream ended; capture stopped');
        this.streamChunk = chunk.value;
        this.streamOffset = 0;
      }
      let available = Math.min(count, this.streamChunk.length - this.streamOffset);
      const packet =
        this.configuration?.interfaces
          .find((i) => i.interfaceNumber === 1)
          ?.alternate.endpoints.find((e) => e.endpointNumber === 2)?.packetSize ?? 1024;
      if (available >= packet) available -= available % packet;
      else if (available < count && count >= packet) {
        const data = await take(packet);
        this.recordRemaining -= packet;
        return { status: 'ok', data: new DataView(data.buffer) } satisfies InResult;
      }
      const data = this.streamChunk.subarray(this.streamOffset, this.streamOffset + available);
      this.streamOffset += available;
      this.recordRemaining -= available;
      return { status: 'ok', data: new DataView(data.buffer, data.byteOffset, data.byteLength) } satisfies InResult;
    });
    const result = run.catch((error) => {
      throw (
        this.streamError ??
        new Error(
          `USB relay receive failed; capture stopped: ${error instanceof Error ? error.message : String(error)}`,
        )
      );
    });
    this.streamPending = result.catch(() => {});
    return result;
  }
  transferOut(endpoint: number, data: Uint8Array): Promise<OutResult> {
    return this.request((id) => {
      const message = new Uint8Array(8 + data.byteLength);
      const header = new DataView(message.buffer);
      header.setUint32(0, id, true);
      header.setUint32(4, endpoint, true);
      message.set(data, 8);
      this.socket!.send(message);
    });
  }
}

export class RelayUsb extends EventTarget {
  private readonly devices = new Map<string, RelayDevice>();
  async getDevices(): Promise<RelayDevice[]> {
    const identities = (await (await relayFetch('/api/devices')).json()) as Identity[];
    return identities.map((identity) => {
      const key = identity.serialNumber!;
      let device = this.devices.get(key);
      if (!device) {
        device = new RelayDevice(identity, (value) =>
          this.dispatchEvent(Object.assign(new Event('disconnect'), { device: value })),
        );
        this.devices.set(key, device);
      } else if (!device.opened) Object.assign(device, identity);
      return device;
    });
  }
  async requestDevice(): Promise<RelayDevice> {
    const devices = await this.getDevices();
    if (devices.length !== 1)
      throw new Error(
        devices.length
          ? 'Multiple H417 devices connected; select a device by serial number'
          : 'No H417 device connected to USB relay',
      );
    return devices[0]!;
  }
}

export const relayUsb = new RelayUsb();
export async function selectUsb<T>(
  mode: TransportMode,
  webusb: T,
): Promise<{ api: RelayUsb | T; kind: TransportKind }> {
  if (mode !== 'webusb' && (await relayAvailable())) return { api: relayUsb, kind: 'native' };
  if (mode === 'native') throw new Error('USB relay unavailable at 127.0.0.1:17641');
  return { api: webusb, kind: 'webusb' };
}
