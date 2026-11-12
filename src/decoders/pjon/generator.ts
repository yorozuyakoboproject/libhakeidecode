import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

const PAD_SAMPLES = 60;
const DATA_SAMPLES = 26;
const SLOT_SAMPLES = PAD_SAMPLES + DATA_SAMPLES;
const BYTE_SAMPLES = PAD_SAMPLES + 9 * DATA_SAMPLES;
const FRAME_PREFIX_SAMPLES = 3 * SLOT_SAMPLES;
const INITIAL_SAMPLES = 600;
const IDLE_SAMPLES = 600;

export interface PjonPacket {
  readonly bytes: readonly number[];
}

export interface PjonCase extends RoundtripCase<PjonPacket> {
  readonly initialSamples: number;
  readonly idleSamples: number;
}

interface PacketSpec {
  readonly rx?: number;
  readonly shared?: boolean;
  readonly txInfo?: boolean;
  readonly syncAck?: boolean;
  readonly asyncAck?: boolean;
  readonly port?: boolean;
  readonly pktId?: boolean;
  readonly crc32?: boolean;
  readonly len16?: boolean;
  readonly payload?: readonly number[];
  readonly rxBus?: readonly number[];
  readonly txBus?: readonly number[];
  readonly tx?: number;
  readonly portValue?: number;
  readonly packetId?: number;
  readonly badMetaCrc?: boolean;
  readonly badEndCrc?: boolean;
}

interface PacketBuild {
  readonly bytes: number[];
  readonly config: number;
  readonly packetLength: number;
  readonly payloadLength: number;
  readonly overhead: number;
  readonly metaCrc: number;
  readonly endCrc: number;
}

interface PacketPlan {
  readonly annotations: ExpectedFrame[];
  readonly next: bigint;
  readonly payloadBits: number;
}

function crc8(data: readonly number[]): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const odd = crc & 1;
      crc >>>= 1;
      if (odd) crc ^= 0x97;
    }
  }
  return crc & 0xff;
}

function crc32(data: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const odd = crc & 1;
      crc >>>= 1;
      if (odd) crc = (crc ^ 0xedb88320) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hex(value: number, width = 2): string {
  return (value >>> 0).toString(16).padStart(width, '0');
}

function bus(values: readonly number[]): string {
  return values.join('.');
}

function buildPacket(spec: PacketSpec = {}): PacketBuild {
  const rx = spec.rx ?? 5;
  const payload = [...(spec.payload ?? [0xde, 0xad])];
  const config =
    (spec.shared ? 1 : 0) |
    (spec.txInfo ? 2 : 0) |
    (spec.syncAck ? 4 : 0) |
    (spec.asyncAck ? 8 : 0) |
    (spec.port ? 16 : 0) |
    (spec.crc32 ? 32 : 0) |
    (spec.len16 ? 64 : 0) |
    (spec.pktId ? 128 : 0);
  const lengthWidth = spec.len16 ? 2 : 1;
  const crcWidth = spec.crc32 ? 4 : 1;
  const overhead =
    2 +
    lengthWidth +
    1 +
    (spec.shared ? 4 : 0) +
    (spec.txInfo ? (spec.shared ? 5 : 1) : 0) +
    (spec.port ? 2 : 0) +
    (spec.pktId ? 2 : 0) +
    crcWidth;
  const packetLength = overhead + payload.length;
  if (packetLength > 0xffff) throw new Error('PJON packet length exceeds 16 bits');
  const length = spec.len16 ? [packetLength >>> 8, packetLength & 0xff] : [packetLength];
  const head = [rx, config, ...length];
  const metaCrc = crc8(head);
  const bytes = [...head, spec.badMetaCrc ? metaCrc ^ 0xff : metaCrc];
  if (spec.shared) bytes.push(...(spec.rxBus ?? [1, 2, 3, 4]));
  if (spec.txInfo) {
    if (spec.shared) bytes.push(...(spec.txBus ?? [5, 6, 7, 8]));
    bytes.push(spec.tx ?? 9);
  }
  if (spec.port) bytes.push((spec.portValue ?? 0x1234) >>> 8, (spec.portValue ?? 0x1234) & 0xff);
  if (spec.pktId) bytes.push((spec.packetId ?? 0xabcd) >>> 8, (spec.packetId ?? 0xabcd) & 0xff);
  bytes.push(...payload);
  const endCrc = spec.crc32 ? crc32(bytes) : crc8(bytes);
  bytes.push(
    ...(spec.crc32
      ? [
          (spec.badEndCrc ? endCrc ^ 0xff : endCrc) >>> 24,
          ((spec.badEndCrc ? endCrc ^ 0xff : endCrc) >>> 16) & 0xff,
          ((spec.badEndCrc ? endCrc ^ 0xff : endCrc) >>> 8) & 0xff,
          (spec.badEndCrc ? endCrc ^ 0xff : endCrc) & 0xff,
        ]
      : [spec.badEndCrc ? endCrc ^ 0xff : endCrc]),
  );
  return { bytes, config, packetLength, payloadLength: payload.length, overhead, metaCrc, endCrc };
}

function byteSpan(frameStart: bigint, index: number): { ss: bigint; es: bigint } {
  const ss = frameStart + BigInt(FRAME_PREFIX_SAMPLES + index * BYTE_SAMPLES);
  return { ss, es: ss + BigInt(BYTE_SAMPLES) };
}

function planPacket(build: PacketBuild, spec: PacketSpec, frameStart: bigint): PacketPlan {
  const annotations: ExpectedFrame[] = [];
  const rx = build.bytes[0]!;
  const rxText = rx === 255 ? 'NA' : rx === 0 ? 'BC' : String(rx);
  const sharedText = spec.shared ? `${bus(spec.rxBus ?? [1, 2, 3, 4])} ${rxText}` : rxText;
  let index = 0;
  annotations.push({ ...byteSpan(frameStart, index++), classIndex: 0, texts: [`RX_ID ${rxText}`, rxText] });

  const wantsAck = !!spec.syncAck || !!spec.asyncAck;
  const warnings: string[] = [];
  if (wantsAck && !spec.txInfo) warnings.push('ACK request without TX info');
  if (wantsAck && rx === 0) warnings.push('ACK request for broadcast');
  if (spec.syncAck && spec.asyncAck) warnings.push('sync and async ACK request');
  if (spec.len16 && !spec.crc32) warnings.push('extended length needs CRC32');
  if (warnings.length) annotations.push({ ...byteSpan(frameStart, 1), classIndex: 12, texts: [warnings.join(', ')] });

  const flags = [
    spec.pktId ? 'pkt_id' : '-',
    spec.len16 ? 'len16' : '-',
    spec.crc32 ? 'crc32' : '-',
    spec.port ? 'svc_id' : '-',
    spec.asyncAck ? 'ack_mode' : '-',
    spec.syncAck ? 'ack' : '-',
    spec.txInfo ? 'tx_info' : '-',
    spec.shared ? 'bus_id' : '-',
  ].join(' ');
  const bits = build.config.toString(2).padStart(8, '0');
  annotations.push({
    ...byteSpan(frameStart, index++),
    classIndex: 1,
    texts: [`CFG ${flags}`, `CFG ${bits}`, bits],
  });

  const lengthSpan = spec.len16
    ? { ss: byteSpan(frameStart, index).ss, es: byteSpan(frameStart, index + 1).es }
    : byteSpan(frameStart, index);
  index += spec.len16 ? 2 : 1;
  const lengthWarnings: string[] = [];
  if (build.packetLength < build.overhead || build.packetLength > 65535)
    lengthWarnings.push('suspicious packet length');
  if (build.packetLength > 15 && !spec.crc32) lengthWarnings.push('length above 15 needs CRC32');
  if (build.payloadLength < 1) lengthWarnings.push('suspicious payload length');
  if (lengthWarnings.length) annotations.push({ ...lengthSpan, classIndex: 12, texts: [lengthWarnings.join(', ')] });
  annotations.push({
    ...lengthSpan,
    classIndex: 2,
    texts: [
      `LENGTH ${build.packetLength} (PAYLOAD ${build.payloadLength})`,
      `LEN ${build.packetLength} (PL ${build.payloadLength})`,
      `${build.packetLength} (${build.payloadLength})`,
      String(build.packetLength),
    ],
  });

  const metaHave = build.bytes[index]!;
  const metaSpan = byteSpan(frameStart, index++);
  if (metaHave !== build.metaCrc)
    annotations.push({
      ...metaSpan,
      classIndex: 12,
      texts: [`CRC mismatch - want ${hex(build.metaCrc)} have ${hex(metaHave)}`],
    });
  const metaText = hex(metaHave);
  annotations.push({
    ...metaSpan,
    classIndex: 3,
    texts: [`META_CRC ${metaText}`, `CRC ${metaText}`, metaText],
  });

  if (spec.shared) {
    const rxBusText = bus(spec.rxBus ?? [1, 2, 3, 4]);
    annotations.push({
      ss: byteSpan(frameStart, index).ss,
      es: byteSpan(frameStart, index + 3).es,
      classIndex: 7,
      texts: [`RX_BUS ${rxBusText}`, rxBusText],
    });
    index += 4;
  }
  let txText: string | null = null;
  if (spec.txInfo) {
    if (spec.shared) {
      const txBusText = bus(spec.txBus ?? [5, 6, 7, 8]);
      annotations.push({
        ss: byteSpan(frameStart, index).ss,
        es: byteSpan(frameStart, index + 3).es,
        classIndex: 7,
        texts: [`TX_BUS ${txBusText}`, txBusText],
      });
      index += 4;
      txText = txBusText;
    }
    const tx = build.bytes[index]!;
    annotations.push({
      ...byteSpan(frameStart, index++),
      classIndex: 7,
      texts: [`TX_ID ${tx}`, String(tx)],
    });
    txText = txText === null ? String(tx) : `${txText} ${tx}`;
  }
  if (spec.port) {
    const value = ((build.bytes[index]! << 8) | build.bytes[index + 1]!) >>> 0;
    annotations.push({
      ss: byteSpan(frameStart, index).ss,
      es: byteSpan(frameStart, index + 1).es,
      classIndex: 7,
      texts: [`PORT ${value}`, String(value)],
    });
    index += 2;
  }
  if (spec.pktId) {
    const value = ((build.bytes[index]! << 8) | build.bytes[index + 1]!) >>> 0;
    const text = hex(value, 4);
    annotations.push({
      ss: byteSpan(frameStart, index).ss,
      es: byteSpan(frameStart, index + 1).es,
      classIndex: 7,
      texts: [`PKT ${text}`, text],
    });
    index += 2;
  }
  if (build.payloadLength) {
    const payloadText = build.bytes
      .slice(index, index + build.payloadLength)
      .map((byte) => hex(byte))
      .join(' ');
    annotations.push({
      ss: byteSpan(frameStart, index).ss,
      es: byteSpan(frameStart, index + build.payloadLength - 1).es,
      classIndex: 8,
      texts: [`PAYLOAD ${payloadText}`, payloadText],
    });
    index += build.payloadLength;
  }
  const crcWidth = spec.crc32 ? 4 : 1;
  const endHave = spec.crc32
    ? ((build.bytes[index]! << 24) |
        (build.bytes[index + 1]! << 16) |
        (build.bytes[index + 2]! << 8) |
        build.bytes[index + 3]!) >>>
      0
    : build.bytes[index]!;
  const endSpan = {
    ss: byteSpan(frameStart, index).ss,
    es: byteSpan(frameStart, index + crcWidth - 1).es,
  };
  const crcWidthText = spec.crc32 ? 8 : 2;
  if (endHave !== build.endCrc)
    annotations.push({
      ...endSpan,
      classIndex: 12,
      texts: [`CRC mismatch - want ${hex(build.endCrc, crcWidthText)} have ${hex(endHave, crcWidthText)}`],
    });
  const endText = hex(endHave, crcWidthText);
  annotations.push({
    ...endSpan,
    classIndex: 9,
    texts: [`END_CRC ${endText}`, `CRC ${endText}`, endText],
  });

  const relation: string[] = [`RX ${sharedText}`];
  if (txText !== null) relation.push(`TX ${txText}`);
  if (build.payloadLength)
    relation.push(
      `DATA ${build.bytes
        .slice(index - build.payloadLength, index)
        .map((byte) => hex(byte))
        .join(' ')}`,
    );
  annotations.push({ ss: frameStart, es: endSpan.es, classIndex: 11, texts: [relation.join(' - ')] });
  return {
    annotations,
    next: byteSpan(frameStart, build.bytes.length - 1).es,
    payloadBits: 9 * build.bytes.length + 3,
  };
}

function summary(): ExpectedFrame {
  return { protoId: 'pjon', kind: 'summary' };
}

function boundary(name: string, specs: readonly PacketSpec[], startSample: bigint): PjonCase {
  return {
    name,
    kind: 'boundary',
    seed: 0x504a4f4e,
    sampleRate: 1_000_000,
    startSample,
    channels: { data: 0 },
    options: {},
    chain: [{ decoder: 'pjdl', options: { mode: 4, idle_add_us: 4 } }],
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    initialSamples: INITIAL_SAMPLES,
    idleSamples: IDLE_SAMPLES,
    *generate() {
      const data: PjonPacket[] = [];
      const annotations: ExpectedFrame[] = [];
      let frameStart = startSample + BigInt(INITIAL_SAMPLES);
      let payloadBits = 0;
      for (const spec of specs) {
        const build = buildPacket(spec);
        const plan = planPacket(build, spec, frameStart);
        data.push({ bytes: build.bytes });
        annotations.push(...plan.annotations);
        payloadBits += plan.payloadBits;
        frameStart = plan.next + BigInt(IDLE_SAMPLES);
      }
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: annotations,
        annotationCount: annotations.length,
        payloadBits,
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x504a4f4e,
}: GenerationOptions = {}): Iterable<PjonCase> {
  yield boundary(
    'minimal-crc8',
    [
      { rx: 5, payload: [0xde, 0xad] },
      { rx: 255, payload: [0x01, 0x02, 0x03] },
    ],
    17n,
  );
  yield boundary(
    'all-fields',
    [
      {
        rx: 8,
        shared: true,
        txInfo: true,
        port: true,
        pktId: true,
        crc32: true,
        len16: true,
        payload: [0xde, 0xad, 0xbe, 0xef],
      },
    ],
    31n,
  );
  yield boundary('config-and-length-warnings', [{ rx: 0, syncAck: true, asyncAck: true, payload: [1, 2, 3, 4] }], 53n);
  yield boundary('crc-mismatch', [{ rx: 7, payload: [0x10, 0x20], badEndCrc: true }], 71n);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const payloadLength = 65_526;
  const frameBytes = 9 + payloadLength;
  const bitsPerBlock = 9 * frameBytes + 3;
  const blocks = Math.ceil(required / bitsPerBlock);
  yield {
    name: 'seeded-long-packets',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { data: 0 },
    options: {},
    chain: [{ decoder: 'pjdl', options: { mode: 4, idle_add_us: 4 } }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    initialSamples: INITIAL_SAMPLES,
    idleSamples: IDLE_SAMPLES,
    *generate() {
      const random = randomWords(seed);
      let frameStart = BigInt(INITIAL_SAMPLES);
      for (let block = 0; block < blocks; block++) {
        const payload = Array.from({ length: payloadLength }, () => random() & 0xff);
        const spec: PacketSpec = { rx: 5, len16: true, crc32: true, payload };
        let build = buildPacket(spec);
        for (let attempt = 0; build.bytes.at(-1) === 0 && attempt < 256; attempt++) {
          payload[payload.length - 1] = (payload.at(-1)! + 1) & 0xff;
          build = buildPacket(spec);
        }
        if (build.bytes.at(-1) === 0) throw new Error('Unable to generate a nonzero end CRC byte');
        const plan = planPacket(build, spec, frameStart);
        yield {
          data: [{ bytes: build.bytes }],
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: [plan.annotations[0]!, plan.annotations.at(-2)!],
          annotationCount: plan.annotations.length,
          payloadBits: plan.payloadBits,
        };
        frameStart = plan.next + BigInt(IDLE_SAMPLES);
      }
    },
  };
}
