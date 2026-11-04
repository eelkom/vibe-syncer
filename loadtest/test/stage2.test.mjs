import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { options, plan, skipAfterFailures } from '../stage2/config.mjs';
import { delivery, correctionSeeks, droppedFrame, errorWindows, parseServerJSONL, verdict } from '../stage2/stats.mjs';
import { startBots } from '../stage2/bots.mjs';
import { pageMetrics, boundedJSON } from '../stage2/metrics.mjs';
import { summarizeStage2, renderStage2 } from '../summarize_stage2.mjs';
import { serverArgs } from '../lib/server.mjs';
const base = () => ({ scenario: 'steady', condition: 'default', n: 2, ok: true, setup_failed: false, metrics: {}, server: {} });
test('stage2 plan fixes N, conditions, CPU variants, profiling-only accumulation and smoke sizes', () => {
  const jobs = plan(options([]));
  assert.deepEqual([...new Set(jobs.filter(j => j.scenario === 'steady' && j.condition === 'default').map(j => j.n))], [2,10,14,15,16,25]);
  assert.deepEqual([...new Set(jobs.filter(j => j.scenario === 'steady' && j.condition === 'pool-250').map(j => j.n))], [10,25,50,100,200]);
  assert.equal(jobs.filter(j => j.scenario === 'chat_accumulation').length, 3);
  assert.ok(jobs.every(j => j.profiling === (j.scenario === 'chat_accumulation')));
  assert.ok(jobs.some(j => j.condition === 'pool-250-cpu4' && j.cpu === 4 && j.pool === 250));
  assert.ok(jobs.filter(j => j.scenario === 'join_burst').every(j => j.n >= 3));
  assert.ok(plan(options(['--smoke'])).every(j => j.run === 1 && (j.n === 2 || j.n === 10 || j.scenario === 'chat_accumulation' && j.n === 3)));
});
test('delivery uses exact marker identities, first display time, duplicates and separate control loss', () => {
  const a='c-b0-1-1000', b='c-b0-10-1100', c='c-g-1-1200';
  const m = delivery([a,b,c], [[a,1100,2],[c,1500,1]], new Set([a,b]));
  assert.equal(m.lost,1); assert.equal(m.duplicates,1); assert.equal(m.server_side_lost,1);
  assert.deepEqual(m.delivery_values_ms,[100,300]); assert.equal(m.delivery_ms.p75,300); assert.equal(m.delivery_ms.p95,300);
  assert.equal(delivery([a],[],null).server_side_lost,null);
});
test('correction seeks exclude initial sync and latest pause/seek actions', () => {
  const frames=[{t:0,action:'play'},{t:1000,action:'pause'},{t:4000,action:'play'},{t:4500,action:'seek'},{t:6000,action:'play'}];
  assert.equal(correctionSeeks([100,1100,4100,4600,7000,7001],frames,1000),2);
});
test('dropped frames follow the fixed 16.67ms rule', () => {
  assert.equal(droppedFrame(16.67),0); assert.equal(droppedFrame(50.01),2); assert.equal(droppedFrame(1),0);
});
test('error windows exclude pause, post-seek 1.5s and split entry versus post-resume', () => {
  const host=Array.from({length:101},(_,i)=>({t:i*100,ct:i/10,paused:i>=20&&i<30}));
  const guest=host.map(s=>({...s,ct:s.ct-(s.t<2000?.1:s.t>=5000&&s.t<6500?9:.25)}));
  const e=errorWindows(host,guest,[{t:2000,action:'pause'},{t:3000,action:'play'},{t:5000,action:'seek'}],10000);
  assert.ok(Math.abs(e.join.p95-100)<1e-6); assert.equal(e.steady.p95,250);
});
for (const [code,change] of [
  ['SCRIPT_ERROR',r=>{r.ok=false;}],['SETUP_FAILED',r=>{r.setup_failed=true;}],['PLAY_CORRECTION',r=>{r.metrics.play_correction_seeks=1;}],
  ['LOST',r=>{r.metrics.lost=1;}],['DUPLICATES',r=>{r.metrics.duplicates=1;}],['BOT_LOST',r=>{r.metrics.server_side_lost=1;}],
  ['JOIN_FAILED',r=>{r.metrics.join_failed=true;}],['JOIN_FAILED',r=>{r.metrics.bot_join_failed=1;}],
  ['RETRY_EXHAUSTED',r=>{r.metrics.bot_gave_up=1;}],['RETRY_EXHAUSTED',r=>{r.metrics.browser_gave_up=1;}],
  ['QUEUE_POOL',r=>{r.server.queuepool_errors=1;}],['DISCONNECTED',r=>{r.metrics.bot_disconnects=1;}],
  ['DISCONNECTED',r=>{r.metrics.host_disconnects=1;}],['DISCONNECTED',r=>{r.metrics.guest_disconnects=1;}],['DISCONNECTED',r=>{r.metrics.joiner_disconnects=1;}],
]) test(`stage2 verdict: ${code} ${change.toString()}`,()=>{const r=base();change(r);assert.ok(verdict(r).reasons.includes(code));assert.equal(verdict(r).pass,false);});
test('fixed external thresholds, self goal and instrument-load label do not remove rounds',()=>{
  const r=base();r.metrics={inp_ms:201,delivery_ms:{p95:1001},err_ms:{p95:501},bot_event_loop:{p95_ms:101}};
  const d=verdict(r);assert.equal(d.measurement_load,true);assert.deepEqual(d.external,{inp_over_200:true,delivery_p95_over_1000:true,err_p95_over_500:true});
  const bad=base();bad.metrics.lost=1;
  const g=summarizeStage2([r,bad])[0];assert.equal(g.status,'FAIL');assert.equal(g.rounds,2);assert.equal(g.metrics.inp_ms.missing,1);
  const text=renderStage2([g]);assert.match(text,/측정기 부하/);assert.match(text,/공인 기준이 없는 자체 목표/);assert.match(text,/시험 조건/);
});
test('skip only larger pool N after all three setup service failures, never default or script failure',()=>{
  const job={scenario:'steady',condition:'pool-250',n:50};
  const rounds=Array.from({length:3},()=>({...job,n:25,setup_failed:true,ok:true}));
  assert.equal(skipAfterFailures(job,rounds,3),true);
  assert.equal(skipAfterFailures({...job,n:25},rounds,3),false);
  assert.equal(skipAfterFailures(job,rounds.slice(0,2),3),false);
  assert.equal(skipAfterFailures({...job,condition:'default'},rounds,3),false);
  assert.equal(skipAfterFailures(job,[...rounds.slice(0,2),{...rounds[2],ok:false}],3),false);
});
test('server JSONL parser preserves aggregate rows and rejects truncated lines explicitly',()=>{
  assert.deepEqual(parseServerJSONL('{"t":1,"pool":{"checked_out":3}}\n\n'),[{t:1,pool:{checked_out:3}}]);
  assert.throws(()=>parseServerJSONL('{"t":'),/line 1/);
});
test('without --instrument all stage1 launch arguments remain byte-for-byte identical',()=>{
  const args=serverArgs('b86324b','loadtest_test',250);
  assert.deepEqual(serverArgs('b86324b','loadtest_test',250,null),args);
  assert.equal(args.includes('--instrument'),false);
  assert.deepEqual(serverArgs('b86324b','loadtest_test',250,'/tmp/fixture.jsonl'),[...args,'--instrument','/tmp/fixture.jsonl']);
});
test('normal React build reports null durations, profiling build reports supplied actualDuration',()=>{
  const data={memory:[[1,10,20],[2,30,40]],longtasks:[[1,60]],commits:[[1,2],[2,4]],inp:[[2,100]],inputs:[1],raf:{0:[10,2]}};
  assert.equal(pageMetrics(data,0,3,false).react_commit_ms.p95,null);
  const m=pageMetrics(data,0,3,true);assert.equal(m.react_commit_ms.p95,4);assert.equal(m.react_commits,2);assert.equal(m.heap_max,30);assert.equal(m.dropped_frames,2);
});
test('2MB guard preserves media samples and explicitly marks oversized diagnostic rounds as script failure',()=>{
  const r={ok:true,errors:[],metrics:{raw:{host_samples:[[1,2,false]],guest_samples:[[1,2,false]],extra:'x'.repeat(2100000)}}};
  const text=boundedJSON(r);assert.ok(Buffer.byteLength(text)<=2*1024*1024);assert.equal(r.ok,false);assert.ok(r.errors[0].includes('RESULT_SIZE_LIMIT'));assert.deepEqual(r.metrics.raw.host_samples,[[1,2,false]]);
});
test('Python instrumentation histogram approximates p95 and preserves async broadcast signature',()=>{
  const code=`import sys, importlib.util, inspect, asyncio, io, json
spec=importlib.util.spec_from_file_location('instrument',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
a=m.Aggregate()
for v in [1,2,3,4,5]: a.add(v)
r=a.result(); assert r['count']==5 and r['sum_ms']==15 and r['max_ms']==5 and r['p95_ms_approx']==5
handlers={}
class App:
 @property
 def router(self): return self
 def add_event_handler(self,name,callback): handlers[name]=callback
class Manager:
 active_connections={1:[1,2,3]}
 async def broadcast_to_room(self,room_id,message): return 'sent'
class Pool:
 def checkedout(self): return 3
 def overflow(self): return 0
class Engine: pool=Pool()
class Stream(io.StringIO):
 def close(self): pass
stream=Stream()
class Target:
 @property
 def parent(self): return self
 def mkdir(self,**kwargs): pass
 def open(self,*args,**kwargs): return stream
m.install(App(),Engine(),Manager,Target())
assert inspect.iscoroutinefunction(Manager.broadcast_to_room)
async def verify():
 await handlers['startup']()
 assert await Manager().broadcast_to_room(1,{}) == 'sent'
 await asyncio.sleep(.12)
 await handlers['shutdown']()
asyncio.run(verify())
row=json.loads(stream.getvalue().splitlines()[0])
assert row['broadcast']['count']==1 and row['connections']['max']==3 and row['connections']['sum']==3
assert row['pool']==dict(checked_out=3,overflow=0) and row['event_loop']['count']>=1
print('instrument aggregate OK')`;
  const r=spawnSync('python3',['-c',code,new URL('../server/instrument.py',import.meta.url).pathname],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/aggregate OK/);
});

test('bot child IPC drains its final reply and confirms process exit without browsers or DB', async () => {
  const bots=await startBots();
  try {
    const snap=await bots.snapshot(); assert.equal(snap.connected,0); assert.deepEqual(snap.sent,[]);
    const final=await bots.stop(); assert.equal(final.attempted,0); assert.equal(bots.child.exitCode,0);
  } finally { await bots.kill(); }
});
test('rAF intervals at partial-second boundaries are counted using actual timestamps',()=>{
  const data={memory:[],longtasks:[],commits:[],inp:[],inputs:[],raf:{0:[10,9]},raf_events:[[99,3],[100,1],[200,2],[201,4]]};
  const result=pageMetrics(data,100,200,false);assert.equal(result.total_frames,2);assert.equal(result.dropped_frames,3);
});
test('shared readyHost keeps stage1 navigation by default and can reuse the already-entered stage2 host',async()=>{
  const {readyHost}=await import('../lib/browser.mjs');
  for(const entered of [false,true]){
    let navigations=0,click=0;
    const state={attempts:[1],frames:[{}],sent:[],page:{
      async goto(){navigations++;},async evaluate(){return Date.now();},
      locator(){return {async click(){state.sent.push({t:Date.now(),data:{type:'sync',action:++click===1?'pause':'play'}});}};}
    }};
    if(entered)await readyHost(state,{room_code:'ABC'},true);else await readyHost(state,{room_code:'ABC'});
    assert.equal(navigations,entered?0:1);assert.deepEqual(state.sent.map(s=>s.data.action),['pause','play']);
  }
});
