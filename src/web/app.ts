import './preferences.js';
import { KernelRuntime } from '../kernel/kernel.js';
import { showStartupError } from '../kernel/startup.js';
import { builtinPlugins } from '../plugins/builtins.js';
import { bindActiveApp } from './active-app.js';
import type { AnalyzerApp } from './workbench-app.js';

export { AnalyzerApp, element, type ProtocolInstance } from './workbench-app.js';

export let app!: AnalyzerApp;
export let kernel!: KernelRuntime;

bindActiveApp((instance) => {
  if (instance) app = instance;
});

const recoveryMode = new URLSearchParams(location.search).get('pluginRecovery') === '1';
kernel = new KernelRuntime(recoveryMode);
kernel.registerBuiltins(builtinPlugins);
try {
  await kernel.start();
} catch (error) {
  showStartupError('Hakei failed to boot', error instanceof Error ? error.message : String(error));
  throw error;
}
