import { RelayData } from './relay-data.js';

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

class RelayTiming {
  count = 0;
  totalMs = 0;
  maxMs = 0;
  readonly bucketUpperMs = [0.1, 1, 5, 20, 100, 500, 1000, 5000, null];
  readonly buckets = new Array<number>(9).fill(0);
  readonly recentLong: { atUnixMs: number; ms: number }[] = [];
  activeSinceUnixMs: number | null = null;
  add(at: number, ms = performance.now() - at): void {
    ++this.count;
    this.totalMs += ms;
    this.maxMs = Math.max(this.maxMs, ms);
    let bucket = 0;
    while (bucket < 8 && ms > this.bucketUpperMs[bucket]!) ++bucket;
    ++this.buckets[bucket]!;
    if (ms >= 20) {
      if (this.recentLong.length === 16) this.recentLong.shift();
      this.recentLong.push({ atUnixMs: performance.timeOrigin + at, ms });
    }
  }
}
class RelayDiagnostics {
  readonly timeOriginUnixMs = performance.timeOrigin;
  readonly startedUnixMs = Date.now();
  readonly heartbeat = new RelayTiming();
  lastBeat = performance.now();
  endedUnixMs = 0;
  websocket?: RelayData['metrics'];
}

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
  let status;
  try {
    status = await (await relayFetch('/api/status')).json();
  } catch {
    return false;
  }
  if (status.service !== 'h417-usb-relay') return false;
  if (status.protocol !== 1 || !status.dataProtocols?.includes('ws-consumed-v1'))
    throw new Error('USB relay data protocol is incompatible. Please update H417 USB Relay.');
  return true;
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
  private data?: RelayData;
  private closing?: Promise<void>;
  private diagnostics?: RelayDiagnostics;
  private diagnosticsTimer?: ReturnType<typeof setInterval>;
  private reporting?: Promise<void>;
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
    this.data?.fail(new Error(message));
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    this.pending.clear();
    if (wasOpen) this.lost(this);
  }
  async open(): Promise<void> {
    if (this.opened) return;
    const socket = new WebSocket(RELAY_URL.replace('http:', 'ws:') + '/usb');
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
      if (this.socket !== socket) return;
      if (typeof data === 'string') {
        const message = JSON.parse(data) as { id: number; result?: unknown; error?: string; event?: string };
        if (message.event === 'fault') {
          this.data?.fail(new Error(message.error ?? 'Native USB relay failed'));
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
  private reportDiagnostics(): Promise<void> {
    if (this.reporting) return this.reporting;
    if (!this.sessionId || !this.diagnostics) return Promise.resolve();
    this.reporting = fetch(`${RELAY_URL}/api/diagnostics/${this.sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...this.diagnostics, atUnixMs: Date.now() }),
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    })
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.reporting = undefined;
      });
    return this.reporting;
  }
  private async stopData(): Promise<void> {
    if (this.data) {
      await this.data.stop();
      if (this.socket?.readyState === WebSocket.OPEN) await this.rpc('release', { iface: 1 }).catch(() => {});
    }
    clearInterval(this.diagnosticsTimer);
    this.diagnosticsTimer = undefined;
    if (this.diagnostics) {
      this.diagnostics.endedUnixMs = Date.now();
      await this.reporting;
      await this.reportDiagnostics();
    }
    this.data = undefined;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.opened = false;
    this.closing = (async () => {
      try {
        await this.stopData();
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
    if (iface === 1) await this.stopData();
    await this.rpc('release', { iface });
  }
  async selectAlternateInterface(iface: number, alternate: number): Promise<void> {
    if (iface === 1) {
      const hadData = Boolean(this.data);
      await this.stopData();
      if (hadData) await this.rpc('claim', { iface });
    }
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
    if (!this.data) {
      const diagnostics = new RelayDiagnostics();
      this.diagnostics = diagnostics;
      this.data = new RelayData(`${RELAY_URL.replace('http:', 'ws:')}/data/${this.sessionId}/130`);
      diagnostics.websocket = this.data.metrics;
      this.diagnosticsTimer = setInterval(() => {
        const at = performance.now();
        diagnostics.heartbeat.add(diagnostics.lastBeat, at - diagnostics.lastBeat);
        diagnostics.lastBeat = at;
        void this.reportDiagnostics();
      }, 500);
    }
    return this.data.read(length).then((value) => ({ status: 'ok', data: value }));
  }
  consumeTransfer(value: DataView): void {
    this.data?.consume(value);
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
