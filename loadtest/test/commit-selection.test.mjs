import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/common.mjs';
import { parseArgs, plan as stage1Plan, COMPARISONS } from '../lib/config.mjs';
import { options, plan as stage2Plan, skipAfterFailures } from '../stage2/config.mjs';
import { validateCommit, resolveCommit, validateArchive } from '../lib/commit.mjs';
import { serverArgs } from '../lib/server.mjs';
import { summarizeStage2 } from '../summarize_stage2.mjs';
const fixed = 'abcdef0', full = fixed + '1'.repeat(33);
test('stage1 commit override selects only the requested commit and retains scenario conditions/runs', () => {
  for (const scenario of ['late_join','autoplay']) {
    const jobs=stage1Plan(parseArgs(['--scenario',scenario,'--commit',fixed]));
    assert.ok(jobs.every(j=>j.sha===fixed&&j.serverSha===fixed));
    assert.equal(jobs.length,scenario==='autoplay'?15:5);
    assert.deepEqual([...new Set(jobs.map(j=>j.condition))],scenario==='autoplay'?['muted-allowed','all-blocked','silent-blocked']:['default']);
  }
  const smoke=stage1Plan(parseArgs(['--scenario','autoplay','--commit',fixed,'--smoke','--condition','silent-blocked']));
  assert.equal(smoke.length,1);assert.equal(smoke[0].runNumber,1);
});
test('stage1 rejects commit override for all or any unsupported scenario, preserving default comparisons', () => {
  for (const scenario of ['all','message_burst','history_race','reconnect']) assert.throws(()=>parseArgs(['--scenario',scenario,'--commit',fixed]),/requires --scenario/);
  for (const [scenario,commits] of Object.entries(COMPARISONS)) {
    assert.deepEqual([...new Set(stage1Plan(parseArgs(['--scenario',scenario])).map(j=>j.sha))],commits);
  }
});
test('SHA validation rejects paths, refs and missing values before running git; canonical short SHA matches archives', () => {
  for (const value of [undefined,'','HEAD','../abcdef0','xyz1234','abc123','a'.repeat(41),'--help']) {
    assert.throws(()=>validateCommit(value),/hexadecimal/);
    assert.throws(()=>parseArgs(['--scenario','late_join','--commit',value]),/hexadecimal/);
    assert.throws(()=>options(['--commit',value]),/hexadecimal/);
  }
  const calls=[];
  const resolved=resolveCommit(full,(cmd,args)=>{calls.push([cmd,args]);return calls.length===1?full+'\n':fixed+'\n';});
  assert.deepEqual(resolved,{sha:fixed,full});
  assert.deepEqual(calls,[['git',['rev-parse','--verify',full+'^{commit}']],['git',['rev-parse','--short=7',full]]]);
  assert.equal(resolveCommit('b86324b').sha,'b86324b');
});
test('stage2 defaults retain existing N plans; commit override applies to all selected jobs', () => {
  const defaults=stage2Plan(options([]));assert.ok(defaults.every(j=>j.sha==='b86324b'));
  const jobs=stage2Plan(options(['--commit',fixed,'--n','200,2,10,10,25']));
  assert.ok(jobs.every(j=>j.sha===fixed));
  assert.deepEqual([...new Set(jobs.filter(j=>j.scenario==='steady'&&j.condition==='default').map(j=>j.n))],[2,10,25]);
  assert.deepEqual([...new Set(jobs.filter(j=>j.scenario==='steady'&&j.condition==='pool-250').map(j=>j.n))],[10,25,200]);
  assert.ok(jobs.filter(j=>j.condition==='pool-250-cpu4').every(j=>j.cpu===4&&j.pool===250));
  assert.ok(!jobs.some(j=>j.scenario==='chat_accumulation'));
  const accumulation=stage2Plan(options(['--scenario','chat_accumulation','--commit',fixed,'--n','3']));
  assert.equal(accumulation.length,3);assert.ok(accumulation.every(j=>j.profiling&&j.n===3&&j.sha===fixed));
});
test('stage2 N validation rejects malformed/unavailable sizes and smoke still reduces durations/runs', () => {
  for (const value of [undefined,'','2,','1','0','-2','NaN','2.5','2,,10','9007199254740992']) assert.throws(()=>options(['--n',value]),/--n/);
  assert.throws(()=>stage2Plan(options(['--n','99'])),/N not in/);
  assert.throws(()=>stage2Plan(options(['--scenario','join_burst','--n','2'])),/N not in/);
  const jobs=stage2Plan(options(['--smoke','--commit',fixed,'--n','10']));
  assert.ok(jobs.every(j=>j.run===1&&j.n===10&&j.sha===fixed));
});
test('archive validation checks the selected SHA, backend, frontend and profiling artifacts', async () => {
  const logs=path.join(ROOT,'.logs');await mkdir(logs,{recursive:true});
  const root=await mkdtemp(path.join(logs,'commit-archive-test-'));
  const base=path.join(root,'.baselines',fixed),resolve=()=>({sha:fixed,full});
  try {
    await mkdir(path.join(base,'backend'),{recursive:true});
    await writeFile(path.join(base,'.archive-sha'),'f'.repeat(40));
    await assert.rejects(validateArchive(fixed,{root,resolve,frontend:false}),/Archive SHA mismatch/);
    await writeFile(path.join(base,'.archive-sha'),full+'\n');
    assert.deepEqual(await validateArchive(fixed,{root,resolve,frontend:false}),{sha:fixed,full});
    await assert.rejects(validateArchive(fixed,{root,resolve}),/prepare_commit.sh abcdef0/);
    await mkdir(path.join(base,'frontend/dist'),{recursive:true});await writeFile(path.join(base,'frontend/dist/index.html'),'fixture');
    assert.deepEqual(await validateArchive(fixed,{root,resolve}),{sha:fixed,full});
    await assert.rejects(validateArchive(fixed,{root,resolve,profiling:true}),/prepare_profiling.sh abcdef0/);
    await mkdir(path.join(base,'frontend/dist-profiling'));await writeFile(path.join(base,'frontend/dist-profiling/index.html'),'fixture');
    assert.deepEqual(await validateArchive(fixed,{root,resolve,profiling:true}),{sha:fixed,full});
    assert.ok(serverArgs(fixed,'loadtest_fixture').some(arg=>arg.endsWith(`/.baselines/${fixed}/backend`)));
  } finally {await rm(root,{recursive:true,force:true});}
});
test('stage2 summaries and capacity skip rules never mix comparison commits', () => {
  const main={scenario:'steady',condition:'pool-250',n:25,run:1,ok:true,setup_failed:true,commit:'b86324b',metrics:{inp_ms:100}};
  const changed={...main,commit:fixed,metrics:{inp_ms:500}};
  const groups=summarizeStage2([main,changed]);assert.equal(groups.length,2);
  assert.equal(groups.find(g=>g.key.includes('/b86324b/')).metrics.inp_ms.median,100);
  assert.equal(groups.find(g=>g.key.includes('/abcdef0/')).metrics.inp_ms.median,500);
  const old=[main,{...main,run:2},{...main,run:3}];
  assert.equal(skipAfterFailures({scenario:'steady',condition:'pool-250',n:50,sha:fixed},old,3),false);
  assert.equal(skipAfterFailures({scenario:'steady',condition:'pool-250',n:50,sha:'b86324b'},old,3),true);
});
