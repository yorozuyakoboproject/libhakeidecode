export type ComponentLocale = 'en' | 'zh-CN';
export interface ComponentMessages {
  readonly en: Readonly<Record<string, string>>;
  readonly 'zh-CN'?: Readonly<Record<string, string>>;
}
export interface ComponentFailure {
  readonly message: string;
  readonly key?: string;
  readonly params?: Record<string, string | number>;
}
export class ComponentError extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(key);
    this.name = 'ComponentError';
  }
}
export function componentFailure(error: unknown): ComponentFailure {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof ComponentError ? { key: error.key, params: error.params } : {}),
  };
}
export function restoreComponentError(failure: ComponentFailure): Error {
  return failure.key ? new ComponentError(failure.key, failure.params) : new Error(failure.message);
}
