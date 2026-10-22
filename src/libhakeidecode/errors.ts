export class DecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DecodeError';
  }
}
export class EOFError extends Error {
  constructor() {
    super('samples exhausted');
    this.name = 'EOFError';
  }
}
export class SampleGapError extends DecodeError {
  readonly expected: bigint;
  readonly actual: bigint;
  constructor(expected: bigint, actual: bigint) {
    super(`Sample discontinuity: expected ${expected}, received ${actual}.`);
    this.name = 'SampleGapError';
    this.expected = expected;
    this.actual = actual;
  }
}
export function sampleNumber(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new DecodeError(`${name} must be a non-negative bigint.`);
  return value;
}
