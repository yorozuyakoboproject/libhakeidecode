const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
};
let socket: WebSocket | undefined;
scope.onmessage = ({ data }) => {
  if (data.type === 'connect') {
    if (socket) throw new Error('USB relay receive Worker is already connected');
    socket = new WebSocket(data.url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => scope.postMessage({ type: 'open' });
    socket.onmessage = ({ data }) => {
      if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 1024 * 1024) {
        scope.postMessage({ type: 'error', message: 'Invalid USB relay data message' });
        socket?.close();
        return;
      }
      scope.postMessage({ type: 'data', data }, [data]);
    };
    socket.onerror = () =>
      scope.postMessage({
        type: 'error',
        message: 'USB relay data connection failed; check relay version and interface ownership',
      });
    socket.onclose = () => {
      scope.postMessage({ type: 'closed' });
      scope.close();
    };
  } else if (data.type === 'ack' && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ consumedBytes: data.consumedBytes }));
  } else if (data.type === 'close') socket?.close();
};
