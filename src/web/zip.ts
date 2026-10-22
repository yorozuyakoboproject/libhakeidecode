const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export interface ZipEntry {
  name: string;
  data: Uint8Array;
  compression?: 'store' | 'deflate';
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
async function transform(
  data: Uint8Array,
  mode: 'compress' | 'decompress',
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const stream = mode === 'compress' ? new CompressionStream('deflate-raw') : new DecompressionStream('deflate-raw');
  const reader = new Blob([data.slice().buffer]).stream().pipeThrough(stream).getReader();
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
export async function writeZip(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  signal?: AbortSignal,
): Promise<Blob> {
  const parts: BlobPart[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for await (const { name, data, compression = 'deflate' } of entries) {
    signal?.throwIfAborted();
    const filename = encoder.encode(name),
      crc = crc32(data);
    const compressed =
      compression === 'store'
        ? data
        : await transform(data, 'compress', data.length + Math.ceil(data.length / 1000) + 1024, signal);
    const payload = compressed.length < data.length ? compressed : data,
      method = payload === data ? 0 : 8;
    const local = new Uint8Array(30 + filename.length),
      header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x800, true);
    header.setUint16(8, method, true);
    header.setUint16(12, 33, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, payload.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, filename.length, true);
    local.set(filename, 30);
    const payloadPart =
      payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength
        ? (payload.buffer as ArrayBuffer)
        : payload.slice().buffer;
    parts.push(local.buffer, payloadPart);
    const directory = new Uint8Array(46 + filename.length),
      view = new DataView(directory.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x800, true);
    view.setUint16(10, method, true);
    view.setUint16(14, 33, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, payload.length, true);
    view.setUint32(24, data.length, true);
    view.setUint16(28, filename.length, true);
    view.setUint32(42, offset, true);
    directory.set(filename, 46);
    central.push(directory);
    offset += local.length + payload.length;
    if (offset > 0xffffffff || central.length > 65535) throw new Error('ZIP32 limit exceeded');
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22),
    view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, central.length, true);
  view.setUint16(10, central.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  return new Blob([...parts, ...central.map((part) => part.buffer as ArrayBuffer), end.buffer], {
    type: 'application/zip',
  });
}
export interface ZipMember {
  name: string;
  size: number;
  read(signal?: AbortSignal): Promise<Uint8Array>;
}
export async function readZip(
  file: Blob,
  maxSize = 256 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<Map<string, ZipMember>> {
  signal?.throwIfAborted();
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer()),
    view = new DataView(tail.buffer);
  let end = tail.length - 22;
  for (; end >= 0; end--)
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === tail.length) break;
  if (end < 0) throw new Error('Invalid ZIP directory');
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count > 4096 ||
    size > 4 * 1024 * 1024 ||
    offset + size !== file.size - tail.length + end
  )
    throw new Error('Unsupported ZIP directory');
  const directory = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()),
    dv = new DataView(directory.buffer);
  const members = new Map<string, ZipMember>();
  let pos = 0,
    total = 0;
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    if (pos + 46 > size || dv.getUint32(pos, true) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = dv.getUint16(pos + 8, true),
      method = dv.getUint16(pos + 10, true),
      crc = dv.getUint32(pos + 16, true);
    const packed = dv.getUint32(pos + 20, true),
      length = dv.getUint32(pos + 24, true),
      localOffset = dv.getUint32(pos + 42, true);
    const nameLength = dv.getUint16(pos + 28, true),
      extraLength = dv.getUint16(pos + 30, true),
      commentLength = dv.getUint16(pos + 32, true);
    if (
      pos + 46 + nameLength + extraLength + commentLength > size ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      dv.getUint16(pos + 34, true) ||
      length > maxSize ||
      (total += length) > maxSize + 2 * 1024 * 1024
    )
      throw new Error('Unsupported or oversized ZIP entry');
    const name = decoder.decode(directory.subarray(pos + 46, pos + 46 + nameLength));
    if (!name || members.has(name)) throw new Error('Duplicate ZIP entry');
    members.set(name, {
      name,
      size: length,
      async read(readSignal = signal) {
        readSignal?.throwIfAborted();
        if (localOffset + 30 > offset) throw new Error('Invalid ZIP entry offset');
        const local = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
        if (
          local.getUint32(0, true) !== 0x04034b50 ||
          local.getUint16(6, true) !== flags ||
          local.getUint16(8, true) !== method
        )
          throw new Error('Invalid ZIP local header');
        const localNameLength = local.getUint16(26, true),
          start = localOffset + 30 + localNameLength + local.getUint16(28, true);
        if (start + packed > offset) throw new Error('Invalid ZIP payload bounds');
        const localName = decoder.decode(
          await file.slice(localOffset + 30, localOffset + 30 + localNameLength).arrayBuffer(),
        );
        if (localName !== name) throw new Error('ZIP entry name mismatch');
        const bytes = new Uint8Array(await file.slice(start, start + packed).arrayBuffer());
        readSignal?.throwIfAborted();
        const data = method === 8 ? await transform(bytes, 'decompress', length, readSignal) : bytes;
        if (data.length !== length || crc32(data) !== crc) throw new Error('ZIP checksum or length mismatch');
        return data;
      },
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  if (pos !== size) throw new Error('Invalid ZIP directory length');
  return members;
}
