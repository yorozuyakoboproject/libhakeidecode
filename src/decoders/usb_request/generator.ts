import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { UsbSpeed } from '../usb_signalling/index.js';
import { USB_LEAD_BITS, usbBitWidth } from '../usb_signalling/generator.js';
import { packetLayout } from '../usb_packet/generator.js';
import type { UsbPacketSpec } from '../usb_packet/generator.js';

export interface UsbRequestCase extends RoundtripCase<UsbPacketSpec> {
  readonly signalling: UsbSpeed;
}

interface RequestGroup {
  readonly packets: readonly UsbPacketSpec[];
  readonly classIndex: 0 | 1 | 2 | 3;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function setup(
  direction: 'in' | 'out',
  wValue = 0x0100,
  wIndex = 0,
  wLength = 0,
  requestType = direction === 'in' ? 0x80 : 0x00,
): number[] {
  return [
    requestType,
    0x06,
    wValue & 0xff,
    (wValue >>> 8) & 0xff,
    wIndex & 0xff,
    (wIndex >>> 8) & 0xff,
    wLength & 0xff,
    (wLength >>> 8) & 0xff,
  ];
}

function controlIn(addr: number, setupData: readonly number[], data: readonly number[]): RequestGroup {
  const packets: UsbPacketSpec[] = [
    { pid: 'SETUP', addr, ep: 0 },
    { pid: 'DATA0', data: setupData },
    { pid: 'ACK' },
    { pid: 'IN', addr, ep: 0 },
    { pid: 'DATA1', data },
    { pid: 'ACK' },
    { pid: 'OUT', addr, ep: 0 },
    { pid: 'ACK' },
  ];
  let text = '[';
  for (const byte of setupData) text += ` ${hex(byte)}`;
  text += ' ][';
  for (const byte of data) text += ` ${hex(byte)}`;
  text += ' ] : ACK';
  return { packets, classIndex: 0, text: `SETUP in: ${text}`, startIndex: 0, endIndex: 7 };
}

function controlOut(addr: number, setupData: readonly number[], data: readonly number[]): RequestGroup {
  const packets: UsbPacketSpec[] = [
    { pid: 'SETUP', addr, ep: 0 },
    { pid: 'DATA0', data: setupData },
    { pid: 'ACK' },
    { pid: 'OUT', addr, ep: 0 },
    { pid: 'DATA1', data },
    { pid: 'ACK' },
    { pid: 'IN', addr, ep: 0 },
    { pid: 'ACK' },
  ];
  let text = '[';
  for (const byte of setupData) text += ` ${hex(byte)}`;
  text += ' ][';
  for (const byte of data) text += ` ${hex(byte)}`;
  text += ' ] : ACK';
  return { packets, classIndex: 1, text: `SETUP out: ${text}`, startIndex: 0, endIndex: 7 };
}

function bulkOut(addr: number, ep: number, data: readonly number[]): RequestGroup {
  let text = '[';
  for (const byte of data) text += ` ${hex(byte)}`;
  text += ' ] : ACK';
  return {
    packets: [{ pid: 'OUT', addr, ep }, { pid: 'DATA0', data }, { pid: 'ACK' }],
    classIndex: 3,
    text: `BULK out: ${text}`,
    startIndex: 0,
    endIndex: 2,
  };
}

function bulkIn(addr: number, ep: number, data: readonly number[]): RequestGroup {
  let text = '[';
  for (const byte of data) text += ` ${hex(byte)}`;
  text += ' ] : ACK';
  return {
    packets: [{ pid: 'IN', addr, ep }, { pid: 'DATA1', data }, { pid: 'ACK' }],
    classIndex: 2,
    text: `BULK in: ${text}`,
    startIndex: 0,
    endIndex: 2,
  };
}

function chain(speed: UsbSpeed) {
  const options = { signalling: speed };
  return [
    { decoder: 'usb_signalling', options },
    { decoder: 'usb_packet', options },
  ] as const;
}

function protocolSummary(): ExpectedFrame {
  return { protoId: 'usb_request', kind: 'summary' };
}

function boundaryCase(
  name: string,
  seed: number,
  startSample: bigint,
  groups: readonly RequestGroup[],
  inRequestStart: 'submit' | 'first-ack' = 'submit',
): UsbRequestCase {
  const speed: UsbSpeed = 'full-speed';
  const sampleRate = 48_000_000;
  return {
    name,
    kind: 'boundary',
    seed,
    sampleRate,
    startSample,
    channels: { dp: 3, dm: 6 },
    options: { in_request_start: inRequestStart },
    chunkSamples: [1, 11, 257, 4093],
    minimumPayloadBits: 0,
    chain: chain(speed),
    signalling: speed,
    *generate() {
      const width = usbBitWidth(sampleRate, speed);
      let cursor = startSample + BigInt(USB_LEAD_BITS * width);
      const data: UsbPacketSpec[] = [];
      const expectedAnnotations: ExpectedFrame[] = [];
      let payloadBits = 0;
      for (const group of groups) {
        const starts: bigint[] = [];
        const ends: bigint[] = [];
        for (const packet of group.packets) {
          const layout = packetLayout(packet, cursor, width);
          starts.push(cursor);
          ends.push(layout.packetEnd);
          cursor = layout.next;
          payloadBits += layout.payloadBits;
          data.push(packet);
        }
        expectedAnnotations.push({
          classIndex: group.classIndex,
          texts: [group.text],
          ss: starts[group.startIndex],
          es: ends[group.endIndex],
        });
      }
      yield {
        data,
        expected: [protocolSummary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits,
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x55534252,
}: GenerationOptions = {}): Iterable<UsbRequestCase> {
  yield boundaryCase('control-in-read', seed, 17n, [controlIn(0x21, setup('in', 0x0100, 0, 2), [0xaa, 0x55])]);
  yield boundaryCase(
    'control-out-write',
    seed ^ 1,
    9_007_199_254_740_000n,
    [controlOut(0x05, setup('out', 0, 0, 4), [0x01, 0x02, 0x03, 0x04])],
    'first-ack',
  );
  yield boundaryCase('bulk-both-directions', seed ^ 2, 219n, [
    bulkOut(0x22, 3, [0x00, 0xff, 0x10]),
    bulkIn(0x22, 3, [0x20, 0x30, 0x40, 0x50]),
  ]);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const speed: UsbSpeed = 'full-speed';
  const sampleRate = 48_000_000;
  const perBlock = 16;
  yield {
    name: 'seeded-long-bulk-requests',
    kind: 'long',
    seed,
    sampleRate,
    startSample: 0n,
    channels: { dp: 1, dm: 4 },
    options: { in_request_start: 'submit' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: chain(speed),
    signalling: speed,
    *generate() {
      const random = randomWords(seed);
      const width = usbBitWidth(sampleRate, speed);
      let cursor = BigInt(USB_LEAD_BITS * width);
      let total = 0;
      let first = true;
      while (total < required) {
        const data: UsbPacketSpec[] = [];
        const expectedAnnotations: ExpectedFrame[] = [];
        let payloadBits = 0;
        for (let index = 0; index < perBlock; index++) {
          const bytes = Array.from({ length: 64 }, () => random() & 0xff);
          const group = index & 1 ? bulkIn(0x30 + (index & 7), 1, bytes) : bulkOut(0x30 + (index & 7), 1, bytes);
          const starts: bigint[] = [];
          const ends: bigint[] = [];
          for (const packet of group.packets) {
            const layout = packetLayout(packet, cursor, width);
            starts.push(cursor);
            ends.push(layout.packetEnd);
            cursor = layout.next;
            payloadBits += layout.payloadBits;
            data.push(packet);
          }
          expectedAnnotations.push({
            classIndex: group.classIndex,
            texts: [group.text],
            ss: starts[group.startIndex],
            es: ends[group.endIndex],
          });
        }
        total += payloadBits;
        yield {
          data,
          expected: first ? [protocolSummary()] : [],
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits,
        };
        first = false;
      }
    },
  };
}
