const taskYieldChannel = new MessageChannel();
let taskYieldResolve: (() => void) | null = null;

taskYieldChannel.port1.onmessage = () => {
  const resolve = taskYieldResolve;
  taskYieldResolve = null;
  resolve?.();
};

export function yieldWorkerTask(): Promise<void> {
  return new Promise((resolve) => {
    taskYieldResolve = resolve;
    taskYieldChannel.port2.postMessage(0);
  });
}
