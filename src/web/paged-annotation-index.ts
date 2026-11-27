import { AnnotationIndex } from './event-index.js';
import type { Annotation } from './protocol.js';
import type { DecodeClient } from './decode-client.js';
import { samplePosition, type SampleInput } from '../libhakei/sample-index.js';

const LIVE_REFRESH_MIN_INTERVAL_MS = 140;

export class PagedAnnotationIndex extends AnnotationIndex {
  private records: Annotation[] = [];
  private sequence = 0;
  private total = 0;
  private revision = 0;
  private cachedKey = '';
  private cachedRange = '';
  private cachedOffset = 0n;
  private cachedBytes = 0;
  private lastQueryAt = -Infinity;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private queryPendingKey = '';
  private queryPending: Promise<void> | null = null;
  private queuedRequest: {
    start: bigint;
    end: bigint;
    maxResults: number;
    rangeKey: string;
    key: string;
  } | null = null;
  private queuedPromise: Promise<void> | null = null;
  private resolveQueued: (() => void) | null = null;
  constructor(
    private client: DecodeClient,
    private readonly instanceId?: string,
    private readonly onChange?: () => void,
  ) {
    super();
  }
  private clearThrottle(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }
  private clearQueued(): void {
    this.queuedRequest = null;
    const resolve = this.resolveQueued;
    this.resolveQueued = null;
    this.queuedPromise = null;
    resolve?.();
  }
  bind(client: DecodeClient): void {
    if (this.client === client) return;
    this.client = client;
    this.records = [];
    this.cachedBytes = 0;
    this.cachedRange = '';
    this.cachedOffset = 0n;
    this.lastQueryAt = -Infinity;
    this.clearThrottle();
    this.sequence++;
    this.invalidate();
    this.queryPending = null;
    this.queryPendingKey = '';
    this.clearQueued();
  }
  override get reservedBytes(): number {
    return this.cachedBytes;
  }
  override get length(): number {
    return this.total;
  }
  setTotal(annotations: number): void {
    if (this.total !== annotations) {
      this.total = annotations;
      this.revision++;
      this.cachedKey = '';
    }
  }
  invalidate(): void {
    this.revision++;
    this.cachedKey = '';
    this.cachedRange = '';
    this.lastQueryAt = -Infinity;
    this.clearThrottle();
  }
  override append(_records: Annotation[]): void {}
  override clear(): void {
    this.records = [];
    this.cachedBytes = 0;
    this.total = 0;
    this.sequence++;
    this.revision++;
    this.cachedKey = '';
    this.cachedRange = '';
    this.cachedOffset = 0n;
    this.lastQueryAt = -Infinity;
    this.clearThrottle();
    this.queryPending = null;
    this.queryPendingKey = '';
    this.clearQueued();
    this.onChange?.();
  }
  override query(startInput: SampleInput, endInput: SampleInput, maxResults = Number.MAX_SAFE_INTEGER): Annotation[] {
    const records = this.records;
    if (!records.length) return [];
    const offset = this.client.sampleOffset;
    const start = samplePosition(startInput) + offset,
      end = samplePosition(endInput) + offset;
    const out: Annotation[] = [];
    for (let i = 0; i < records.length && out.length < maxResults; i++) {
      const item = records[i]!;
      if (item.es >= start && item.ss <= end) {
        out.push(offset === 0n ? item : { ...item, ss: item.ss - offset, es: item.es - offset });
      }
    }
    return out;
  }
  private startQuery(
    start: bigint,
    end: bigint,
    maxResults: number,
    offset: bigint,
    rangeKey: string,
    key: string,
  ): Promise<void> {
    const sequence = ++this.sequence;
    this.clearThrottle();
    this.queryPendingKey = key;
    this.lastQueryAt = performance.now();
    const task = this.client
      .queryAnnotationsRaw(start + offset, end + offset, maxResults, this.instanceId)
      .then((records) => {
        if (sequence === this.sequence) {
          this.records = records;
          let bytes = 0;
          for (let i = 0; i < records.length; i++) {
            const texts = records[i]!.texts;
            bytes += 40;
            for (let j = 0; j < texts.length; j++) bytes += texts[j]!.length * 2 + 2;
          }
          this.cachedBytes = bytes;
          this.cachedKey = key;
          this.cachedRange = rangeKey;
          this.cachedOffset = offset;
          this.lastQueryAt = performance.now();
          this.onChange?.();
        }
      })
      .catch((error) => {
        if (this.client.available) throw error;
        if (sequence === this.sequence) {
          this.records = [];
          this.cachedBytes = 0;
        }
      })
      .finally(() => {
        if (this.queryPending !== task) return;
        this.queryPending = null;
        this.queryPendingKey = '';
        const next = this.queuedRequest;
        const resolve = this.resolveQueued;
        this.queuedRequest = null;
        this.resolveQueued = null;
        this.queuedPromise = null;
        if (next && this.client.available) {
          const freshOffset = this.client.sampleOffset;
          const freshKey = `${next.rangeKey}:${this.revision}:${freshOffset}`;
          if (freshKey !== this.cachedKey) {
            void this.startQuery(next.start, next.end, next.maxResults, freshOffset, next.rangeKey, freshKey)
              .catch(() => {})
              .finally(() => resolve?.());
            return;
          }
        }
        resolve?.();
      });
    this.queryPending = task;
    return task;
  }
  override prepareView(startInput: SampleInput, endInput: SampleInput, maxResults: number): Promise<void> {
    if (!this.client.available) {
      if (this.records.length) {
        this.records = [];
        this.cachedBytes = 0;
      }
      return Promise.resolve();
    }
    const start = samplePosition(startInput),
      end = samplePosition(endInput),
      offset = this.client.sampleOffset,
      rangeKey = `${start}:${end}:${maxResults}`,
      key = `${rangeKey}:${this.revision}:${offset}`;
    if (key === this.cachedKey) return Promise.resolve();
    const elapsed = performance.now() - this.lastQueryAt;
    if (
      rangeKey === this.cachedRange &&
      offset === this.cachedOffset &&
      (this.records.length > 0 || this.total === 0) &&
      elapsed < LIVE_REFRESH_MIN_INTERVAL_MS
    ) {
      if (this.throttleTimer === null) {
        this.throttleTimer = setTimeout(
          () => {
            this.throttleTimer = null;
            this.onChange?.();
          },
          Math.max(16, Math.ceil(LIVE_REFRESH_MIN_INTERVAL_MS - elapsed)),
        );
      }
      return Promise.resolve();
    }
    if (this.queryPending) {
      if (key === this.queryPendingKey) return this.queryPending;
      this.queuedRequest = { start, end, maxResults, rangeKey, key };
      this.queuedPromise ??= new Promise<void>((resolve) => {
        this.resolveQueued = resolve;
      });
      return this.queuedPromise;
    }
    return this.startQuery(start, end, maxResults, offset, rangeKey, key);
  }
}
