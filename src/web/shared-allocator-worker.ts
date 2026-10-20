type Request = { id: number; byteLength: number };
type Response = { id: number; buffer?: SharedArrayBuffer; error?: string };
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(message: Response): void };
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ id: data.id, buffer: new SharedArrayBuffer(data.byteLength) }); }
  catch (error) { scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
};
