import type { DriverDefinition } from '../drivers/definition.js';
import { restoreComponentError } from '../components.js';
import type { DeviceConfiguration, DeviceConfigurationState, DeviceDescriptor } from '../libhakei/device.js';
import type {
  DeviceCommand,
  DeviceControl,
  DeviceRequest,
  DeviceResponse,
  DeviceState,
  WorkerAcquisitionDescription,
} from './device-protocol.js';

type Result = Extract<DeviceResponse, { type: 'result' }>;
export class DeviceClient implements DeviceControl {
  onConnectionChange: (() => void) | null = null;
  private state: DeviceState;
  private worker: Worker | null = null;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      type: DeviceCommand['type'];
      resolve(value: Result): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly definition: DriverDefinition) {
    this.state = { descriptor: definition.descriptor, connected: definition.connection ? false : undefined };
  }
  get descriptor(): DeviceDescriptor {
    return this.state.descriptor;
  }
  get connected(): boolean | undefined {
    return this.state.connected;
  }
  private get preferenceKey(): string {
    return 'hakei.driver.' + this.descriptor.id;
  }
  async restore(): Promise<boolean> {
    if (!this.definition.connection?.autoRestore || this.connected) return this.connected !== false;
    let initialization: unknown;
    try {
      initialization = JSON.parse(localStorage.getItem(this.preferenceKey) ?? 'null');
    } catch {}
    const result = await this.request({ type: 'restore', initialization });
    return result.restored ?? false;
  }
  async connect(): Promise<void> {
    if (!this.definition.connection) return;
    const initialization = await this.definition.connection.authorize(this.state.initialization);
    await this.request({ type: 'connect', initialization });
  }
  async disconnect(): Promise<void> {
    await this.request({ type: 'disconnect' });
  }
  async setTransport(mode?: string, port?: number): Promise<void> {
    await this.request({ type: 'transport', mode, ...(port === undefined ? {} : { port }) });
  }
  async configure(configuration: DeviceConfiguration): Promise<DeviceConfigurationState> {
    const result = await this.request({ type: 'configure', configuration });
    if (!result.settings) throw new Error('Device Worker returned no configuration');
    return result.settings;
  }
  async prepare(configuration: DeviceConfiguration): Promise<WorkerAcquisitionDescription> {
    const result = await this.request({ type: 'prepare', configuration });
    if (!result.description) throw new Error('Device Worker returned no acquisition description');
    return result.description;
  }
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Device client disposed'));
    }
    this.pending.clear();
  }
  private update(state: DeviceState, notify = true): void {
    this.state = state;
    try {
      if (state.initialization !== undefined)
        localStorage.setItem(this.preferenceKey, JSON.stringify(state.initialization));
    } catch {}
    if (notify) this.onConnectionChange?.();
  }
  private fail(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.update({ descriptor: this.definition.descriptor, connected: this.definition.connection ? false : undefined });
  }
  private request(command: DeviceCommand): Promise<Result> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./device-control-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<DeviceResponse>) => {
        if (data.type === 'state') {
          this.update(data.state);
          return;
        }
        const item = this.pending.get(data.requestId);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(data.requestId);
        if (data.type === 'error') item.reject(restoreComponentError(data));
        else {
          this.update(data.state, item.type !== 'configure' && item.type !== 'prepare');
          item.resolve(data);
        }
      };
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.fail(new Error(event.message));
      };
      this.worker.onmessageerror = () => this.fail(new Error('Device Worker message could not be read'));
    }
    const worker = this.worker,
      requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Device Worker did not respond')), 15_000);
      this.pending.set(requestId, { type: command.type, resolve, reject, timer });
      try {
        worker.postMessage({ ...command, requestId, driverId: this.descriptor.id } satisfies DeviceRequest);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
