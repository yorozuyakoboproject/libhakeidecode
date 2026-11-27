import { SampleRing } from './sample-ring.js';
import { sampleIndex } from '../libhakei/sample-index.js';
import type { SampleStore } from './data/types.js';
import { prepareDigitalView } from './digital-view.js';
import type { WaveformRequest, WaveformResponse } from './rolling-waveform.js';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<WaveformRequest>) => void;
  postMessage(message: WaveformResponse, transfer?: Transferable[]): void;
};
let ring: SampleRing | undefined;
scope.onmessage = ({ data }) => {
  if (data.type === 'pages') {
    ring?.patch(data.pages);
    return;
  }
  try {
    ring ??= new SampleRing(
      data.snapshot.capacity,
      true,
      undefined,
      data.snapshot.bytesPerSample,
      data.snapshot.pageSamples,
    );
    ring.accept(data.snapshot);
    const reader = ring;
    const store: SampleStore & { channelRange(channel: number, start: bigint, end: bigint): Uint8Array } = {
      channelCount: data.channels,
      samplerate: data.rate,
      length: BigInt(reader.length),
      query: (channel, start, end, bins) =>
        reader.query(channel, Number(sampleIndex(start)), Number(sampleIndex(end)), bins, data.channels > 0),
      edges: (channel, start, end) => {
        const a = Math.max(1, Number(sampleIndex(start))),
          b = Number(sampleIndex(end));
        return b > a ? reader.channelEdges(channel, a, b, Infinity)! : [];
      },
      channelRange: (channel, start, end) => reader.channelRange(channel, Number(start), Number(end)),
      gaps: () => [],
      append: () => {
        throw new Error('Read-only waveform view');
      },
      noteGap: () => {
        throw new Error('Read-only waveform view');
      },
    };
    const started = performance.now();
    const result = prepareDigitalView(store, data.request),
      transfer: Transferable[] = [];
    for (const view of result.views)
      transfer.push(
        view.low.buffer,
        view.high.buffer,
        view.edge.buffer,
        view.packed.buffer,
        ...(view.points ? [view.points.buffer] : []),
      );
    scope.postMessage({ type: 'result', result, elapsedMs: performance.now() - started }, transfer);
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
scope.postMessage({ type: 'ready' });
