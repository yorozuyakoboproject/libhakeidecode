export const DEFAULT_CAPTURE_BUDGET_BYTES = Number.MAX_SAFE_INTEGER;
export class MemoryBudgetError extends Error {
  constructor(
    readonly requestedBytes: number,
    readonly availableBytes: number,
    readonly label: string,
  ) {
    super(`Explicit allocation limit reached: ${label} needs ${requestedBytes} bytes, ${availableBytes} available`);
    this.name = 'MemoryBudgetError';
  }
}
export class SampleAllocationError extends Error {
  constructor(
    readonly label: string,
    cause: unknown,
  ) {
    super(`Sample allocation failed: ${label}`, { cause });
    this.name = 'SampleAllocationError';
  }
}
export interface BudgetSnapshot {
  limitBytes: number;
  usedBytes: number;
  peakBytes: number;
  allocations: number;
}

export class MemoryBudget {
  private used = 0;
  private peak = 0;
  private count = 0;
  private readonly buffers = new WeakMap<object, () => void>();
  constructor(
    readonly limitBytes = DEFAULT_CAPTURE_BUDGET_BYTES,
    private readonly allocateBuffer: (bytes: number, label: string) => ArrayBuffer = (bytes) => new ArrayBuffer(bytes),
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0)
      throw new RangeError('Allocation limit must be a nonnegative safe integer');
  }
  reserve(bytes: number, label: string): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError('Reservation must be a nonnegative safe integer');
    if (bytes > this.limitBytes - this.used) throw new MemoryBudgetError(bytes, this.limitBytes - this.used, label);
    this.used += bytes;
    this.peak = Math.max(this.peak, this.used);
    this.count++;
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.used -= bytes;
      }
    };
  }
  allocate(bytes: number, label: string): ArrayBuffer {
    const release = this.reserve(bytes, label);
    try {
      const buffer = this.allocateBuffer(bytes, label);
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== bytes)
        throw new Error('Allocator returned an invalid buffer');
      this.buffers.set(buffer, release);
      return buffer;
    } catch (error) {
      release();
      if (error instanceof RangeError) throw new SampleAllocationError(label, error);
      throw error;
    }
  }
  release(buffer: object): void {
    this.buffers.get(buffer)?.();
    this.buffers.delete(buffer);
  }
  snapshot(): BudgetSnapshot {
    return { limitBytes: this.limitBytes, usedBytes: this.used, peakBytes: this.peak, allocations: this.count };
  }
}
export function recoverableMemoryError(error: unknown): error is MemoryBudgetError | SampleAllocationError {
  return error instanceof MemoryBudgetError || error instanceof SampleAllocationError;
}
