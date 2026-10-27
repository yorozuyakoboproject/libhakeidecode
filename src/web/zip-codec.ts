const table = new Uint32Array(8 * 256);
for (let n = 0; n < 256; n++) {
  let crc = n;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  table[n] = crc;
}
for (let layer = 1; layer < 8; layer++)
  for (let n = 0; n < 256; n++) {
    const crc = table[(layer - 1) * 256 + n]!;
    table[layer * 256 + n] = table[crc & 255]! ^ (crc >>> 8);
  }
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff,
    offset = 0;
  for (; offset + 8 <= data.length; offset += 8) {
    const word = crc ^ data[offset]! ^ (data[offset + 1]! << 8) ^ (data[offset + 2]! << 16) ^ (data[offset + 3]! << 24);
    crc =
      table[1792 + (word & 255)]! ^
      table[1536 + ((word >>> 8) & 255)]! ^
      table[1280 + ((word >>> 16) & 255)]! ^
      table[1024 + (word >>> 24)]! ^
      table[768 + data[offset + 4]!]! ^
      table[512 + data[offset + 5]!]! ^
      table[256 + data[offset + 6]!]! ^
      table[data[offset + 7]!]!;
  }
  for (; offset < data.length; offset++) crc = table[(crc ^ data[offset]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export async function transform(
  data: Uint8Array,
  mode: 'compress' | 'decompress',
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const stream = mode === 'compress' ? new CompressionStream('deflate-raw') : new DecompressionStream('deflate-raw');
  const reader = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(
        data.buffer instanceof ArrayBuffer
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : data.slice(),
      );
      controller.close();
    },
  })
    .pipeThrough(stream)
    .getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  const abort = (): void => {
    void reader.cancel(signal?.reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('ZIP entry exceeds its declared size or resource limit');
      parts.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
}
export async function compressZipData(
  data: Uint8Array,
  compression: 'store' | 'deflate' = 'deflate',
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const crc = crc32(data),
    compressed =
      compression === 'store'
        ? data
        : await transform(data, 'compress', data.length + Math.ceil(data.length / 1000) + 1024, signal),
    payload = compressed.length < data.length ? compressed : data;
  return { crc, payload, method: payload === data ? 0 : 8 };
}
