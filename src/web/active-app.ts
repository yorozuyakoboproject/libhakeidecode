import type { AnalyzerApp } from './workbench-app.js';

let active: AnalyzerApp | null = null;
const listeners = new Set<(app: AnalyzerApp | null) => void>();

export function setActiveApp(app: AnalyzerApp | null): void {
  active = app;
  for (const listener of listeners) listener(app);
}

export function getActiveApp(): AnalyzerApp | null {
  return active;
}

export function bindActiveApp(listener: (app: AnalyzerApp | null) => void): () => void {
  listeners.add(listener);
  if (active) listener(active);
  return () => listeners.delete(listener);
}
