import { compressZipData } from './zip-codec.js';

globalThis.onmessage = async ({
  data,
}: MessageEvent<{
  id: number;
  data: Uint8Array;
  compression?: 'store' | 'deflate';
}>) => {
  try {
    const result = await compressZipData(data.data, data.compression);
    globalThis.postMessage({ id: data.id, ...result }, { transfer: [result.payload.buffer as ArrayBuffer] });
  } catch (error) {
    globalThis.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
