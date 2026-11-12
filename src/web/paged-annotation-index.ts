import { AnnotationIndex } from './event-index.js';
import type { Annotation } from './protocol.js';
import type { DecodeClient } from './decode-client.js';
import { samplePosition, type SampleInput } from '../libhakei/sample-index.js';

export class PagedAnnotationIndex extends AnnotationIndex {
  private records: Annotation[] = [];
  private sequence = 0;
  private total = 0;
  private revision = 0;
  private cachedKey = '';
  private cachedOffset = 0n;
  private queryPendingKey = '';
  private queryPending: Promise<void> | null = null;
  constructor(
    private client: DecodeClient,
    private readonly instanceId?: string,
    private readonly onChange?: () => void,
  ) {
    super();
  }
  bind(client: DecodeClient): void {
    if (this.client === client) return;
    this.client = client;
    this.records = [];
    this.sequence++;
    this.invalidate();
    this.queryPending = null;
    this.queryPendingKey = '';
  }
  override get reservedBytes(): number {
    return this.records.reduce(
      (bytes, item) => bytes + 40 + item.texts.reduce((sum, text) => sum + text.length * 2 + 2, 0),
      0,
    );
  }
  override get length(): number {
    return this.total;
  }
  setTotal(annotations: number): void {
    if (this.total !== annotations) {
      this.total = annotations;
      this.invalidate();
    }
  }
  invalidate(): void {
    this.revision++;
    this.cachedKey = '';
  }
  override append(_records: Annotation[]): void {}
  override clear(): void {
    this.records = [];
    this.total = 0;
    this.sequence++;
    this.revision++;
    this.cachedKey = '';
    this.queryPending = null;
    this.onChange?.();
  }
  override query(startInput: SampleInput, endInput: SampleInput, maxResults = Number.MAX_SAFE_INTEGER): Annotation[] {
    if (this.cachedOffset !== this.client.sampleOffset) return [];
    const start = samplePosition(startInput),
      end = samplePosition(endInput);
    return this.records.filter((item) => item.es >= start && item.ss <= end).slice(0, maxResults);
  }
  override prepareView(startInput: SampleInput, endInput: SampleInput, maxResults: number): Promise<void> {
    if (!this.client.available) {
      this.records = [];
      return Promise.resolve();
    }
    const start = samplePosition(startInput),
      end = samplePosition(endInput),
      offset = this.client.sampleOffset,
      key = `${start}:${end}:${maxResults}:${this.revision}:${offset}`;
    if (key === this.cachedKey) return Promise.resolve();
    if (key === this.queryPendingKey && this.queryPending) return this.queryPending;
    const sequence = ++this.sequence;
    this.queryPendingKey = key;
    const task = this.client
      .queryAnnotations(start, end, maxResults, this.instanceId)
      .then((records) => {
        if (sequence === this.sequence && offset === this.client.sampleOffset) {
          this.records = records;
          this.cachedKey = key;
          this.cachedOffset = offset;
          this.onChange?.();
        } else if (sequence === this.sequence) this.onChange?.();
      })
      .catch((error) => {
        if (this.client.available) throw error;
        if (sequence === this.sequence) this.records = [];
      })
      .finally(() => {
        if (this.queryPending === task) {
          this.queryPending = null;
          this.queryPendingKey = '';
        }
      });
    this.queryPending = task;
    return task;
  }
}
