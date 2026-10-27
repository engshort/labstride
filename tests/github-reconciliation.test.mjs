import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {chmodSync,existsSync} from 'node:fs';
import {startCoordinator} from '../apps/coordinator/main.ts';
import {createGitHubWorker} from '../packages/core/github-worker.ts';
import {GitHubError} from '../packages/core/github.ts';
import {readStatus} from '../packages/operations/inspection.ts';
import {githubFixture,localAuthority,context} from './helpers/github-fixture.mjs';
const counts=f=>{const db=new DatabaseSync(join(f.root,'state.sqlite'));try{return Object.fromEntries(['requests','runs','workspaces','operations','outbox'].map(table=>[table,Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)]));}finally{db.close();}};

test('initial import is inert; a missed current transition admits one generation across concurrent workers and restart',async t=>{
  const f=await githubFixture(t);await f.worker.tick();assert.equal(counts(f).runs,0);
  f.advance();f.change();const other=createGitHubWorker(f.store,f.options);
  await Promise.all([f.worker.tick(),f.worker.tick(),other.tick()]);
  assert.deepEqual(counts(f),{requests:1,runs:1,workspaces:1,operations:1,outbox:1});
  const original=f.store.get('run','run-example-001');
  const reboot=startCoordinator(f.root,{policyAuthority:localAuthority,clock:{now:f.now}});t.after(()=>reboot.store.close());
  const worker=createGitHubWorker(reboot.store,f.options);f.advance();await worker.tick();
  assert.deepEqual(reboot.store.get('run','run-example-001'),original);assert.equal(counts(f).runs,1);
});
test('historical matching status and newly re-added membership cannot import a start',async t=>{
  const f=await githubFixture(t);f.change();await f.worker.tick();assert.equal(counts(f).runs,0);
  f.present(false);f.advance();await f.worker.tick();f.present(true);f.advance();
  f.events.push({...f.events[0],id:'membership-2'});await f.worker.tick();assert.equal(counts(f).runs,0);
});
test('same-second events are reconstructed from state links, not returned order',async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();f.change(null);f.change();
  [f.events[1],f.events[2]]=[f.events[2],f.events[1]];await f.worker.tick();assert.equal(counts(f).runs,1);
});
test('ambiguous event order is diagnostic and creates no execution graph',async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();f.change();f.change('wait-a');f.change();f.change('wait-a');f.change();
  await f.worker.tick();assert.equal(counts(f).runs,0);assert.equal(f.store.githubItemDiagnostics(f.key)[0].code,'history_ambiguous');
});
test('impossible same-second histories have bounded classification work',{timeout:2000},async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();f.item.fields.request={present:true,value:'go-a'};
  for(let i=0;i<12;i++)f.events.push({id:`self-${i}`,kind:'status',scopeId:'scope-a',actorId:'operator-test',occurredAt:f.now(),previousStatus:'Waiting',status:'Waiting'});
  await f.worker.tick();assert.equal(counts(f).runs,0);assert.equal(f.store.githubItemDiagnostics(f.key)[0].code,'history_ambiguous');
});
test('stable option IDs survive display renames and a renamed start value is admitted',async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.item.optionNames.request['go-a']='Execute';f.item.optionNames.request['wait-a']='Backlog';f.advance();f.change();
  await f.worker.tick();assert.equal(counts(f).runs,1);
});
test('ambiguous historical option names do not bind to a different ID',async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.item.optionNames.request['go-a']='Waiting';f.advance();f.change();await f.worker.tick();
  assert.equal(counts(f).runs,0);assert.equal(f.store.githubItemDiagnostics(f.key)[0].code,'history_ambiguous');
});
for(const actor of [null,'unapproved-actor'])test(`independent history actor ${actor} cannot authorize a run`,async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();f.change('go-a',actor);await f.worker.tick();assert.equal(counts(f).runs,0);
});
test('a fetched transition with no corresponding history is blocked',async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();f.item.fields.request={present:true,value:'go-a'};await f.worker.tick();
  assert.equal(counts(f).runs,0);assert.equal(f.store.githubItemDiagnostics(f.key)[0].code,'history_unavailable');
});
test('delayed provider history retains the previous field baseline and recovers the original transition after restart',async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();f.item.fields.request={present:true,value:'go-a'};await f.worker.tick();assert.equal(counts(f).runs,0);
  f.events.push({id:'late-status',kind:'status',scopeId:'scope-a',actorId:'operator-test',occurredAt:f.now(),previousStatus:'Waiting',status:'Start'});
  const reboot=startCoordinator(f.root,{policyAuthority:localAuthority,clock:{now:f.now}});t.after(()=>reboot.store.close());
  f.advance();await createGitHubWorker(reboot.store,f.options).tick();assert.equal(counts(f).runs,1);
});
test('partial history pages survive reopening and cannot start until terminal provider refresh',async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();f.change();
  f.adapter.history=async()=>({schemaVersion:'1.0',events:[f.events.at(-1)],hasNextPage:true,endCursor:'page-2'});
  await f.worker.tick();assert.equal(counts(f).runs,0);assert.equal(f.store.githubItems(f.key)[0].cursor,'page-2');
  f.adapter.history=async()=>({schemaVersion:'1.0',events:[],hasNextPage:false,endCursor:'page-2'});
  const reboot=startCoordinator(f.root,{policyAuthority:localAuthority,clock:{now:f.now}});t.after(()=>reboot.store.close());
  await createGitHubWorker(reboot.store,f.options).tick();assert.equal(counts(f).runs,1);
});
test('invalid history cursor rebuilds an inert baseline without deleting existing identities',async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();f.change();const history=f.adapter.history;
  f.adapter.history=async()=>{throw new GitHubError('invalid_cursor');};await f.worker.tick();assert.equal(counts(f).runs,0);
  f.adapter.history=history;f.advance();await f.worker.tick();assert.equal(counts(f).runs,0);
});
for(const code of ['graphql_errors','rate_limited','credential_expired'])test(`${code} preserves checkpoints and applies durable backoff`,async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();const before=f.store.githubStatus(f.key);
  f.adapter.list=async()=>{throw new GitHubError(code,120000);};await f.worker.tick();const after=f.store.githubStatus(f.key);
  assert.equal(after.cursor,before.cursor);assert.equal(after.epoch,before.epoch);assert.equal(after.lastError,code);
  const calls=f.calls();await f.worker.tick();assert.equal(f.calls(),calls);assert.ok(Date.parse(after.nextAt)>=Date.parse(f.now())+120000);
});
test('a newer human edit after candidate persistence supersedes the pending start',async t=>{
  const f=await githubFixture(t);await f.worker.tick();f.advance();f.change();
  const admit=f.store.admitGitHubCandidate.bind(f.store);let first=true;
  f.store.admitGitHubCandidate=()=>null;await f.worker.tick();assert.equal(f.store.githubCandidates(f.key).length,1);
  f.store.admitGitHubCandidate=admit;f.change('wait-a');await f.worker.tick();assert.equal(counts(f).runs,0);assert.equal(f.store.githubCandidates(f.key).length,0);
});

test('incomplete native history blocks only its item and retries at the next enumeration',async t=>{
  const f=await githubFixture(t,{native:true}),blocked=structuredClone(f.item),blockedEvents=[];
  blocked.itemId=blocked.subjectId='incomplete-issue';blocked.fields.request={present:false};
  let blockedReads=0;
  f.adapter.list=async()=>({items:[structuredClone(blocked),structuredClone(f.item)],hasNextPage:false,endCursor:'list-cursor'});
  f.adapter.item=async id=>structuredClone(id===blocked.itemId?blocked:f.item);
  f.adapter.history=async id=>{if(id===blocked.subjectId)blockedReads++;return{schemaVersion:'1.0',events:structuredClone(id===blocked.subjectId?blockedEvents:f.events),hasNextPage:false,endCursor:'history-cursor'};};
  await f.worker.tick();f.advance();blocked.fields.request={present:true,value:'go-a'};
  blockedEvents.push({id:'redacted-added-event',kind:'status',scopeId:'scope-a',fieldId:'request-a',actorId:'operator-test',occurredAt:f.now(),previousStatus:null,status:null});
  f.change();await f.worker.tick();
  assert.equal(counts(f).runs,1);assert.equal(f.store.get('request',f.store.runs()[0].requestId).issueId,'issue-test');
  assert.deepEqual(f.store.githubItemDiagnostics(f.key),[{itemId:blocked.itemId,code:'history_ambiguous'}]);
  assert.equal(f.store.githubStatus(f.key).lastError,null);
  for(const suffix of ['', '-wal', '-shm']){const path=join(f.root,'state.sqlite'+suffix);if(existsSync(path))chmodSync(path,0o600);}
  assert.equal(readStatus(f.root).providers[0].blockedItems,1);
  const reads=blockedReads;await f.worker.tick();assert.equal(blockedReads,reads);
  f.advance();await f.worker.tick();assert.equal(blockedReads,reads+1);assert.equal(counts(f).runs,1);
});

test('an earlier pending candidate cannot bypass a later item history diagnostic',async t=>{
  const f=await githubFixture(t,{native:true});await f.worker.tick();f.advance();f.change();
  const admit=f.store.admitGitHubCandidate.bind(f.store);f.store.admitGitHubCandidate=()=>null;
  await f.worker.tick();assert.equal(f.store.githubCandidates(f.key).length,1);
  f.store.admitGitHubCandidate=admit;f.advance();
  // Keep the current item/version equal to the candidate, while the newly read
  // timeline has a gap. Current-state equality cannot erase that diagnostic.
  f.events.push({id:'redacted-later-event',kind:'status',scopeId:'scope-a',fieldId:'request-a',actorId:'operator-test',occurredAt:f.now(),previousStatus:null,status:null});
  await f.worker.tick();assert.equal(counts(f).runs,0);
  assert.equal(f.store.githubCandidates(f.key).length,1);
  assert.equal(f.store.githubItemDiagnostics(f.key)[0].code,'history_ambiguous');
});

test('explicit operator rebaseline is inert, requires authority and refuses any previously admitted issue',async t=>{
  const f=await githubFixture(t,{native:true});await f.worker.tick();f.advance();
  f.item.fields.request={present:true,value:'go-a'};
  f.events.push({id:'redacted-added-event',kind:'status',scopeId:'scope-a',fieldId:'request-a',actorId:'operator-test',occurredAt:f.now(),previousStatus:null,status:null});
  await f.worker.tick();assert.equal(counts(f).runs,0);
  assert.throws(()=>f.store.rebaselineGitHubItem('installation-a','test.provider','item-test',context),error=>error.code==='effect_blocked');
  f.store.rebaselineGitHubItem('installation-a','test.provider','item-test',context,localAuthority);
  await f.worker.tick();assert.equal(counts(f).runs,0);assert.equal(f.store.githubItemDiagnostics(f.key).length,0);
  f.advance();f.change('wait-a');f.change();await f.worker.tick();assert.equal(counts(f).runs,1);
  const before=counts(f);
  assert.throws(()=>f.store.rebaselineGitHubItem('installation-a','test.provider','item-test',context,localAuthority),error=>error.code==='effect_blocked');
  assert.deepEqual(counts(f),before);
});
