import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampleChunk } from '../dist/src/libhakei/index.js';
import { Decoder, DecoderRunner, ProtocolStack, OUTPUT_PROTOCOL, SampleGapError } from '../dist/src/libhakeidecode/index.js';
import { UARTDecoder } from '../dist/src/decoders/uart.js';
import { PWMDecoder, PWM_ANN } from '../dist/src/decoders/pwm.js';
import { FrameToTextDecoder } from '../dist/src/pipeline/frame-to-text.js';

class ConditionProbe extends Decoder {
  static descriptor = { apiVersion: 3, id: 'condition-probe', name: 'Condition probe', inputs: ['logic'], outputs: ['probe'] };

  start(ctx) {
    super.start(ctx);
    this.out = this.register(OUTPUT_PROTOCOL);
  }

  *decode() {
    yield this.wait([{ rx: 'h' }, { rx: 'f' }]);
    this.put(this.samplenum, this.samplenum + 1n, this.out, this.matched);
  }
}

test('wait OR alternatives report the earliest hit and matched flags', () => {
  const events = [];
  new DecoderRunner(new ConditionProbe(), {
    channels: { rx: true },
    onEvent: (event) => events.push(event),
  }).push(createSampleChunk({ sampleRate: 1, channels: { rx: Uint8Array.from([1, 1, 0]) }, isFinal: true }));
  assert.deepEqual(events[0].data, [true, false]);
});

test('absolute sample numbers above 32 bits are preserved', () => {
  const events = [];
  class SampleProbe extends Decoder {
    static descriptor = { apiVersion: 3, id: 'sample-probe', name: 'Sample probe', inputs: ['logic'], outputs: ['probe'] };
    start(ctx) { super.start(ctx); this.out = this.register(OUTPUT_PROTOCOL); }
    *decode() {
      yield this.wait({ rx: 'f' });
      this.put(this.samplenum, this.samplenum + 1n, this.out, this.samplenum);
    }
  }
  const startSample = 2n ** 64n + 17n;
  new DecoderRunner(new SampleProbe(), { channels: { rx: true }, onEvent: (event) => events.push(event) })
    .push(createSampleChunk({ startSample, sampleRate: 1, channels: { rx: Uint8Array.from([1, 0, 0]) }, isFinal: true }));
  assert.equal(events[0].ss, startSample + 1n);
  assert.equal(events[0].data, startSample + 1n);
});

test('sample gaps fail explicitly by default', () => {
  const runner = new DecoderRunner(new ConditionProbe(), { channels: { rx: true } });
  runner.push(createSampleChunk({ startSample: 0, sampleRate: 1, channels: { rx: Uint8Array.from([0]) } }));
  assert.throws(() => runner.push(createSampleChunk({ startSample: 2, sampleRate: 1, channels: { rx: Uint8Array.from([1]) } })), SampleGapError);
});

function uartWave(bytes, samplesPerBit = 8, { trailingIdleBits = 2 } = {}) {
  const output = Array(samplesPerBit * 2).fill(1);
  for (const byte of bytes) {
    output.push(...Array(samplesPerBit).fill(0));
    for (let bit = 0; bit < 8; bit += 1) output.push(...Array(samplesPerBit).fill((byte >> bit) & 1));
    output.push(...Array(samplesPerBit).fill(1));
  }
  output.push(...Array(samplesPerBit * trailingIdleBits).fill(1));
  return Uint8Array.from(output);
}

function decode(chunks) {
  const events = [];
  const runner = new DecoderRunner(new UARTDecoder({ baudrate: 1000, format: 'ascii' }), {
    channels: { rx: true },
    onEvent: (event) => events.push(event),
  });
  for (const chunk of chunks) runner.push(chunk);
  return events;
}

test('UART decodes complete frames and keeps protocol/binary/annotation output distinct', () => {
  const wave = uartWave(Uint8Array.from([0x48, 0x69]));
  const events = decode([createSampleChunk({ sampleRate: 8000, channels: { rx: wave }, isFinal: true })]);
  const frames = events.filter((event) => event.type === 'protocol' && event.data[0] === 'FRAME');
  assert.deepEqual(frames.map((event) => event.data[2][0]), [0x48, 0x69]);
  assert.equal(events.some((event) => event.type === 'annotation'), true);
  assert.equal(events.some((event) => event.type === 'binary' && event.data[0] === 0 && event.data[1] instanceof Uint8Array), true);
});

test('different chunk boundaries produce identical protocol results, including split edges', () => {
  const wave = uartWave(Uint8Array.from([0x41, 0x42]));
  const whole = decode([createSampleChunk({ sampleRate: 8000, channels: { rx: wave }, isFinal: true })])
    .filter((event) => event.type === 'protocol')
    .map((event) => [event.ss, event.es, event.data]);
  const chunks = [];
  for (let start = 0; start < wave.length; start += 5) {
    const end = Math.min(start + 5, wave.length);
    chunks.push(createSampleChunk({ startSample: start, sampleRate: 8000, channels: { rx: wave.slice(start, end) }, isFinal: end === wave.length }));
  }
  const split = decode(chunks).filter((event) => event.type === 'protocol').map((event) => [event.ss, event.es, event.data]);
  assert.deepEqual(split, whole);
});

test('incomplete final frame emits no FRAME event', () => {
  const wave = uartWave(Uint8Array.from([0x41]), 8, { trailingIdleBits: 0 }).slice(0, -5);
  const events = decode([createSampleChunk({ sampleRate: 8000, channels: { rx: wave }, isFinal: true })]);
  assert.equal(events.some((event) => event.type === 'protocol' && event.data[0] === 'FRAME'), false);
});

test('protocol stack feeds UART FRAME packets to an upper decoder', () => {
  const stack = new ProtocolStack(new UARTDecoder({ baudrate: 1000, format: 'ascii' }), {
    channels: { rx: true }, downstream: [new FrameToTextDecoder()],
  });
  const wave = uartWave(Uint8Array.from([0x4f, 0x4b]));
  stack.push(createSampleChunk({ sampleRate: 8000, channels: { rx: wave }, isFinal: true }));
  assert.deepEqual(stack.events.filter((event) => event.decoder === 'frame-to-text').map((event) => event.data.text), ['O', 'K']);
});

function pwmWave(widths) {
  return Uint8Array.from([0, 0, 0, ...widths.flatMap(([active, inactive]) => [...Array(active).fill(1), ...Array(inactive).fill(0)]), 1]);
}
for (const polarity of ['active-high', 'active-low']) test('PWM exact intervals, duty bytes and average: ' + polarity, () => {
  const events = [], wave = pwmWave([[2, 6], [4, 4], [6, 2]]);
  if (polarity === 'active-low') for (let i = 0; i < wave.length; i++) wave[i] ^= 1;
  const runner = new DecoderRunner(new PWMDecoder({ polarity }), { channels: { data: true }, onEvent: event => events.push(event) });
  for (let i = 0; i < wave.length; i++) runner.push(createSampleChunk({ startSample: i, sampleRate: 1000, channels: { data: wave.subarray(i, i + 1) }, isFinal: i + 1 === wave.length }));
  assert.deepEqual(events.filter(event => event.type === 'annotation' && event.data[0] === PWM_ANN.DUTY_CYCLE).map(event => [event.ss, event.es, event.data[1][0]]), [[3n, 11n, '25.000000%'], [11n, 19n, '50.000000%'], [19n, 27n, '75.000000%']]);
  assert.deepEqual(events.filter(event => event.type === 'binary').flatMap(event => [...event.data[1]]), [64, 128, 192]);
  assert.deepEqual(events.filter(event => event.type === 'meta').map(event => event.data), [25, 37.5, 50]);
});
test('PWM reset clears average and cancellation emits no incomplete cycle', () => {
  const events=[],runner=new DecoderRunner(new PWMDecoder(),{channels:{data:'pin'},onEvent:event=>events.push(event)});
  runner.push({sampleRate:1000,channels:{pin:Uint8Array.from(pwmWave([[2,6]]))},isFinal:true});runner.reset();
  runner.push({sampleRate:1000,channels:{pin:Uint8Array.from(pwmWave([[6,2]]))},isFinal:true});
  assert.deepEqual(events.filter(event=>event.type==='meta').map(event=>event.data),[25,75]);
  runner.reset();events.length=0;runner.push({sampleRate:1000,channels:{pin:Uint8Array.from([0,0,1,1,0])}}).cancel();assert.deepEqual(events,[]);
});

test('PWM requires data channel and sample-rate metadata', () => {
  assert.throws(()=>new DecoderRunner(new PWMDecoder()),/Missing required channel/);
  assert.throws(()=>new PWMDecoder().decode().next(),/samplerate/);
});
