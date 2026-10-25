import { removeOperationsMigration } from './helpers/migration-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixture } from './helpers/cleanup-fixture.mjs';
import { CleanupDeletionRegistry } from '../packages/target-helper/cleanup-delete.ts';
import { localAuthority, context } from './helpers/configuration-fixture.mjs';

async function fixture(t,options={}){
 const x=await cleanupFixture(t,{deletion:true,...options});x.target.policy.cleanup={profile:'linux-exclusive-writers.v1'};
 const calls=[];
 x.options.deleteTarget=async request=>{
  calls.push(request.method);
  const helper=new CleanupDeletionRegistry(x.target.policy,{quiescence(){},git:{remote:x.target.repository,allowFileTransport:true}});
  try{return helper.handle(request);}finally{helper.close();}
 };
 x.calls=calls;return x;
}
test('LS-CLN-004/005 coordinator deletes and retains durable cleanup, source and merge history',async t=>{
 const x=await fixture(t);const decision=await x.worker().assess(x.id);assert.equal(decision.eligible,true);
 assert.equal(x.store.workspace(x.runId).state,'deleted',JSON.stringify(x.store.cleanupRequests()));assert.equal(existsSync(x.path),false);
 const history=x.store.history(x.runId),cleanup=history.records.find(r=>r.kind==='evidence'&&r.category==='cleanup');assert.ok(cleanup?.tombstoneRef);
 assert.equal(x.store.mergeRecord(x.mergeOp.operationId).outcome,'confirmed');assert.ok(history.records.some(r=>r.kind==='resource'));
 const tombstone=x.store.cleanupExecution(x.id).observation.tombstone;
 x.reopen();await x.worker().assess(x.id);assert.deepEqual(x.store.cleanupExecution(x.id).observation.tombstone,tombstone);
 assert.equal(x.calls.filter(c=>c==='prepare').length,1);assert.equal(x.calls.filter(c=>c==='commit').length,1);
});
for(const method of ['prepare','commit'])test(`lost ${method} acknowledgement reconciles original operation without replay`,async t=>{
 const x=await fixture(t),target=x.options.deleteTarget;let dropped=false;
 x.options.deleteTarget=async r=>{const result=await target(r);if(r.method===method&&!dropped){dropped=true;throw Error('lost acknowledgement');}return result;};
 await x.worker().assess(x.id);assert.equal(x.store.workspace(x.runId).state,'deleted');assert.equal(x.calls.filter(c=>c===method).length,1);
});
test('lost preparation before target receipt is uncertain and never repeats start',async t=>{
 const x=await fixture(t),target=x.options.deleteTarget;let attempts=0;
 x.options.deleteTarget=async r=>{if(r.method==='prepare'){attempts++;throw Error('delivery unknown');}return target(r);};
 await x.worker().assess(x.id);assert.equal(x.store.workspace(x.runId).state,'cleanup_pending');
 x.reopen();await x.worker().assess(x.id);assert.equal(attempts,1);assert.ok(existsSync(x.path));
});
for(const changed of ['keep','pause','remote-keep','epoch'])test(`fresh ${changed} after preparation prevents movement and restores retention`,async t=>{
 const x=await fixture(t),target=x.options.deleteTarget;
 x.options.deleteTarget=async r=>{const result=await target(r);if(r.method==='prepare'){
  if(changed==='keep'){const w=x.store.workspace(x.runId);x.store.setWorkspaceKeep(w.id,true,w.revision,localAuthority,context);}
  if(changed==='remote-keep')x.setKeep(true);
  if(changed==='pause')x.store.db.prepare('UPDATE run_controls SET operator_paused=1 WHERE run_id=?').run(x.runId);
  if(changed==='epoch')x.store.db.prepare('UPDATE recovery_control SET epoch=epoch+1,paused=1').run();
 }return result;};
 await x.worker().assess(x.id);assert.equal(x.calls.includes('commit'),false);assert.ok(existsSync(x.path));assert.equal(x.store.cleanupExecution(x.id).stage,'released');
 assert.equal(x.store.workspace(x.runId).state,'retained');
});
test('after commit response loss a replacement at the old locator survives reconciliation',async t=>{
 const x=await fixture(t),target=x.options.deleteTarget;let lost=false;
 x.options.deleteTarget=async r=>{const result=await target(r);if(r.method==='commit'){
  mkdirSync(join(x.target.policy.roots[0].path,x.receipt.locator));writeFileSync(join(x.path.replace(/\/source$/,''),'replacement'),'keep');lost=true;throw Error('lost');
 }return result;};
 await x.worker().assess(x.id);assert.equal(lost,true);assert.equal(x.store.workspace(x.runId).state,'deleted');
 assert.equal(readFileSync(join(x.path.replace(/\/source$/,''),'replacement'),'utf8'),'keep');
});

for(const stage of ['before-prepare','after-delete'])test(`AC20 actual coordinator SIGKILL ${stage} retains the original deletion and history`,async t=>{
 const {fork}=await import('node:child_process'),{once}=await import('node:events');
 const x=await fixture(t),target=x.options.deleteTarget;delete x.options.deleteTarget;
 await x.worker().assess(x.id);x.options.deleteTarget=target;
 const originalMerge=x.store.mergeRecord(x.mergeOp.operationId),spec=join(x.root,'coordinator-delete.json');
 writeFileSync(spec,JSON.stringify({state:x.state,requestId:x.id,stage,host:x.f.dependencies.host,policy:x.target.policy,repository:x.target.repository,
  providerUrl:x.providerTarget.url,keep:await x.options.keepItem()}),{mode:0o600});
 const child=fork(new URL('./helpers/cleanup-coordinator-process.mjs',import.meta.url),[spec],{stdio:['ignore','pipe','pipe','ipc']});
 const exit=once(child,'exit');let errors='';child.stderr.on('data',c=>errors+=c);t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}});
 const message=async()=>Promise.race([once(child,'message',{signal:AbortSignal.timeout(15000)}).then(x=>x[0]),exit.then(()=>{throw Error(errors);})]);
 assert.equal((await message()).stage,'ready');const paused=message();child.send('go');assert.deepEqual(await paused,{stage});child.kill('SIGKILL');await exit;
 const execution=x.store.cleanupExecution(x.id);assert.ok(execution);
 if(stage==='after-delete'){const wrapper=x.path.replace(/\/source$/,'');mkdirSync(wrapper);writeFileSync(join(wrapper,'foreign'),'keep');}
 x.reopen();await x.worker().assess(x.id);
 assert.deepEqual(x.store.cleanupExecution(x.id).operation,execution.operation);assert.deepEqual(x.store.mergeRecord(x.mergeOp.operationId),originalMerge);
 if(stage==='after-delete'){
  assert.equal(x.store.workspace(x.runId).state,'deleted');assert.equal(readFileSync(join(x.path.replace(/\/source$/,''),'foreign'),'utf8'),'keep');
  assert.equal(x.calls.includes('commit'),false);
 }else{assert.equal(x.store.workspace(x.runId).state,'cleanup_pending');assert.ok(existsSync(x.path));assert.equal(x.calls.includes('prepare'),false);}
});

test('migration 19 preserves v18 pending assessments without fabricating a deletion',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const x=await fixture(t);delete x.options.deleteTarget;await x.worker().assess(x.id);
 const old=x.store.cleanupRequests(x.runId)[0].operation,db=new DatabaseSync(join(x.state,'state.sqlite'));
 removeOperationsMigration(db);
 db.exec('DROP TABLE restore_observation_checks; DELETE FROM schema_migrations WHERE version=20; DROP TABLE cleanup_executions; DELETE FROM schema_migrations WHERE version=19; PRAGMA user_version=18');db.close();
 x.reopen();assert.deepEqual(x.store.cleanupRequests(x.runId)[0].operation,old);assert.equal(x.store.cleanupExecution(x.id),null);assert.ok(existsSync(x.path));
});
test('an assessment-only frozen 1.0.0 artifact remains pending and cannot invoke deletion',async t=>{
 const {createHash}=await import('node:crypto');const x=await fixture(t,{configure(f,pin){
  const artifact=JSON.parse(readFileSync(pin.artifactPath));artifact.manifest.version='1.0.0';artifact.manifest.capabilities=['cleanup.assess.v1'];
  artifact.module=`export function createExtension(){const result=operation=>({schemaVersion:'1.0',kind:'result',operationId:operation.operationId,requestDigest:operation.requestDigest,
   result:{status:'accepted',handle:operation.operationId,resources:[],outputs:{cleanupDisposition:'pending_executor'},evidenceRefs:[],error:null}});
   return {async validate(){},async start(operation){return result(operation);},async reconcile(operation){return result(operation);}};}`;
  writeFileSync(pin.artifactPath,JSON.stringify(artifact));pin.version='1.0.0';pin.capabilities=['cleanup.assess.v1'];pin.integrity=createHash('sha256').update(readFileSync(pin.artifactPath)).digest('hex');f.config.cleanup.actionVersion='1.0.0';
 }});
 await x.worker().assess(x.id);assert.equal(x.store.cleanupRequests(x.runId)[0].state,'pending_executor');assert.equal(x.store.cleanupExecution(x.id),null);assert.equal(x.calls.length,0);assert.ok(existsSync(x.path));
});
test('an action result without independent target evidence cannot establish deletion',async t=>{
 const {createHash}=await import('node:crypto');const x=await fixture(t,{configure(_f,pin){
  const artifact=JSON.parse(readFileSync(pin.artifactPath));artifact.module=artifact.module.replace("if(operation.inputs.schemaVersion==='2.0')return deletion(operation,'prepare');","if(operation.inputs.schemaVersion==='2.0')return result(operation);");
  writeFileSync(pin.artifactPath,JSON.stringify(artifact));pin.integrity=createHash('sha256').update(readFileSync(pin.artifactPath)).digest('hex');
 }});
 await x.worker().assess(x.id);assert.equal(x.store.workspace(x.runId).state,'cleanup_pending');assert.equal(x.calls.includes('prepare'),false);assert.equal(x.calls.includes('commit'),false);assert.ok(existsSync(x.path));
});

test('a hold introduced after authorization is checked again before target dispatch',async t=>{
 const x=await fixture(t),target=x.options.deleteTarget;
 x.options.deleteTarget=async request=>{
  if(request.method==='commit'){
   x.store.db.prepare('UPDATE run_controls SET operator_paused=1 WHERE run_id=?').run(x.runId);
   x.store.assertCleanupCommitAllowed(x.id,request.authorization);
  }
  return target(request);
 };
 await x.worker().assess(x.id);assert.equal(x.calls.includes('commit'),false);assert.ok(existsSync(x.path));assert.equal(x.store.workspace(x.runId).state,'retained');
});
