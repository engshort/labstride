import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { startCoordinator } from '../apps/coordinator/main.ts';
import { createWorker, actionKey } from '../packages/core/worker.ts';
import { createControlWorker } from '../packages/core/control-worker.ts';
import { operationalMetrics } from '../packages/operations/metrics.ts';
import { retainDiagnostics } from '../packages/operations/retention.ts';
import { acquireServiceLock } from '../packages/operations/loop.ts';
import { publishRunSummary } from '../packages/operations/summary.ts';
import { safeReason, diagnosticEvent } from '../packages/core/diagnostics.ts';
import { cli, safeCode } from '../apps/cli/main.ts';
import { GitHubRest } from '../packages/operations/github.ts';
import { connectorContracts } from '../packages/connector-ssh/contracts.ts';
import { requestDigest } from '../packages/storage-sqlite/execution.ts';
import { startPlan, eventInput, seed, context } from './helpers/execution-fixture.mjs';
import { update, record } from './helpers/lifecycle-fixture.mjs';

const early = '2026-10-21T12:00:00.000Z', later = '2027-10-25T12:00:00.000Z';
const markers = ['synthetic_secret_value', 'ISSUE_BODY_SENTINEL', 'SESSION_TRANSCRIPT_SENTINEL'];
const noSecrets = value => { for (const marker of markers) assert(!JSON.stringify(value).includes(marker), marker); };
const fail = code => error => error.code === code || error.message === code;
function fixture(t, { automation, maxRepairs = 3, unattendedMs = 86400000 } = {}) {
  const root = mkdtempSync(join(tmpdir(),'labstride-evidence-')); let now = early;
  const { store } = startCoordinator(root, { clock: { now: () => now } });
  seed(store); store.configureScheduling({ schemaVersion:'1.0',activeRuns:2,development:2,ciReview:2,maxRepairs,unattendedMs },context);
  const plan = startPlan(); plan.projections = []; if (automation) plan.automation = automation;
  store.scheduleStart(store.receive(eventInput()).id,plan,context);
  const db = new DatabaseSync(join(root,'state.sqlite'));
  const spec = { stateDirectory:root,configuration:{installationId:'installation-test',limits:{metadataRetentionDays:90}} };
  t.after(() => { db.close(); store.close(); rmSync(root,{recursive:true,force:true}); });
  const protect = () => { for (const suffix of ['','-wal','-shm']) if (existsSync(join(root,'state.sqlite'+suffix))) chmodSync(join(root,'state.sqlite'+suffix),0o600); };
  protect();
  return { root,store,plan,db,spec,protect,setNow: value => now=value };
}
function bound(f,status='accepted',patch={}) { return {schemaVersion:'1.0',kind:'result',operationId:f.plan.operation.id,requestDigest:f.plan.operation.request.requestDigest,result:{status,handle:'original-handle',resources:[],outputs:{},evidenceRefs:['test:observed'],error:null,...patch}}; }
function control(f,command) { return {schemaVersion:'1.0',id:crypto.randomUUID(),runId:f.plan.run.id,expectedRevision:f.store.get('run',f.plan.run.id).revision,command}; }
function run(f,patch={}) { const claim=f.store.claim(f.plan.operation.id,'test','attempt'); f.store.beginEffect(claim);f.store.acceptResult(bound(f,'accepted',patch),claim,1); return claim; }
function followPlan(f,repair=false) {
  const operation=structuredClone(f.plan.operation),outbox=structuredClone(f.plan.outbox);operation.id+=':follow';operation.request.operationId=operation.id;operation.request.requestDigest=requestDigest(operation.request);
  outbox.id+=':follow';outbox.operationId=operation.id;outbox.intentKey+=':follow';outbox.payload.operationId=operation.id;
  return {operation,outbox,resourceKey:f.plan.resourceKey,automation:repair?{schemaVersion:'1.0',repair:{failureFingerprint:'test-failure'}}:{schemaVersion:'1.0'}};
}
function resolve(f, observations=3) {
  const claim=run(f); for(let i=1;i<observations;i++) f.store.acceptResult(bound(f),claim,1);
  f.store.acceptResult(bound(f,'succeeded'),claim,1);
  f.store.cancelRun(control(f,'cancel'),context);
  for(const state of ['creating','ready','cleanup_pending','deleting','deleted']) update(f.store,'workspace',f.plan.workspace.id,{state,keep:false,updatedAt:early});
  const evidence=record('evidence','cleanup-evidence',{runId:f.plan.run.id,workspaceId:f.plan.workspace.id,operationId:f.plan.operation.id,category:'cleanup',subjectId:'cleanup-test',sourceSha:f.plan.operation.request.source.sha,targetId:f.plan.operation.request.targetId,outcome:'verified',reference:'test:cleanup',tombstoneRef:'test:tombstone',correctsId:null});
  f.store.commit([{record:evidence,expectedRevision:null}],context);f.protect();
}
function summaryPeer(f) {
  let comment=null, creates=0, updates=0, drop=false;
  const rest={reference:'secret:repository',async request(method,path,input) {
    if(method==='POST'){ creates++;comment={id:123,body:input.body};if(drop)throw Error(markers[0]);return structuredClone(comment); }
    if(method==='PATCH'){ updates++;comment.body=input.body;return structuredClone(comment); }
    return structuredClone(comment);
  }};
  const client={async query(_query,_variables,reference){assert.equal(reference,rest.reference);return{node:{number:32,repository:{nameWithOwner:f.plan.operation.request.source.repository}}};}};
  return {rest,client,get comment(){return comment;},get creates(){return creates;},get updates(){return updates;},drop(){drop=true;},edit(){comment.body+='\nHuman edit';}};
}

test('AC28: structured action errors and arbitrary output stay out of diagnostic history; original handles survive',t=>{
  const f=fixture(t); const claim=f.store.claim(f.plan.operation.id,'test','attempt');f.store.beginEffect(claim);
  const result=bound(f,'failed',{error:{code:'operation_failed',message:markers.join(' '),retryClass:'none',evidenceId:markers[0]},outputs:{transcript:markers[2]}});
  f.store.acceptResult(result,claim,1);
  const receipt=JSON.parse(f.db.prepare('SELECT payload FROM execution_results').get().payload);
  noSecrets(receipt.result.error);noSecrets(f.store.executionHistory(f.plan.operation.id));
  assert.equal(receipt.result.error.message,'operation_failed');assert.equal(receipt.result.handle,'original-handle');assert.equal(result.result.error.message,markers.join(' '),'caller payload is unchanged');
  assert.equal(f.store.operationHandle(f.plan.operation.id),'original-handle');
  for(const value of markers){f.store.workflowError(f.plan.run.id,value);f.store.summaryError(f.plan.run.id,value);assert.equal(safeReason(value),'operation_failed');}
  noSecrets(f.store.workflowDiagnostic(f.plan.run.id));noSecrets(f.store.summaryDiagnostic(f.plan.run.id));noSecrets(diagnosticEvent('operation_failed',early,f.plan.run.id,f.plan.operation.id));
  assert.equal(safeCode(new Error(markers[0])),'operation_failed');
});

test('AC28: GitHub exceptions and SSH exceptions/structured replies produce safe receipts',async t=>{
  const f=fixture(t), op=f.plan.operation.request;
  const rest=new GitHubRest(async()=>markers[0],'secret:repository',async()=>{throw Error(markers.join(' '));});
  await assert.rejects(rest.request('GET','/repos/example/source'),error=>{noSecrets(error.message);return error.code==='provider_unavailable';});
  const input={schemaVersion:'1.0',family:'connector',extensionId:'labstride.connector.ssh',requestId:'test',method:'execute',input:{operation:op}};
  const envelope=JSON.parse(readFileSync(new URL('../examples/contract-request.json',import.meta.url)));
  Object.assign(envelope,input);
  const invoke=async()=>{throw Error(markers.join(' '));};
  const result=await connectorContracts({connector:{async validate(){},invoke},installationId:'installation-test',targetId:op.targetId,revision:1,operation:()=>op})(envelope);
  noSecrets(result);assert.equal(result.error.code,'outcome_unknown');
});

test('zero configured repairs block scheduling and persist the reason without blocking initial non-repair work',t=>{
  const f=fixture(t,{maxRepairs:0});const claim=run(f);f.store.acceptResult(bound(f,'succeeded'),claim,1);
  assert.throws(()=>f.store.scheduleOperation(followPlan(f,true),context),fail('effect_blocked'));
  assert.equal(f.store.controlStatus(f.plan.run.id).budgetHold,'repair_budget');
  const reboot=startCoordinator(f.root,{clock:{now:()=>early}});t.after(()=>reboot.store.close());
  reboot.store.resumeRun(control({...f,store:reboot.store},'resume'),context);
  assert.equal(reboot.store.controlStatus(f.plan.run.id).budgetHold,'repair_budget');
  assert.equal(reboot.store.controlStatus(f.plan.run.id).budget.repairs,0);
});

test('unattended limit expiring during validation prevents effect invocation and survives resume',async t=>{
  const f=fixture(t,{unattendedMs:1000});let release,starts=0;
  const claim=run(f);f.store.acceptResult(bound(f,'succeeded'),claim,1);
  const input=followPlan(f);f.store.scheduleOperation(input,context);
  const worker=createWorker(f.store,{executorId:'validation',nextAttempt:()=>crypto.randomUUID(),adapters:new Map([[actionKey(input.operation.request.actionId,input.operation.request.actionVersion),{
    async validate(){await new Promise(resolve=>release=resolve);},async start(){starts++;return bound(f,'succeeded');},async reconcile(){throw Error();}
  }]])});
  await worker.tick();assert(release);f.setNow('2026-10-21T12:00:01.000Z');release();await worker.drain();
  assert.equal(starts,0);assert.equal(f.store.controlStatus(f.plan.run.id).budgetHold,'unattended_timeout');
  f.store.resumeRun(control(f,'resume'),context);
  assert.equal(f.store.get('operation',input.operation.id).effectBoundary,'not_crossed');
  assert.equal(f.store.controlStatus(f.plan.run.id).budgetHold,'unattended_timeout');
});

test('summary explains holds, throttles, preserves manual edits and never copies arbitrary diagnostics',async t=>{
  const f=fixture(t),peer=summaryPeer(f);f.store.workflowError(f.plan.run.id,markers[0]);f.store.pauseRun(control(f,'pause'),context);
  assert.equal(f.store.projectionAllowed(f.plan.run.id),false);assert.equal(f.store.summaryAllowed(f.plan.run.id),true);
  await publishRunSummary(f.store,f.plan.run.id,peer.rest,peer.client);assert.equal(peer.creates,1);noSecrets(peer.comment);
  assert(peer.comment.body.includes('operator_pause'));assert(peer.comment.body.includes('Repairs: 0/3'));
  await publishRunSummary(f.store,f.plan.run.id,peer.rest,peer.client);assert.equal(peer.creates,1);
  f.setNow('2026-10-21T12:02:00.000Z');f.store.workflowError(f.plan.run.id,'repair_budget');peer.edit();
  await publishRunSummary(f.store,f.plan.run.id,peer.rest,peer.client);assert.equal(peer.updates,0);assert.equal(f.store.summaryDiagnostic(f.plan.run.id),'summary_conflict');
});

test('unknown summary creation is never repeated; restore fences prevent status effects',async t=>{
  const f=fixture(t),peer=summaryPeer(f);peer.drop();await assert.rejects(publishRunSummary(f.store,f.plan.run.id,peer.rest,peer.client));
  f.setNow('2026-10-21T12:02:00.000Z');await publishRunSummary(f.store,f.plan.run.id,peer.rest,peer.client);assert.equal(peer.creates,1);
  f.store.enterRestore(context);assert.equal(f.store.summaryAllowed(f.plan.run.id),false);
  f.setNow('2026-10-21T12:04:00.000Z');await publishRunSummary(f.store,f.plan.run.id,peer.rest,peer.client);assert.equal(peer.creates,1);
});

test('metrics are a read-only, content-free snapshot of actual queue and repair state',t=>{
  const f=fixture(t,{automation:{schemaVersion:'1.0',repair:{failureFingerprint:markers[0]}}});run(f);f.protect();
  const before=f.db.prepare('SELECT count(*) AS n FROM execution_log').get().n;
  const snapshot=operationalMetrics(f.root,'installation-test','2026-10-21T12:00:03.000Z');
  assert.equal(snapshot.repairAttempts,1);assert.equal(snapshot.activeWorkspaces,1);assert.equal(snapshot.actionCount,1);assert.equal(snapshot.actionDurationMaxMs,3000);noSecrets(snapshot);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_log').get().n,before);
  assert.throws(()=>operationalMetrics(f.root,'foreign',early),fail('installation_binding_invalid'));
});

test('retention previews then bounds deletion, retains latest handles and immutable recovery/audit evidence',async t=>{
  const f=fixture(t);resolve(f,503);
  const before=f.db.prepare('SELECT count(*) AS n FROM execution_log').get().n;
  assert.equal((await retainDiagnostics(f.spec,'dry-run',{at:later})).eligible,503);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_log').get().n,before);
  const first=await retainDiagnostics(f.spec,'apply',{at:later});assert.equal(first.deleted,500);assert.equal(first.remaining,3);
  assert.equal((await retainDiagnostics(f.spec,'apply',{at:later})).deleted,3);assert.equal((await retainDiagnostics(f.spec,'apply',{at:later})).deleted,0);
  assert.equal(f.store.operationHandle(f.plan.operation.id),'original-handle');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_results').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM evidence').get().n,1);
  assert(f.db.prepare('SELECT count(*) AS n FROM audit').get().n>0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM claims').get().n,1);
  assert.throws(()=>f.db.exec('DELETE FROM execution_log'),/immutable_execution_log/);assert.throws(()=>f.db.exec('DELETE FROM evidence'),/immutable_evidence/);
});

for(const blocker of ['active','unknown','resource','keep','projection','recovery'])test(`retention preserves ${blocker} evidence`,async t=>{
  const f=fixture(t);
  if(blocker==='active'||blocker==='unknown'){run(f);if(blocker==='unknown')f.store.markUnknown(f.plan.operation.id);}
  else resolve(f);
  if(blocker==='resource')f.store.commit([{record:record('resource','retained-resource',{runId:f.plan.run.id,workspaceId:f.plan.workspace.id,createdByOperation:f.plan.operation.id,resourceType:'runtime',providerId:'fixture',locator:'opaque:resource',ownershipRef:f.plan.workspace.ownershipRef,cleanupPolicy:'retain'}),expectedRevision:null}],context);
  // Model persisted historical blockers without authorizing any product effect.
  if(blocker==='keep'){const row=f.store.get('workspace',f.plan.workspace.id);f.db.prepare('UPDATE workspaces SET payload=? WHERE id=?').run(JSON.stringify({...row,keep:true}),row.id);}
  if(blocker==='projection')f.db.prepare("INSERT INTO managed_summaries VALUES (?,NULL,'safe',NULL,1,?)").run(f.plan.run.id,early);
  if(blocker==='recovery')f.store.enterRestore(context);
  const before=f.db.prepare('SELECT count(*) AS n FROM execution_log').get().n;
  if(blocker==='recovery')await assert.rejects(retainDiagnostics(f.spec,'apply',{at:later}),fail('recovery_required'));
  else assert.equal((await retainDiagnostics(f.spec,'apply',{at:later})).deleted,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_log').get().n,before);
});

test('retention respects cutoff, operator lock and atomic rollback',async t=>{
  const f=fixture(t);resolve(f);
  assert.equal((await retainDiagnostics(f.spec,'dry-run',{at:'2027-01-19T12:00:00.000Z'})).eligible,0,'exact 90-day boundary is retained');
  const unlock=await acquireServiceLock(f.root);try{await assert.rejects(retainDiagnostics(f.spec,'apply',{at:later}),fail('service_lock_present'));}finally{await unlock();}
  await assert.rejects(retainDiagnostics(f.spec,'apply',{at:later,beforeCommit(){throw Error('injected interruption');}}));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM retention_batches').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM retention_candidates').get().n,0);
  assert.equal((await retainDiagnostics(f.spec,'apply',{at:later})).deleted,3);
});

test('SIGKILL during retention rolls back deletion and audit together; next explicit invocation recovers',async t=>{
  const f=fixture(t);resolve(f);const child=fork(new URL('./helpers/retention-process.mjs',import.meta.url),[f.root,later],{stdio:['ignore','pipe','pipe','ipc']});
  const exited=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}});
  const message=(await once(child,'message',{signal:AbortSignal.timeout(10000)}))[0];assert.equal(message.stage,'before-commit');child.kill('SIGKILL');await exited;
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM retention_batches').get().n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM retention_candidates').get().n,0);
  assert.equal((await retainDiagnostics(f.spec,'apply',{at:later})).deleted,3);
});

for(const lost of [false,true])test(`AC24 local: exhausted repair budget permits original cancellation and observation (lost=${lost})`,async t=>{
  const f=fixture(t,{maxRepairs:1,automation:{schemaVersion:'1.0',repair:{failureFingerprint:'fixture-failure'}}});
  const peerPath=join(f.root,'peer.sqlite'),child=fork(new URL('./helpers/effect-target.mjs',import.meta.url),[peerPath],{stdio:['ignore','pipe','pipe','ipc']});
  const exited=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}});
  const {url}=(await once(child,'message',{signal:AbortSignal.timeout(10000)}))[0];
  const claim=f.store.claim(f.plan.operation.id,'initial','attempt');f.store.beginEffect(claim);
  const accepted=await(await fetch(url+'/start',{method:'POST',headers:{'x-pending':'1'},body:JSON.stringify(f.plan.operation.request)})).json();f.store.acceptResult(accepted,claim,1);
  f.store.dueOperations();assert.equal(f.store.controlStatus(f.plan.run.id).budgetHold,'repair_budget');
  assert.throws(()=>f.store.scheduleOperation(followPlan(f,true),context),fail('effect_blocked'));
  f.store.cancelRun(control(f,'cancel'),context);
  const adapter={async validate(){},async start(){assert.fail('must not start another repair');},async cancel(request){return(await fetch(url+'/cancel',{method:'POST',headers:lost?{'x-drop-reply':'1'}:{},body:JSON.stringify(request)})).json();},async reconcile(request){return(await fetch(url+'/observe',{method:'POST',body:JSON.stringify(request)})).json();}};
  const options={executorId:'test',nextAttempt:()=>crypto.randomUUID(),adapters:new Map([[actionKey(f.plan.operation.request.actionId,f.plan.operation.request.actionVersion),adapter]])};
  const controller=createControlWorker(f.store,options);await controller.tick();await controller.drain();
  if(lost)assert.equal(f.store.get('operation',f.plan.operation.id).state,'outcome_unknown');
  const reopened=startCoordinator(f.root,{clock:{now:()=>early}});t.after(()=>reopened.store.close());
  const worker=createWorker(reopened.store,options);await worker.tick();await worker.drain();
  assert.equal(reopened.store.get('operation',f.plan.operation.id).state,'cancelled');assert.equal(reopened.store.controlStatus(f.plan.run.id).budget.repairs,1);
  assert.equal(reopened.store.operationHandle(f.plan.operation.id),accepted.result.handle);
  const db=new DatabaseSync(peerPath,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM calls').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM cancels').get().n,1);}finally{db.close();}
});

test('CLI metrics and explicit retention use configured state and reject invalid arguments before effects',async t=>{
  const {publicFixture}=await import('./helpers/public-installation-fixture.mjs');const f=fixture(t),installation=publicFixture(t);resolve(f);
  installation.spec.stateDirectory=f.root;installation.write();const output=[];
  await cli(['metrics','--json','--config',installation.path],value=>output.push(value));assert.equal(output[0].schemaVersion,'1.0');assert.equal(output[0].unknownOutcomes,0);
  // The fixture dates are older than the configured 90-day retention interval.
  await cli(['retention','--dry-run','--config',installation.path],value=>output.push(value));assert.equal(output.at(-1).mode,'dry-run');
  const before=f.db.prepare('SELECT count(*) AS n FROM execution_log').get().n;
  await assert.rejects(cli(['retention','--config',installation.path]),fail('usage'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_log').get().n,before);noSecrets(output);
});

test('AC28: structured SSH error replies omit provider messages at the connector contract boundary',async t=>{
  const f=fixture(t),operation=f.plan.operation.request;
  const envelope=JSON.parse(readFileSync(new URL('../examples/contract-request.json',import.meta.url)));
  Object.assign(envelope,{family:'connector',extensionId:'labstride.connector.ssh',requestId:'test',method:'execute',input:{operation}});
  const connector={async validate(){},async invoke(request){return{schemaVersion:'1.0',requestId:request.requestId,installationId:request.installationId,targetId:request.targetId,targetRevision:request.targetRevision,method:request.method,outcome:'error',reservation:null,capabilities:[],error:{code:'operation_failed',message:markers.join(' '),evidenceId:null,retryClass:'none'}};}};
  const result=await connectorContracts({connector,installationId:'installation-test',targetId:operation.targetId,revision:1,operation:()=>operation})(envelope);
  assert.equal(result.outcome,'error');assert.equal(result.error.message,'operation_failed');noSecrets(result);
});

test('unknown structured error codes are rejected without persistence or exposing rejected values',t=>{
  const f=fixture(t);const claim=f.store.claim(f.plan.operation.id,'test','attempt');f.store.beginEffect(claim);
  assert.throws(()=>f.store.acceptResult(bound(f,'failed',{error:{code:markers[0],message:markers[1],evidenceId:null,retryClass:'none'}}),claim,1),error=>{noSecrets(error.message);return error.code==='invalid_payload';});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_results').get().n,0);noSecrets(f.store.executionHistory(f.plan.operation.id));
});

test('retention never treats a terminal run as proof that deployment resources are resolved',async t=>{
  const f=fixture(t);resolve(f);
  f.store.commit([{record:record('deployment','pending-deployment',{runId:f.plan.run.id,operationId:f.plan.operation.id,targetId:f.plan.operation.request.targetId,sourceSha:f.plan.operation.request.source.sha,state:'requested'}),expectedRevision:null}],context);
  assert.equal((await retainDiagnostics(f.spec,'apply',{at:later})).deleted,0);
});

test('pre-redaction terminal results remain idempotent without rewriting original evidence',t=>{
  const f=fixture(t);run(f);
  const original=bound(f,'failed',{error:{code:'operation_failed',message:'Historical provider explanation',retryClass:'none',evidenceId:'historical-evidence'}});
  // Seed a pre-migration terminal receipt in this fixture-owned SQLite store.
  f.db.prepare('INSERT INTO execution_results VALUES (?,?)').run(f.plan.operation.id,JSON.stringify(original));
  assert.equal(f.store.acceptResult(original,null,f.store.get('operation',f.plan.operation.id).revision),true);
  assert.equal(f.store.delivery(`operation:${f.plan.operation.id}`).state,'done');
  assert.equal(JSON.parse(f.db.prepare('SELECT payload FROM execution_results').get().payload).result.error.message,'Historical provider explanation');
});

test('actual loop failure output is a versioned safe event, including when provider exceptions contain secrets',async t=>{
  const {serviceLoop}=await import('../packages/operations/loop.ts');const controller=new AbortController(),lines=[];
  t.mock.method(process.stderr,'write',value=>{lines.push(String(value));return true;});
  let closes=0;await serviceLoop({async tick(){controller.abort();throw Error(markers.join(' '));},async close(){closes++;}},controller.signal,1);
  assert.equal(closes,1);assert.equal(lines.length,1);noSecrets(lines);assert.equal(JSON.parse(lines[0]).code,'tick_failed');assert.equal(JSON.parse(lines[0]).schemaVersion,'1.0');
});

test('diagnostic schemas reject unknown reasons and arbitrary metric labels',async t=>{
  const {validated}=await import('../packages/storage-sqlite/validation.ts');
  assert.throws(()=>validated('operational-event',{...diagnosticEvent('operation_failed',early),code:markers[0]}),fail('invalid_payload'));
  const f=fixture(t),snapshot=operationalMetrics(f.root,'installation-test',early);
  assert.throws(()=>validated('operational-metrics',{...snapshot,issueBody:markers[1]}),fail('invalid_payload'));
  await assert.rejects(retainDiagnostics({...f.spec,configuration:{...f.spec.configuration,limits:{metadataRetentionDays:0}}},'apply'),fail('configuration_invalid'));
});
