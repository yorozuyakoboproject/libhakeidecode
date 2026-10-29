import { sampleIndex, minSample, localNumber, stringifySamples } from '../libhakei/sample-index.js';
import { AnalogSampleStore, type AnalogStore } from './data/analogStore.js';
import { TimedAnalogStore, PendingAnalogStore } from './data/timed-analogStore.js';
import type { AnalogTiming } from '../libhakei/device.js';
import { PlanarSampleStore } from './data/planarStore.js';
import { RleSampleStore } from './data/rleStore.js';
import { splitAroundGaps } from './data/gaps.js';
import { validRate, validWidth, parseAcquisitionResult } from './capture-metadata.js';
import type { Capture } from './capture.js';
import { parseWorkspace, type WorkspaceSettings } from './workspace.js';
import { readZip, writeZip, type ZipEntry } from './zip.js';
import { UIError } from './i18n.js';
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
function parseINI(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>();
  let section: Record<string, string> | null = null;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      if (sections.has(header[1])) throw new Error('Duplicate metadata section');
      section = Object.create(null) as Record<string, string>;
      sections.set(header[1], section);
    } else {
      const key = /^\s*([^=]+?)\s*=(.*)$/.exec(line);
      if (!key || !section || Object.hasOwn(section, key[1])) throw new Error('Invalid metadata');
      section[key[1]] = key[2].trim();
    }
  }
  return sections;
}
function unescapeINI(text: string): string {
  return text.replace(/\\([snrt\\])/g, (_, c: string) => ({ s: ' ', n: '\n', r: '\r', t: '\t', '\\': '\\' })[c]!);
}
function escapeINI(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/^ /, '\\s')
    .replace(/ $/, '\\s');
}
function rate(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kMG]?)\s*(?:Hz)?$/i.exec(text ?? '');
  if (!match) throw new UIError('error.rate');
  return validRate(
    Number(match[1]) * { '': 1, k: 1e3, m: 1e6, g: 1e9 }[match[2].toLowerCase() as '' | 'k' | 'm' | 'g'],
  );
}
function numberedChunks(
  members: Map<string, import('./zip.js').ZipMember>,
  prefix: string,
): import('./zip.js').ZipMember[] {
  const chunks = [...members.values()]
    .filter((member) => member.name.startsWith(prefix + '-') && /^\d+$/.test(member.name.slice(prefix.length + 1)))
    .sort((a, b) => Number(a.name.slice(prefix.length + 1)) - Number(b.name.slice(prefix.length + 1)));
  if (!chunks.length || chunks.some((chunk, index) => Number(chunk.name.slice(prefix.length + 1)) !== index + 1))
    throw new Error(`Missing ${prefix} chunks`);
  return chunks;
}
function floatValues(bytes: Uint8Array): Float32Array {
  if ((bytes.byteOffset & 3) === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const values = new Float32Array(bytes.byteLength / 4),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(i * 4, true);
  return values;
}
async function packStoreRange(store: Capture['store'], start: bigint, end: bigint, count: number): Promise<Uint8Array> {
  if ('readPackedRange' in store) return store.readPackedRange(start, end, count);
  if ('packRange' in store) return store.packRange(start, end, count);
  const unit = Math.ceil(count / 8),
    packed = new Uint8Array(localNumber(end - start, 2 ** 26) * unit);
  if (!count) return packed;
  for (let channel = 0; channel < count; channel++)
    for (const [a, b] of splitAroundGaps(store.gaps(), start, end)) {
      let position = a,
        level = store.sampleAt(channel, a);
      const fill = (stop: bigint): void => {
        if (level)
          for (let sample = localNumber(position - start), last = localNumber(stop - start); sample < last; sample++)
            packed[sample * unit + (channel >>> 3)] |= 1 << (channel & 7);
        position = stop;
      };
      for (const edge of store.edges(channel, a + 1n, b)) {
        fill(edge);
        level ^= 1;
      }
      fill(b);
    }
  return packed;
}
function copyAnalogRange(store: AnalogStore, start: bigint, end: bigint): Float32Array {
  if (store instanceof AnalogSampleStore) return store.copyRange(start, end);
  const values = new Float32Array(localNumber(end - start, 2 ** 26));
  for (let offset = 0; offset < values.length; offset++) values[offset] = store.sampleAt(start + BigInt(offset));
  return values;
}
export async function importSR(
  file: File,
  progress: (fraction: number) => void = () => {},
  signal?: AbortSignal,
): Promise<Capture> {
  const started = performance.now();
  try {
    const members = await readZip(file, signal);
    const versionFile = members.get('version'),
      metadataFile = members.get('metadata');
    if (!versionFile || !metadataFile || versionFile.size > 16 || metadataFile.size > 1024 * 1024)
      throw new Error('Missing session version or metadata');
    const version = decoder.decode(await versionFile.read(signal)).trim();
    if (version !== '1' && version !== '2') throw new Error('Unsupported sigrok session version');
    const extension = members.get('hakei-session.json');
    if (extension && extension.size > 1024 * 1024) throw new Error('Oversized workspace settings');
    const extra = extension ? JSON.parse(decoder.decode(await extension.read(signal))) : undefined;
    const multiRate = extra?.format === 'libhakei.session/v3';
    const metadata = parseINI(decoder.decode(await metadataFile.read(signal)));
    const devices = [...metadata.entries()].filter(([name]) => /^device \d+$/.test(name));
    if (devices.length !== 1) throw new Error('A single digital device is required');
    const data = devices[0][1],
      count = data['total probes'] === undefined ? 0 : Number(data['total probes']);
    const analogCount = data['total analog'] === undefined ? 0 : Number(data['total analog']);
    const unit = data.unitsize === undefined ? 0 : Number(data.unitsize),
      samplerate = rate(data.samplerate);
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > 32 ||
      !Number.isInteger(analogCount) ||
      analogCount < 0 ||
      analogCount > 128 ||
      (!count && !analogCount && !multiRate)
    )
      throw new Error('Session has no channels');
    if (count && (!Number.isInteger(unit) || unit < Math.ceil(count / 8) || unit > 4))
      throw new Error('Invalid logic sample width');
    const capturefile = data.capturefile;
    if (count && (!capturefile || /[\\/]/.test(capturefile))) throw new Error('Invalid logic capture filename');
    const logic: import('./zip.js').ZipMember[] = [];
    if (count) {
      const single = members.get(capturefile!);
      const prefix = capturefile! + '-',
        chunks = [...members.values()]
          .filter((member) => member.name.startsWith(prefix) && /^\d+$/.test(member.name.slice(prefix.length)))
          .sort((a, b) => Number(a.name.slice(prefix.length)) - Number(b.name.slice(prefix.length)));
      if (single && chunks.length) throw new Error('Ambiguous logic data');
      if (single) logic.push(single);
      else {
        if (!chunks.length || chunks.some((chunk, index) => Number(chunk.name.slice(prefix.length)) !== index + 1))
          throw new Error(`Missing ${capturefile} chunks`);
        logic.push(...chunks);
      }
    }
    const logicBytes = logic.reduce((sum, member) => sum + member.size, 0);
    if (count && (!logic.length || logic.some((chunk) => chunk.size % unit)))
      throw new Error('Invalid logic sample length');
    const analogDescriptions = Array.from({ length: analogCount }, (_, index) => ({
      name: unescapeINI(data[`analog${count + index + 1}`] ?? `A${index}`).slice(0, 80),
      chunks: numberedChunks(members, `analog-1-${count + index + 1}`),
    }));
    const analogBytes = analogDescriptions.reduce(
      (sum, description) => sum + description.chunks.reduce((total, member) => total + member.size, 0),
      0,
    );
    if (
      analogDescriptions.some((description) => description.chunks.some((member) => member.size < 4 || member.size % 4))
    )
      throw new Error('Invalid analog sample data');
    const logicLength = count ? logicBytes / unit : 0;
    const analogLengths = analogDescriptions.map(
      (description) => description.chunks.reduce((sum, member) => sum + member.size, 0) / 4,
    );
    const length = logicLength || analogLengths[0] || (multiRate ? Number(sampleIndex(extra.referenceLength)) : 0);
    if (
      !Number.isInteger(length) ||
      length < 1 ||
      logic.some((chunk) => chunk.size % unit) ||
      analogLengths.some((value) => value !== length)
    )
      throw new Error('Invalid sample length');
    const channelCount = validWidth(count <= 4 ? 4 : count <= 8 ? 8 : count <= 16 ? 16 : 32);
    const stride = Math.ceil(channelCount / 8);
    const store = count
      ? new PlanarSampleStore({ channelCount, samplerate })
      : new RleSampleStore({
          channelCount: 4,
          samplerate,
          length,
          channels: Array.from({ length: 4 }, () => ({ initial: 0 as const, edges: new Int32Array(0) })),
        });
    let loaded = 0,
      totalBytes = logicBytes + analogBytes;
    for (const member of logic) {
      const raw = await member.read(signal);
      for (let offset = 0; offset < raw.length; offset += 262144 * unit) {
        signal?.throwIfAborted();
        const source = raw.subarray(offset, Math.min(raw.length, offset + 262144 * unit));
        if (unit === stride) store.append(source);
        else {
          const packed = new Uint8Array((source.length / unit) * stride);
          for (let i = 0; i < source.length / unit; i++)
            packed.set(source.subarray(i * unit, i * unit + Math.min(unit, stride)), i * stride);
          store.append(packed);
        }
        loaded += source.length;
        progress(loaded / totalBytes);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    const standardAnalog: Array<{ name: string; store: AnalogSampleStore }> = [];
    for (const description of analogDescriptions) {
      const analog = new AnalogSampleStore(samplerate);
      for (const member of description.chunks) {
        signal?.throwIfAborted();
        const values = floatValues(await member.read(signal));
        analog.append(values);
        loaded += member.size;
        progress(loaded / totalBytes);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      standardAnalog.push({ name: description.name, store: analog });
    }
    signal?.throwIfAborted();
    const labels = Array.from({ length: channelCount }, (_, i) =>
      unescapeINI(data['probe' + (i + 1)] ?? `D${i}`).slice(0, 80),
    );
    const capture: Capture = {
      name: file.name,
      store,
      labels,
      logicChannelCount: count,
      triggerSample: 0n,
      loadedMs: performance.now() - started,
      ...(standardAnalog.length ? { analogChannels: standardAnalog } : {}),
    };
    if (extension) {
      if (
        !['libhakei.session/v1', 'libhakei.session/v2', 'libhakei.session/v3'].includes(extra.format) ||
        sampleIndex(extra.triggerSample) >= BigInt(length) ||
        !Array.isArray(extra.gaps)
      )
        throw new Error('Invalid session settings');
      for (const gap of extra.gaps) store.noteGap(gap.startSample, gap.endSample);
      capture.triggerSample = sampleIndex(extra.triggerSample);
      capture.acquisition = parseAcquisitionResult(extra.acquisition, BigInt(length));
      if (multiRate) {
        if (
          !Array.isArray(extra.analogChannels) ||
          !extra.analogChannels.length ||
          extra.analogChannels.length > 128 ||
          sampleIndex(extra.referenceLength) !== BigInt(length) ||
          analogCount
        )
          throw new Error('Invalid multi-rate session');
        capture.analogChannels = [];
        for (let channel = 0; channel < extra.analogChannels.length; ++channel) {
          const description = extra.analogChannels[channel],
            rawTiming = description?.timing;
          if (
            description &&
            typeof description.name === 'string' &&
            rawTiming === null &&
            Array.isArray(description.chunks) &&
            description.chunks.length === 0 &&
            sampleIndex(description.nativeLength) === 0n
          ) {
            capture.analogChannels.push({
              name: description.name.slice(0, 160),
              store: new PendingAnalogStore(samplerate),
            });
            continue;
          }
          if (
            !rawTiming ||
            typeof description.name !== 'string' ||
            !Array.isArray(description.chunks) ||
            !description.chunks.length
          )
            throw new Error('Invalid analog stream metadata');
          const timing: AnalogTiming = {
            ...rawTiming,
            periodTicks: sampleIndex(rawTiming.periodTicks),
            firstTick: sampleIndex(rawTiming.firstTick),
          };
          if (
            !Number.isSafeInteger(timing.clockHz) ||
            timing.clockHz < 1 ||
            timing.periodTicks < 1n ||
            ![10, 12].includes(timing.bits) ||
            !Number.isInteger(timing.referenceMv) ||
            timing.referenceMv < 1 ||
            timing.referenceMv > 5000 ||
            !Number.isInteger(timing.uncertaintyTicks) ||
            timing.uncertaintyTicks < 0 ||
            timing.uncertaintyTicks > 0xffffffff
          )
            throw new Error('Invalid analog timing');
          const native = new AnalogSampleStore(timing.clockHz / Number(timing.periodTicks));
          for (let index = 0; index < description.chunks.length; ++index) {
            const name = `hakei-analog-${channel}-${index + 1}.f32`,
              member = members.get(name);
            if (
              description.chunks[index] !== name ||
              !member ||
              member.size < 4 ||
              member.size > 65536 * 4 ||
              member.size % 4
            )
              throw new Error('Invalid analog stream chunk');
            const values = floatValues(await member.read(signal));
            for (const value of values)
              if (!Number.isInteger(value) || value < 0 || value >= 1 << timing.bits)
                throw new Error('Invalid ADC code');
            native.append(values);
            signal?.throwIfAborted();
          }
          if (native.length !== sampleIndex(description.nativeLength)) throw new Error('Incomplete analog stream');
          capture.analogChannels.push({
            name: description.name.slice(0, 160),
            store: new TimedAnalogStore(native, timing, samplerate, BigInt(length)),
          });
        }
      }
      if (capture.analogChannels === undefined && extra.analogChannels !== undefined) {
        if (!Array.isArray(extra.analogChannels) || extra.analogChannels.length > 128)
          throw new Error('Invalid analog extension');
        capture.analogChannels = [];
        for (let channel = 0; channel < extra.analogChannels.length; channel++) {
          const description = extra.analogChannels[channel];
          if (
            !description ||
            typeof description.name !== 'string' ||
            !Array.isArray(description.chunks) ||
            !description.chunks.length
          )
            throw new Error('Invalid analog channel');
          const analog = new AnalogSampleStore(samplerate);
          let remaining = length;
          for (let index = 0; index < description.chunks.length; index++) {
            const expected = `hakei-analog-${channel}-${index + 1}.f32`,
              member = members.get(expected);
            if (
              description.chunks[index] !== expected ||
              !member ||
              member.size < 4 ||
              member.size > 4 * 65_536 ||
              member.size % 4 ||
              member.size / 4 > remaining
            )
              throw new Error('Invalid analog chunk');
            const bytes = await member.read(signal),
              values = floatValues(bytes);
            analog.append(values);
            remaining -= values.length;
          }
          if (remaining) throw new Error('Incomplete analog timeline');
          capture.analogChannels.push({ name: description.name.slice(0, 80), store: analog });
        }
      }
      if (extra.workspace !== undefined)
        capture.workspace = parseWorkspace(extra.workspace, count, BigInt(length), capture.analogChannels?.length ?? 0);
    }
    capture.loadedMs = performance.now() - started;
    return capture;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof UIError) throw error;
    throw new UIError('error.sr', { detail: error instanceof Error ? error.message : String(error) });
  }
}

export async function serializeSR(
  capture: Capture,
  workspace?: WorkspaceSettings,
  progress: (fraction: number) => void = () => {},
  signal?: AbortSignal,
): Promise<Blob> {
  const { store } = capture,
    analogChannels = capture.analogChannels ?? [],
    count = capture.logicChannelCount ?? store.channelCount,
    unit = Math.ceil(count / 8);
  if (!Number.isInteger(count) || count < 0 || count > store.channelCount || (count === 0 && !analogChannels.length))
    throw new Error('Invalid channel count');
  if (store.length < 1) throw new Error('Invalid sample length');
  const multiRate = analogChannels.some(
    (channel) => channel.store instanceof TimedAnalogStore || channel.store instanceof PendingAnalogStore,
  );
  for (const channel of analogChannels)
    if (
      (!multiRate && channel.store.length !== store.length) ||
      channel.store.samplerate !== store.samplerate ||
      (multiRate && !(channel.store instanceof TimedAnalogStore) && !(channel.store instanceof PendingAnalogStore))
    )
      throw new Error('Inconsistent analog timeline');
  if (workspace) parseWorkspace(workspace, count, store.length, analogChannels.length);
  const names = workspace?.channelNames;
  if (names && names.analog.length !== analogChannels.length) throw new Error('Invalid analog channel names');
  const totalBytes =
      Number(store.length * BigInt(unit)) +
      analogChannels.reduce(
        (sum, channel) =>
          sum +
          Number(channel.store instanceof TimedAnalogStore ? channel.store.native.length : channel.store.length) * 4,
        0,
      ),
    chunkSamples = 1_048_576;
  async function* entries(): AsyncGenerator<ZipEntry> {
    yield { name: 'version', data: encoder.encode('2') };
    const metadata = [
      '[global]',
      'sigrok version=0.5.2',
      '',
      '[device 1]',
      `total probes=${count}`,
      ...(count ? ['capturefile=logic-1'] : []),
      `samplerate=${store.samplerate} Hz`,
      ...(count ? [`unitsize=${unit}`] : []),
      ...(count
        ? Array.from(
            { length: count },
            (_, i) => `probe${i + 1}=${escapeINI(names?.digital[i] ?? capture.labels[i] ?? `D${i}`)}`,
          )
        : []),
      ...(analogChannels.length && !multiRate
        ? [
            `total analog=${analogChannels.length}`,
            ...analogChannels.map(
              (channel, i) => `analog${count + i + 1}=${escapeINI(names?.analog[i] ?? channel.name)}`,
            ),
          ]
        : ['total analog=0']),
      '',
    ];
    yield { name: 'metadata', data: encoder.encode(metadata.join('\n')) };
    yield {
      name: 'hakei-session.json',
      data: encoder.encode(
        stringifySamples({
          format: multiRate ? 'libhakei.session/v3' : 'libhakei.session/v2',
          ...(multiRate
            ? {
                referenceLength: store.length,
                analogChannels: analogChannels.map((channel) => {
                  const timed = channel.store;
                  if (timed instanceof PendingAnalogStore)
                    return { name: channel.name, timing: null, nativeLength: 0n, chunks: [] };
                  if (!(timed instanceof TimedAnalogStore)) throw new Error('Invalid analog stream');
                  return {
                    name: channel.name,
                    timing: timed.timing,
                    nativeLength: timed.native.length,
                    chunks: Array.from(
                      { length: Number((timed.native.length + 65535n) / 65536n) },
                      (_, i) => `hakei-analog-${analogChannels.indexOf(channel)}-${i + 1}.f32`,
                    ),
                  };
                }),
              }
            : {}),
          triggerSample: capture.triggerSample,
          gaps: store.gaps(),
          ...(capture.acquisition ? { acquisition: capture.acquisition } : {}),
          ...(workspace ? { workspace } : {}),
        }),
      ),
    };
    let completed = 0,
      chunk = 0;
    const report = (bytes: number): void => {
      completed += bytes;
      progress(Math.min(1, completed / totalBytes));
    };
    if (count)
      for (let start = 0n; start < store.length; start += BigInt(chunkSamples)) {
        signal?.throwIfAborted();
        const end = minSample(store.length, start + BigInt(chunkSamples)),
          packed = await packStoreRange(store, start, end, count);
        yield { name: `logic-1-${++chunk}`, data: packed, onWritten: () => report(packed.length) };
      }
    for (let channel = 0; channel < analogChannels.length; channel++) {
      const view = analogChannels[channel]!.store;
      const analog = view instanceof TimedAnalogStore ? view.native : view;
      const block = multiRate ? 65536 : chunkSamples;
      for (let start = 0n, index = 1; start < analog.length; start += BigInt(block), index++) {
        signal?.throwIfAborted();
        const end = minSample(analog.length, start + BigInt(block)),
          values = copyAnalogRange(analog, start, end);
        const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
        yield {
          name: multiRate ? `hakei-analog-${channel}-${index}.f32` : `analog-1-${count + channel + 1}-${index}`,
          data: bytes,
          onWritten: () => report(bytes.length),
        };
      }
    }
    if (!totalBytes) progress(1);
  }
  return writeZip(entries(), signal);
}
