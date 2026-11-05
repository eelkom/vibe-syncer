import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { parseSleepLog, readSleepLog, sleepStatus } from '../stage2/sleep.mjs';
import { verdict, machineStatus, shouldStopBatch } from '../stage2/stats.mjs';
import { shouldRun, options } from '../stage2/config.mjs';
import { recomputeStall, isRunFile } from '../recompute_stage2_stall.mjs';
import { ownBrowser, closeOwnedBrowser } from '../stage2/browser-process.mjs';
import { receiveControl, controlRows, controlDelivery } from '../stage2/control.mjs';
import { metrics } from '../stage2/metrics.mjs';
import { makePage, launchStage2 } from '../stage2/browser.mjs';
import { chromium } from 'playwright';
import { summarizeStage2, renderStage2 } from '../summarize_stage2.mjs';
const line = (time, domain) => `2026-11-05 ${time} +0900    ${domain}       unrelated Sleep text`;
const log = parseSleepLog(['PM ASL data store: ignored',line('00:40:00','Assertions'),line('00:46:00','Sleep'),
  line('00:47:00','DarkWake'),line('00:48:00','Wake Requests'),line('00:49:00','PM Client Acks'),
  line('00:50:00','Assertions'),line('00:51:00','SleepService'),line('00:52:00','Wake')].join('\n'));
const start = '2026-11-04T15:45:00Z', end = '2026-11-04T15:46:00Z';
test('pmset parser only counts timestamp + exact Sleep domain and respects numeric offsets', () => {
  assert.deepEqual(log.sleep_events, [Date.parse('2026-11-04T15:46:00Z')]);
  assert.equal(log.first_at, Date.parse('2026-11-04T15:40:00Z'));
  assert.deepEqual(parseSleepLog('invalid timestamp Sleep\n2026-11-05 01:00:00 -0400 Sleep\n').sleep_events,
    [Date.parse('2026-11-05T05:00:00Z')]);
  assert.deepEqual(sleepStatus(start, end, log), { machine_stalled: true, machine_sleep_events: [new Date(end).toISOString()], machine_stall_unknown: false });
  assert.equal(sleepStatus('2026-11-04T15:46:01Z','2026-11-04T15:50:00Z',log).machine_stalled, false);
});
test('missing or truncated OS log coverage is unknown, never inferred from a page gap', () => {
  assert.equal(sleepStatus('2026-11-04T15:30:00Z',end,log).machine_stall_unknown, true);
  assert.equal(sleepStatus(start,end,parseSleepLog('headers only')).machine_stall_unknown, true);
  assert.equal(sleepStatus(start,end,null).machine_stalled, false);
  assert.equal(sleepStatus('bad',end,log).machine_stall_unknown, true);
  assert.throws(() => readSleepLog(() => { throw new Error('pmset denied'); }), /pmset denied/);
  const parsed = readSleepLog((cmd,args,opts) => { assert.equal(cmd,'pmset'); assert.deepEqual(args,['-g','log']); assert.ok(opts.maxBuffer > 0); return line('00:46:00','Sleep'); });
  assert.equal(parsed.sleep_events.length,1);
});
test('large guest-only or shared gaps remain valid for classification and are not selected by rerun-invalid', () => {
  for (const gaps of [[200,12000],[5200,5200]]) {
    const run = { ok:true, metrics:{ machine_stalled:false, raw:{host_samples:[[0],[gaps[0]]],guest_samples:[[0],[gaps[1]]] } } };
    assert.equal(machineStatus(run).machine_stalled,false); assert.equal(verdict(run).status,'PASS');
    assert.equal(shouldRun(run,options(['--rerun-invalid'])),false);
  }
  const stalled = {ok:false,metrics:{machine_stalled:true,lost:99}};
  assert.deepEqual(verdict(stalled).reasons,['INVALID_MACHINE_STALL']);assert.equal(shouldStopBatch(stalled),false);
});
test('recompute changes only OS/gap fields and verdict; old false exclusions are removed', () => {
  const run = { scenario:'chat_burst',condition:'pool-250-cpu4',n:100,ok:true,started_at:'2026-11-04T15:47:00Z',finished_at:'2026-11-04T15:48:00Z',
    errors:['keep'],server:{rss:123},metrics:{machine_stalled:true,max_sample_gap_ms:12000,inp_ms:900,
      raw:{host_samples:[[0],[200]],guest_samples:[[0],[12000]]}},verdict:{status:'INVALID'} };
  const before=JSON.stringify(run), updated=recomputeStall(run,log);
  assert.equal(updated.metrics.machine_stalled,false);assert.equal(updated.metrics.machine_stall_unknown,false);
  assert.equal(updated.metrics.max_gap_host_ms,200);assert.equal(updated.metrics.max_gap_guest_ms,12000);
  assert.equal(updated.verdict.status,'PASS');assert.equal(JSON.stringify(run),before);
  const permitted=new Set(['machine_stalled','machine_sleep_events','machine_stall_unknown','max_sample_gap_ms','max_gap_host_ms','max_gap_guest_ms']);
  const originalMetrics=Object.fromEntries(Object.entries(run.metrics).filter(([k])=>!permitted.has(k)));
  const preserved=Object.fromEntries(Object.entries(updated.metrics).filter(([k])=>!permitted.has(k)));
  assert.deepEqual(preserved,originalMetrics);
  assert.deepEqual({...updated,metrics:null,verdict:null},{...run,metrics:null,verdict:null});
  const unknown=recomputeStall({...run,started_at:'2026-11-04T15:00:00Z'},parseSleepLog(line('00:47:00','Assertions')));
  assert.equal(unknown.metrics.machine_stall_unknown,true);assert.equal(unknown.metrics.machine_stalled,false);
  assert.equal(isRunFile('run-3.json'),true);assert.equal(isRunFile('run-3.previous-2026.json'),false);assert.equal(isRunFile('env-1.json'),false);
});
test('control receive records count and first receipt without JSON decoding; guest uses socket-send time', () => {
  const control=new Map();receiveControl(control,Buffer.from('not-json c-b0-1-100 c-g-1-50'),200);
  receiveControl(control,Buffer.from('c-b0-1-100'),500);
  assert.deepEqual(controlRows(control),[['c-b0-1-100',2,200],['c-g-1-50',1,200]]);
  const result=controlDelivery(['c-b0-1-100','c-g-1-50','c-b0-2-100'],controlRows(control),new Map([['c-g-1-50',180]]));
  assert.deepEqual(result.control_delivery_values_ms,[100,20]);assert.equal(result.control_delivery_ms.p50,60);
  assert.equal(result.control_delivery_ms.p75,100);assert.equal(result.control_delivery_ms.p95,100);
  assert.equal(controlDelivery(['c-b0-1-100'],[['c-b0-1-100',1]]).control_delivery_count,0);
});
const observation=()=>({samples:[],memory:[],longtasks:[],raf:{},commits:[],inp:[],inputs:[],sync:[],seeks:[],sent:[],ws:[],system_events:[],welcome_events:[],displayed:[]});
test('unresponsive observer keeps console data and control latency, without inventing DOM/guest latency', async () => {
  const page=new EventEmitter();page.addInitScript=async()=>{};
  const guest=await makePage({newContext:async()=>({newPage:async()=>page})},null,{errors:[]},[]);
  for (const [prefix,value] of [['__stage2_delivered',{marker:'c-g-1-50',t:200}],['__stage2_checkpoint',{target:100,t:210,heap:42}],
    ['__stage2_ws',{connected:true,t:10}],['__stage2_controls',{controls:{},media:{ct:12},t:220}]]) page.emit('console',{type:()=> 'debug',text:()=>`${prefix} ${JSON.stringify(value)}`});
  guest.unresponsive=true;
  const ctx={start:0,end:1000,job:{scenario:'chat_burst',n:3},actions:[],inputs:[],guest};
  const bots={sent:[[0,1,100,true]],control:[['c-b0-1-100',1,180]],bots:[{closes:[],join_ms:1}],gave_up:0,event_loop:{}};
  const m=metrics(ctx,observation(),null,bots);
  assert.equal(m.inp_ms,null);assert.equal(m.lost,null);assert.equal(m.page_unresponsive,true);
  assert.equal(m.control_delivery_ms.p95,80);assert.equal(m.console_observations.guest.unique_guest_markers,1);
  assert.deepEqual(m.console_observations.guest.delivered,[['c-g-1-50',200]]);
  assert.equal(m.console_observations.guest.checkpoints[0].heap,42);assert.equal(m.console_observations.guest.media.ct,12);
  const run={scenario:'chat_burst',condition:'default',n:3,ok:true,metrics:m};
  const g=summarizeStage2([run])[0];assert.equal(g.metrics['control_delivery_ms.p95'].max,80);
  assert.match(renderStage2([g]),/OS 로그|Sleep/);
});

async function child() {
  const proc=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
  await once(proc.stdout,'data');return proc;
}
async function killTestChild(proc) {
  if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill('SIGKILL');await done;}
}
test('stage2 launch tracks only its public BrowserServer process and retains fixed browser flags', async t => {
  const child=new EventEmitter();Object.assign(child,{pid:12345,exitCode:null,signalCode:null});
  const server={process:()=>child,wsEndpoint:()=> 'ws://127.0.0.1/owned'};
  const browser={version:()=> 'test'};let launched;
  t.mock.method(chromium,'launchServer',async opts=>{launched=opts;return server;});
  t.mock.method(chromium,'connect',async endpoint=>{assert.equal(endpoint,server.wsEndpoint());return browser;});
  const owned=[];assert.equal(await launchStage2(owned,true),browser);
  assert.equal(owned[0].pid,12345);assert.equal(owned[0].browser,browser);
  assert.equal(launched.host,'127.0.0.1');assert.equal(launched.headless,true);
  for(const flag of ['--mute-audio','--disable-features=HardwareMediaKeyHandling','--enable-precise-memory-info',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--autoplay-policy=no-user-gesture-required']) assert.ok(launched.args.includes(flag));
  child.emit('exit',0,null);
});
test('owned-browser timeout kills and confirms only its child, leaving another process alive', async () => {
  const owned=await child(), unrelated=await child();let killed=0;
  try {
    const server={process:()=>owned,close:()=>new Promise(()=>{}),kill:async()=>{killed++;await killTestChild(owned);}};
    const owner=ownBrowser(server);owner.browser={close:()=>new Promise(()=>{})};
    const result=await closeOwnedBrowser(owner,20);
    assert.deepEqual(result,{forced:true});assert.equal(killed,1);assert.equal(owned.signalCode,'SIGKILL');
    assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null);
  } finally {await killTestChild(owned);await killTestChild(unrelated);}
});
test('graceful owned browser waits for exit and does not request SIGKILL', async () => {
  const proc=await child();let killed=0;
  try {
    const owner=ownBrowser({process:()=>proc,close:async()=>{const exited=once(proc,'exit');proc.kill('SIGINT');await exited;},kill:async()=>{killed++;}});
    owner.browser={close:async()=>{}};
    assert.deepEqual(await closeOwnedBrowser(owner,1000),{forced:false});assert.equal(killed,0);
  } finally {await killTestChild(proc);}
});
test('other browser cleanup errors remain errors after owned process cleanup', async () => {
  const proc=await child();
  try {
    const owner=ownBrowser({process:()=>proc,close:async()=>{},kill:async()=>killTestChild(proc)});
    owner.browser={close:async()=>{throw new Error('other cleanup failure');}};
    await assert.rejects(closeOwnedBrowser(owner,1000),/other cleanup failure/);assert.equal(proc.signalCode,'SIGKILL');assert.equal(owner.forced,true);
  } finally {await killTestChild(proc);}
});
test('an unconfirmed owned process exit is an error, never a successful forced cleanup', async () => {
  const proc=await child();
  try {
    const owner=ownBrowser({process:()=>proc,close:()=>new Promise(()=>{}),kill:async()=>{}});
    owner.browser={close:async()=>{}};
    await assert.rejects(closeOwnedBrowser(owner,20),/SIGKILL exit/);
    assert.equal(owner.forced,false);assert.equal(proc.exitCode,null);assert.equal(proc.signalCode,null);
  } finally {await killTestChild(proc);}
});
