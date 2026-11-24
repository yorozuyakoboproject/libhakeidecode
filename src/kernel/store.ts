import type { InstalledPackageRecord, PluginDataStore, PluginStateRecord } from './types.js';

const DB_NAME = 'hakei-plugins';
const DB_VERSION = 1;
const PACKAGES_STORE = 'packages';
const STATES_STORE = 'states';
const DATA_STORE = 'data';
const PROVIDERS_KEY = '__kernel__:providers';

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class PluginPackageStore {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private readonly memPackages = new Map<string, InstalledPackageRecord>();
  private readonly memStates = new Map<string, PluginStateRecord>();
  private readonly memData = new Map<string, unknown>();

  private open(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === 'undefined') {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }
    this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(PACKAGES_STORE)) db.createObjectStore(PACKAGES_STORE, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(STATES_STORE)) db.createObjectStore(STATES_STORE, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async listPackages(): Promise<InstalledPackageRecord[]> {
    const db = await this.open();
    if (!db) return [...this.memPackages.values()];
    const tx = db.transaction(PACKAGES_STORE, 'readonly');
    return requestPromise(tx.objectStore(PACKAGES_STORE).getAll() as IDBRequest<InstalledPackageRecord[]>);
  }

  async getPackage(id: string): Promise<InstalledPackageRecord | undefined> {
    const db = await this.open();
    if (!db) return this.memPackages.get(id);
    const tx = db.transaction(PACKAGES_STORE, 'readonly');
    return requestPromise(tx.objectStore(PACKAGES_STORE).get(id) as IDBRequest<InstalledPackageRecord | undefined>);
  }

  async putPackage(record: InstalledPackageRecord): Promise<void> {
    const db = await this.open();
    if (!db) {
      this.memPackages.set(record.id, record);
      return;
    }
    const tx = db.transaction(PACKAGES_STORE, 'readwrite');
    tx.objectStore(PACKAGES_STORE).put(record);
    await txDone(tx);
  }

  async deletePackage(id: string): Promise<void> {
    const db = await this.open();
    if (!db) {
      this.memPackages.delete(id);
      return;
    }
    const tx = db.transaction(PACKAGES_STORE, 'readwrite');
    tx.objectStore(PACKAGES_STORE).delete(id);
    await txDone(tx);
  }

  async listStates(): Promise<PluginStateRecord[]> {
    const db = await this.open();
    if (!db) return [...this.memStates.values()];
    const tx = db.transaction(STATES_STORE, 'readonly');
    return requestPromise(tx.objectStore(STATES_STORE).getAll() as IDBRequest<PluginStateRecord[]>);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record: PluginStateRecord = { id, enabled };
    const db = await this.open();
    if (!db) {
      this.memStates.set(id, record);
      return;
    }
    const tx = db.transaction(STATES_STORE, 'readwrite');
    tx.objectStore(STATES_STORE).put(record);
    await txDone(tx);
  }

  async deleteState(id: string): Promise<void> {
    const db = await this.open();
    if (!db) {
      this.memStates.delete(id);
      return;
    }
    const tx = db.transaction(STATES_STORE, 'readwrite');
    tx.objectStore(STATES_STORE).delete(id);
    await txDone(tx);
  }

  async clearStates(): Promise<void> {
    const db = await this.open();
    if (!db) {
      this.memStates.clear();
      return;
    }
    const tx = db.transaction(STATES_STORE, 'readwrite');
    tx.objectStore(STATES_STORE).clear();
    await txDone(tx);
  }

  async getProviders(): Promise<Record<string, string>> {
    const value = await this.getData<Record<string, string>>(PROVIDERS_KEY);
    return value && typeof value === 'object' ? { ...value } : {};
  }

  async setProviders(providers: Record<string, string>): Promise<void> {
    await this.setData(PROVIDERS_KEY, { ...providers });
  }

  async getData<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.open();
    if (!db) return this.memData.get(key) as T | undefined;
    const tx = db.transaction(DATA_STORE, 'readonly');
    const row = await requestPromise(
      tx.objectStore(DATA_STORE).get(key) as IDBRequest<{ key: string; value: T } | undefined>,
    );
    return row?.value;
  }

  async setData<T = unknown>(key: string, value: T): Promise<void> {
    const db = await this.open();
    if (!db) {
      this.memData.set(key, value);
      return;
    }
    const tx = db.transaction(DATA_STORE, 'readwrite');
    tx.objectStore(DATA_STORE).put({ key, value });
    await txDone(tx);
  }

  async deleteData(key: string): Promise<void> {
    const db = await this.open();
    if (!db) {
      this.memData.delete(key);
      return;
    }
    const tx = db.transaction(DATA_STORE, 'readwrite');
    tx.objectStore(DATA_STORE).delete(key);
    await txDone(tx);
  }

  async listDataKeys(prefix: string): Promise<string[]> {
    const db = await this.open();
    if (!db)
      return [...this.memData.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    const tx = db.transaction(DATA_STORE, 'readonly');
    const all = await requestPromise(tx.objectStore(DATA_STORE).getAllKeys() as IDBRequest<string[]>);
    return all
      .filter((key) => typeof key === 'string' && key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  pluginData(pluginId: string): PluginDataStore {
    const prefix = `plugin:${pluginId}:`;
    return {
      get: <T = unknown>(key: string) => this.getData<T>(prefix + key),
      set: <T = unknown>(key: string, value: T) => this.setData(prefix + key, value),
      delete: (key: string) => this.deleteData(prefix + key),
      keys: () => this.listDataKeys(prefix),
    };
  }
}
