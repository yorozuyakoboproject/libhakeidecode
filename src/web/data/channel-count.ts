export type ChannelCount = 4 | 8 | 16 | 32 | 64 | 128;

export const CHANNEL_COUNTS: readonly ChannelCount[] = [4, 8, 16, 32, 64, 128];

export function isChannelCount(value: number): value is ChannelCount {
  return CHANNEL_COUNTS.includes(value as ChannelCount);
}

export function bytesPerSampleForChannels(channels: number): number {
  if (!Number.isInteger(channels) || channels < 1) throw new Error(`invalid channel count ${channels}`);
  return Math.ceil(channels / 8);
}

export function channelWidthForProbes(probes: number): ChannelCount {
  if (!Number.isInteger(probes) || probes < 1 || probes > 128) {
    throw new Error(`probe count must be an integer in [1, 128], got ${probes}`);
  }
  for (const width of CHANNEL_COUNTS) if (probes <= width) return width;
  throw new Error(`probe count ${probes} exceeds the supported 128-channel envelope`);
}

export function widenPackedSamples(data: Uint8Array, sourceBytes: number, targetChannels: number): Uint8Array {
  const targetBytes = bytesPerSampleForChannels(targetChannels);
  if (sourceBytes === targetBytes) return data;
  if (!Number.isInteger(sourceBytes) || sourceBytes < 1 || sourceBytes > 4 || data.length % sourceBytes)
    throw new Error('Invalid packed sample width');
  const samples = data.length / sourceBytes,
    output = new Uint8Array(samples * targetBytes);
  for (let sample = 0; sample < samples; sample++)
    output.set(
      data.subarray(sample * sourceBytes, sample * sourceBytes + Math.min(sourceBytes, targetBytes)),
      sample * targetBytes,
    );
  return output;
}
