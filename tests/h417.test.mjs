import test from 'node:test';
import assert from 'node:assert/strict';
import { CH32H417Device, H417WorkerDevice } from '../dist/src/drivers/ch32h417/index.js';
import { FrameParser, MAGIC, DATA, END, RESPONSE, Command, MAX_FRAME_BYTES, SS_RATES } from '../dist/src/drivers/ch32h417/protocol.js';
import { captureSampleSource, deviceCapture } from '../dist/src/web/capture.js';
import { serializeSR, importSR } from '../dist/src/web/sr.js';
import { defaultDeviceConfiguration } from '../dist/src/libhakei/index.js';
import { H417Transport, USB_READ_DEPTH } from '../dist/src/drivers/ch32h417/transport.js';
async function connected(options={}) {
  const mock=installH417Mock(options),broker=new CH32H417Device();await broker.connect();
  const description=broker.getAcquisitionDescription(defaultDeviceConfiguration(broker.descriptor));
  return {...mock,broker,worker:new H417WorkerDevice(description.worker.initialization)};
}
const configuration=(device,extra={})=>({...defaultDeviceConfiguration(device.descriptor),sampleCount:17001n,logicChannels:3,...extra});
function sourceCapture(worker,config,context={}) {const chunkSamples=context.chunkSamples??16384;return captureSampleSource(worker.createPackedSource(config,{...context,chunkSamples}),'H417',undefined,{configuration:config,chunkSamples});}
const sampleByte = index => (Number(index) * 13 + 0x5a) & 255;
class MockH417 {
  vendorId=0x0721; productId=0x2333; serialNumber='H417-MOCK-0001'; opened=false;
  session=0; sequence=0; samples=0; rate=40000000; count=200000; channels=8;
  active=false; ended=false; queue=[]; reads=[]; events=[];
  constructor(options={}) {
    this.options=options; this.packet=options.packet??1024;
    this.configuration={configurationValue:1,interfaces:[{interfaceNumber:0,alternates:[{endpoints:[]}]},{interfaceNumber:1,alternates:[{endpoints:[
      {endpointNumber:5,direction:'out',type:'bulk',packetSize:this.packet},{endpointNumber:6,direction:'in',type:'bulk',packetSize:this.packet}]}]}]};
  }
  event(name) { this.events.push(name); this.options.event?.(name); }
  async open(){this.opened=true;this.event('open');}
  async selectConfiguration(value){if(value!==1)throw Error('configuration');}
  async claimInterface(value){if(value!==1)throw Error('Interface 0 must remain free');this.event('claim:1');}
  async releaseInterface(value){if(value!==1)throw Error('wrong release');this.event('release:1');}
  async close(){this.opened=false;this.event('close');for(const reader of this.reads.splice(0))reader.reject(Error('closed'));}
  status(error=0){const b=new Uint8Array(16),v=new DataView(b.buffer);b.set([error,this.active?1:0,this.channels,this.packet===1024?3:2]);v.setUint32(4,this.rate,true);v.setBigUint64(8,BigInt(this.samples),true);return b;}
  frame(type,payload,{requestId=0,header=32,sequence=this.sequence,first=this.samples}={}){
    const b=new Uint8Array(header+payload.length),v=new DataView(b.buffer);v.setUint32(0,MAGIC,true);b[4]=1;b[5]=type;v.setUint16(6,header,true);v.setUint32(8,requestId,true);v.setUint32(12,this.session,true);v.setUint32(16,sequence,true);v.setBigUint64(20,BigInt(first),true);v.setUint32(28,payload.length,true);b.set(payload,header);return b;
  }
  emit(bytes){
    if(this.options.fragment){let start=0;for(const size of [3,21,9,477,1021,bytes.length]){if(start>=bytes.length)break;const end=Math.min(bytes.length,start+size);this.queue.push(bytes.slice(start,end));start=end;}}
    else this.queue.push(bytes);
  }
  finish(error=0){this.active=false;this.ended=true;this.emit(this.frame(END,this.status(error)));this.event('end:'+error);}
  produce(){
    if(!this.active)return false;
    if(this.options.hold && this.samples>=(this.options.holdAt??16384))return false;
    if(this.samples>=Math.min(this.count,this.options.overflow?16384:Infinity)){this.finish(this.options.overflow?3:0);return true;}
    if(this.options.stall && this.samples>=16384){this.active=false;this.queue.push(null);return true;}
    const length=Math.min(16384,this.count-this.samples),b=Uint8Array.from({length},(_,i)=>this.options.constant??sampleByte(this.samples+i));
    this.emit(this.frame(DATA,b,{header:this.packet,sequence:this.sequence+(this.options.discontinuity && this.sequence===1?1:0)}));
    this.samples+=length;this.sequence++;return true;
  }
  flush(){
    while(this.reads.length){if(!this.queue.length&&!this.produce())break;const reader=this.reads.shift(),value=this.queue.shift();
      if(value===null)reader.resolve({status:'stall'});else reader.resolve({status:'ok',data:new DataView(value.buffer,value.byteOffset,value.byteLength)});
    }
  }
  transferIn(endpoint,length){if(endpoint!==6||length%this.packet)throw Error('invalid IN');return new Promise((resolve,reject)=>{this.reads.push({resolve,reject});this.flush();});}
  async transferOut(endpoint,bytes){
    if(endpoint!==5||bytes.length!==this.packet)throw Error('invalid OUT');
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),type=bytes[5],id=v.getUint32(8,true);this.event('command:'+type);
    let payload=this.status();
    if(type===Command.caps){payload=new Uint8Array(72);payload.set(this.status());const c=new DataView(payload.buffer,16);c.setUint16(0,this.options.protocol??15,true);c.setUint16(2,this.packet,true);c.setUint32(4,16384,true);c.setUint32(8,5000,true);c.setUint8(12,8);const rates=SS_RATES.slice(0,this.packet===1024?10:4);c.setUint8(13,rates.length);rates.forEach((r,i)=>c.setUint32(16+i*4,r,true));}
    if(type===Command.config){this.rate=v.getUint32(32,true);this.count=Number(v.getBigUint64(36,true));this.channels=bytes[44];payload=this.status();}
    if(type===Command.start){
      if(this.options.busy)payload=this.status(2);
      else {this.active=true;this.ended=false;this.session++;this.samples=this.sequence=0;payload=this.status();if(this.options.dataBeforeStart)this.produce();}
    }
    this.emit(this.frame(type|RESPONSE,payload,{requestId:id}));
    if(type===Command.stop&&!this.ended)this.finish(7);
    this.flush();return {status:'ok',bytesWritten:bytes.length};
  }
}
function installH417Mock(options={}){
  const device=new MockH417(options),listeners=new Set();
  let requestCount=0;
  const api={requestDevice:async()=>{requestCount++;device.event('permission');return device;},getDevices:async()=>options.authorizedDevices??[device],addEventListener:(_type,fn)=>listeners.add(fn),removeEventListener:(_type,fn)=>listeners.delete(fn)};
  Object.defineProperty(globalThis.navigator??(globalThis.navigator={}), 'usb',{configurable:true,value:api});
  return {device,api,get requestCount(){return requestCount;},disconnect:()=>{for(const fn of listeners)fn({device});}};
}

test('H417 restores a persisted origin grant through getDevices without opening a chooser',async()=>{
  const mock=installH417Mock(),broker=new CH32H417Device();
  assert.equal(await broker.restore(),true);assert.equal(broker.connected,true);assert.equal(mock.requestCount,0);
  assert.ok(mock.device.events.includes('command:1'),'restoration opens the device and reads CAPS');
  assert.ok(!mock.device.events.includes('permission'),'restoration must not request permission');
  await broker.disconnect();
});

test('H417 with no origin grant stays disconnected and does not request permission',async()=>{
  const mock=installH417Mock({authorizedDevices:[]}),broker=new CH32H417Device();
  assert.equal(await broker.restore(),false);assert.equal(broker.connected,false);assert.equal(mock.requestCount,0);
  assert.deepEqual(mock.device.events,[]);
});

test('H417 parser accepts fragmented/coalesced frames and rejects oversized or corrupt headers',()=>{
  const device=new MockH417(),seen=[],parser=new FrameParser(1024,frame=>seen.push(frame));
  const a=device.frame(DATA,new Uint8Array([0x81,0x42]),{header:1024}),both=new Uint8Array(a.length*2);both.set(a);both.set(a,a.length);
  for(let offset=0;offset<both.length;offset+=7)parser.push(both.subarray(offset,offset+7));
  assert.equal(seen.length,2);assert.deepEqual([...seen[0].payload],[0x81,0x42]);assert.ok(a.length<=MAX_FRAME_BYTES);
  const whole=[];new FrameParser(1024,frame=>whole.push(frame)).push(a);
  assert.equal(whole[0].payload.buffer,a.buffer,'complete frames reference the USB read buffer');
  assert.notEqual(seen[0].payload.buffer,both.buffer,'fragmented frames use parser-owned storage');
  const oversized=a.slice();new DataView(oversized.buffer).setUint32(28,16385,true);assert.throws(()=>new FrameParser(1024,()=>{}).push(oversized),/Invalid/);
  const corrupt=a.slice();corrupt[0]=0;assert.throws(()=>new FrameParser(1024,()=>{}).push(corrupt),/Invalid/);
});

for(const packet of [512,1024]) test(`H417 ${packet===512?'HS':'SS'} rates, first-N bits, finite tail, managed buffers and SR export`,async()=>{
  const {broker,worker,device}=await connected({packet,fragment:true,dataBeforeStart:true});
  assert.equal(broker.descriptor.capabilities.sampleRate.values.length,packet===512?4:10);
  const config=configuration(worker),buffer=new ArrayBuffer(16384*3);let borrowed=0;
  const capture=await sourceCapture(worker,config,{acquireBuffer:async()=>{borrowed++;return buffer;}});
  assert.equal(capture.store.length,17001n);assert.equal(capture.logicChannelCount,3);assert.equal(capture.store.channelCount,4);assert.equal(borrowed,2);
  for(const i of [0,1,16383,16384,17000])for(let ch=0;ch<3;ch++)assert.equal(capture.store.sampleAt(ch,i),(sampleByte(i)>>>ch)&1);
  assert.equal(capture.store.sampleAt(3,100),0);
  const restored=await importSR(new File([await serializeSR(capture)],'h417.sr'));
  assert.equal(restored.logicChannelCount,3);assert.equal(restored.store.length,17001n);
  assert.deepEqual(device.events.filter(e=>e.startsWith('claim:')),['claim:1','claim:1']);
  assert.deepEqual(device.events.slice(-2),['release:1','close']);
});

for(const [mode,error] of [['overflow',/overflow/],['discontinuity',/discontinuity/],['stall',/stalled/]])test(`H417 ${mode} preserves the contiguous prefix and releases Interface 1`,async()=>{
  const {worker,device}=await connected({[mode]:true});const capture=await sourceCapture(worker,configuration(worker,{sampleCount:200000n,logicChannels:8}));
  assert.equal(capture.store.length,16384n);assert.equal(capture.acquisition.stopReason,'error');assert.match(capture.acquisition.error,error);assert.deepEqual(device.events.slice(-2),['release:1','close']);
});

test('H417 busy refuses capture and protocol mismatch refuses connection',async()=>{
  const {worker,device}=await connected({busy:true});await assert.rejects(sourceCapture(worker,configuration(worker)),/resource busy/);assert.equal(device.opened,false);
  const mock=installH417Mock({protocol:13});await assert.rejects(new CH32H417Device().connect(),/v15 required/);assert.equal(mock.device.opened,false);
});

test('H417 early return sends STOP, drains END, then releases and permits a second capture',async()=>{
  const {worker,device}=await connected({hold:true}),config=configuration(worker,{sampleCount:200000n});
  const iterator=worker.createSource(config)[Symbol.asyncIterator]();assert.equal((await iterator.next()).done,false);await iterator.return();
  const stop=device.events.lastIndexOf('command:4'),end=device.events.lastIndexOf('end:7'),release=device.events.lastIndexOf('release:1');
  assert.ok(stop>=0&&stop<end&&end<release);assert.equal(device.opened,false);
  device.options.hold=false;const next=await sourceCapture(worker,configuration(worker));assert.equal(next.store.length,17001n);
});

test('H417 mandatory Worker applies to one sample and never falls back to main thread',async()=>{
  const {broker,disconnect}=await connected(),config=configuration(broker,{sampleCount:1n}),previous=globalThis.Worker;
  try {
    globalThis.Worker=class {constructor(){throw Error('Worker blocked');}};
    await assert.rejects(deviceCapture(broker,config),/Worker blocked/);
    await assert.rejects(deviceCapture(broker,config,undefined,{worker:'off'}),/Worker unavailable/);
    globalThis.Worker=undefined;await assert.rejects(deviceCapture(broker,config),/Worker unavailable/);
    disconnect();assert.equal(broker.connected,false);
  }finally{globalThis.Worker=previous;}
});

test('H417 supports every first-N channel count without exposing storage padding',async()=>{
  for(let channels=1;channels<=8;channels++) {
    const {worker}=await connected(),config=configuration(worker,{logicChannels:channels,sampleCount:33n});
    const capture=await sourceCapture(worker,config);
    assert.equal(capture.logicChannelCount,channels);assert.equal(capture.labels.length,channels);
    for(let channel=0;channel<channels;channel++) for(let sample=0;sample<33;sample++)
      assert.equal(capture.store.sampleAt(channel,sample),(sampleByte(sample)>>>channel)&1);
    const restored=await importSR(new File([await serializeSR(capture)],'first-n.sr'));
    assert.equal(restored.logicChannelCount,channels);assert.equal(restored.store.length,33n);
  }
});

test('H417 keeps bounded USB requests queued through a delayed 200000-sample consumer',async()=>{
  const device=new MockH417(),transport=new H417Transport(device);
  let peakReads=0;
  const read=device.transferIn.bind(device);
  device.transferIn=(...args)=>{const pending=read(...args);peakReads=Math.max(peakReads,device.reads.length);return pending;};
  try {
    await transport.open();
    assert.equal(device.reads.length,USB_READ_DEPTH);
    await transport.command(Command.caps);
    const payload=new Uint8Array(16),view=new DataView(payload.buffer);
    view.setUint32(0,40000000,true);view.setBigUint64(4,200000n,true);view.setUint8(12,8);
    await transport.start(payload);
    let count=0n,blocks=0;
    while(true){
      await new Promise(resolve=>setTimeout(resolve,1));
      const frame=await transport.next();assert.ok(frame);
      assert.equal(frame.firstSample,count);assert.equal(frame.sequence,blocks);
      if(frame.type===END){assert.equal(frame.payload[0],0);break;}
      assert.equal(frame.type,DATA);count+=BigInt(frame.payload.length);blocks++;
    }
    assert.equal(count,200000n);assert.equal(blocks,13);assert.equal(peakReads,USB_READ_DEPTH);
  }finally{await transport.stop();await transport.close();}
  assert.equal(device.reads.length,0);assert.equal(device.opened,false);
});
