import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { startCoordinator } from '../apps/coordinator/main.ts';
import { createWorker, actionKey, PreEffectTransient } from '../packages/core/worker.ts';
import { seed, schedule, startPlan, context } from './helpers/execution-fixture.mjs';
import { observeRestoreProjections } from './helpers/observation-fixture.mjs';
const fail = code => e => e.code === code;
const message = async child => (await once(child, 'message', { signal: AbortSignal.timeout(10000) }))[0];
function fixture(t, dependencies = {}, scheduled = true) {
  const root = mkdtempSync(join(tmpdir(), 'labstride-effects-')), state = join(root, 'state');
  const { store } = startCoordinator(state, dependencies); seed(store); const plan = scheduled ? schedule(store) : startPlan();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return { root, state, store, plan };
}
function child(t, file, args) {
  const p = fork(new URL(`./helpers/${file}`, import.meta.url), args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  p.exited = once(p, 'exit');
  t.after(async () => { if (p.exitCode === null && p.signalCode === null) { const exit = p.exited; p.kill('SIGKILL'); await exit; } }); return p;
}
async function target(t, root) {
  const path = join(root, 'target.sqlite'); const p = child(t, 'effect-target.mjs', [path]); const { url } = await message(p);
  return { p, path, url, calls() { const db = new DatabaseSync(path); const n = db.prepare('SELECT count(*) AS n FROM calls').get().n; db.close(); return n; } };
}
async function run(t, mode, state, url) {
  const p = child(t, 'execution-process.mjs', [mode, state, url]); assert.equal((await message(p)).stage, 'ready');
  const reply = message(p); p.send('go'); return { p, reply };
}
function bound(plan, status = 'succeeded') {
  return { schemaVersion: '1.0', kind: 'result', operationId: plan.operation.id, requestDigest: plan.operation.request.requestDigest,
    result: { status, handle: 'original-handle', resources: [], outputs: {}, evidenceRefs: ['test:effect'], error: null } };
}
function worker(store, plan, adapter, extra = {}) {
  const worker = createWorker(store, { executorId: 'worker', nextAttempt: () => 'attempt', adapters: new Map([[actionKey(plan.operation.request.actionId, plan.operation.request.actionVersion), adapter]]), ...extra });
  return { ...worker, async tick() { await worker.tick(); await worker.drain(); } };
}
test('AC01: committed intent executes once after a new coordinator process starts', async t => {
  const { root, state, store, plan } = fixture(t, {}, false);
  const preparer = child(t, 'inbox-process.mjs', ['after', state]); await message(preparer);
  const committed = message(preparer); preparer.send('go'); assert.equal((await committed).stage, 'after');
  const killed = preparer.exited; preparer.kill('SIGKILL'); await killed;
  const receiver = await target(t, root);
  const first = await run(t, 'normal', state, receiver.url); assert.deepEqual(await first.reply, { stage: 'done', state: 'succeeded' }); await first.p.exited;
  const second = await run(t, 'normal', state, receiver.url); assert.equal((await second.reply).state, 'succeeded'); await second.p.exited;
  assert.equal(receiver.calls(), 1); assert.equal(store.get('operation', plan.operation.id).id, plan.operation.id);
  assert.equal(store.snapshot().records.filter(r => r.kind === 'resource').length, 1);
});
for (const mode of ['after-claim','after-boundary','after-effect']) test(`SIGKILL ${mode} never repeats an uncertain effect`, async t => {
  const { root, state, store, plan } = fixture(t); const receiver = await target(t, root);
  const first = await run(t, mode, state, receiver.url); assert.equal((await first.reply).stage, mode);
  const exit = first.p.exited; first.p.kill('SIGKILL'); await exit;
  const reboot = await run(t, 'normal', state, receiver.url); const reply = await reboot.reply; await reboot.p.exited;
  assert.equal(reply.state, mode === 'after-effect' ? 'succeeded' : 'outcome_unknown');
  assert.equal(receiver.calls(), mode === 'after-effect' ? 1 : 0);
  assert.equal(store.get('operation', plan.operation.id).id, plan.operation.id);
});
test('lost effect response is observed at the original target without a second invocation', async t => {
  const { root, state, store, plan } = fixture(t); const receiver = await target(t, root);
  const first = await run(t, 'lost-reply', state, receiver.url); assert.equal((await first.reply).state, 'outcome_unknown'); await first.p.exited;
  const next = await run(t, 'normal', state, receiver.url); assert.equal((await next.reply).state, 'succeeded'); await next.p.exited;
  assert.equal(receiver.calls(), 1); assert.equal(store.operationHandle(plan.operation.id), `handle:${plan.operation.id}`);
});
test('two coordinator processes authorize one effect and a terminal result survives further restart', async t => {
  const { root, state } = fixture(t); const receiver = await target(t, root);
  const runs = await Promise.all([run(t, 'normal', state, receiver.url), run(t, 'normal', state, receiver.url)]);
  const exits = runs.map(r => r.p.exited); await Promise.all(runs.map(r => r.reply)); await Promise.all(exits);
  assert.equal(receiver.calls(), 1);
});
test('claims are idempotent; grants are consumed once, no time-based takeover and no stale fencing', t => {
  let now = '2026-10-21T12:00:00.000Z'; const { store, plan } = fixture(t, { clock: { now: () => now } });
  const claim = store.claim(plan.operation.id, 'executor', 'attempt'); assert.deepEqual(store.claim(plan.operation.id, 'executor','attempt'), claim);
  now = '2026-10-21T13:00:00.000Z';
  assert.throws(() => store.claim(plan.operation.id, 'new-executor', 'attempt'), fail('resource_busy'));
  assert.throws(() => store.beginEffect({ ...claim, fencingNumber: claim.fencingNumber + 1 }), fail('identity_conflict'));
  store.beginEffect(claim); assert.throws(() => store.beginEffect(claim), fail('effect_consumed'));
  const result = bound(plan); assert.equal(store.acceptResult(result, claim, 1), true); assert.equal(store.acceptResult(result, claim, 1), true);
  assert.throws(() => store.beginEffect(claim), fail('effect_consumed'));
  const other = structuredClone(result); other.result.outputs = { conflicting: true };
  assert.equal(store.acceptResult(other, claim, 1), false);
  assert.equal(store.get('operation', plan.operation.id).state, 'succeeded');
  assert.equal(store.delivery(`operation:${plan.operation.id}`).state, 'conflict');
});
test('retry is bounded and persisted; an exception after effect start is never retried as pre-effect', async t => {
  let now = '2026-10-21T12:00:00.000Z'; const { store, plan } = fixture(t, { clock: { now: () => now } }); let starts = 0;
  const adapter = { async validate() { throw new PreEffectTransient(); }, async start() { starts++; }, async reconcile() { throw Error(); } };
  const w = worker(store, plan, adapter, { retry: { maxAttempts: 2, baseMs: 1000, capMs: 60000 }, random: () => 0 });
  await w.tick(); assert.equal(starts, 0); assert.equal(store.delivery(`operation:${plan.operation.id}`).attempts, 1);
  now = '2026-10-21T12:01:00.000Z'; await w.tick(); assert.equal(store.delivery(`operation:${plan.operation.id}`).state, 'blocked');
  store.resumeObservation(`operation:${plan.operation.id}`, context); await w.tick(); assert.equal(starts, 0);
});
test('paused or newer generations cannot cross the effect boundary', t => {
  const { store, plan } = fixture(t); const claim = store.claim(plan.operation.id, 'executor', 'attempt');
  const run = store.get('run', plan.run.id); store.pauseRun({schemaVersion:'1.0',id:'pause',runId:run.id,expectedRevision:run.revision,command:'pause'},context);
  assert.throws(() => store.beginEffect(claim), fail('effect_blocked'));
});
test('restore of an older consistent database observes the external effect before resuming', async t => {
  const { root, state, store, plan } = fixture(t); const receiver = await target(t, root);
  const backup = join(root, 'backup.sqlite'); const db = new DatabaseSync(join(state, 'state.sqlite'));
  db.prepare('VACUUM INTO ?').run(backup); db.close();
  const first = await run(t, 'normal', state, receiver.url); await first.reply; await first.p.exited;
  const restored = join(root, 'restored'); const { mkdirSync } = await import('node:fs'); mkdirSync(restored); copyFileSync(backup, join(restored, 'state.sqlite'));
  const runtime = startCoordinator(restored); t.after(() => runtime.store.close()); runtime.store.enterRestore(context);
  assert.throws(() => runtime.store.claim(plan.operation.id, 'new','new'), fail('effect_blocked'));
  assert.throws(() => runtime.store.resumeAfterRestore(context), fail('recovery_required'));
  const second = await run(t, 'normal', restored, receiver.url); assert.equal((await second.reply).state, 'succeeded'); await second.p.exited;
  await observeRestoreProjections(runtime.store, join(root, 'restore-provider'));
  runtime.store.resumeAfterRestore(context); assert.equal(receiver.calls(), 1);
});
test('conflicting resource claims remain locked until evidence, with monotonically increasing fences', async t => {
  const { nextGeneration } = await import('./helpers/execution-fixture.mjs');
  const { store, plan } = fixture(t); const first = store.claim(plan.operation.id, 'one', 'one'); store.beginEffect(first);
  const next = (await import('./helpers/execution-fixture.mjs')).nextIssue(store,2,'development',plan.resourceKey);
  assert.throws(() => store.claim(next.operation.id, 'two', 'two'), fail('resource_busy'));
  store.markUnknown(plan.operation.id);
  assert.throws(() => store.claim(next.operation.id, 'two', 'two'), fail('resource_busy'));
  store.acceptResult(bound(plan), null, store.get('operation', plan.operation.id).revision);
  const second = store.claim(next.operation.id, 'two', 'two'); assert.equal(second.fencingNumber, first.fencingNumber + 1);
  assert.throws(() => store.beginEffect(first), fail('effect_consumed'));
});
test('later generation is rejected without invalidating the original unconsumed claim', async t => {
  const { nextGeneration } = await import('./helpers/execution-fixture.mjs');
  const { store, plan } = fixture(t); const claim = store.claim(plan.operation.id, 'one', 'one');
  assert.throws(() => nextGeneration(store), fail('issue_busy'));
  store.beginEffect(claim); assert.equal(store.get('operation',plan.operation.id).state,'running');
});
test('adapter input mutation cannot alter persisted requests; post-boundary exceptions remain unknown', async t => {
  const { store, plan } = fixture(t); let starts = 0;
  const adapter = { async validate(operation) { operation.targetId = 'substituted'; },
    async start(operation) { assert.equal(operation.targetId, plan.operation.request.targetId); starts++; throw new PreEffectTransient(); },
    async reconcile(operation) { return { ...bound(plan), result: { status: 'outcome_unknown', handle: null, resources: [], outputs: {}, evidenceRefs: [], error: { code: 'outcome_unknown', message: 'Uncertain', evidenceId: null, retryClass: 'reconcile' } } }; } };
  const w = worker(store, plan, adapter); await w.tick(); await w.tick();
  assert.equal(starts, 1); assert.equal(store.get('operation', plan.operation.id).state, 'outcome_unknown');
});
test('malformed result and invalid follow-up projection roll back result and preserve the active claim', t => {
  const { store, plan } = fixture(t); const claim = store.claim(plan.operation.id, 'one','one'); store.beginEffect(claim);
  const bad = bound(plan); bad.result.evidenceRefs = [];
  assert.throws(() => store.acceptResult(bad, claim, 1), fail('invalid_payload'));
  const projection = { ...plan.projections[0], id: 'new-projection', runId: 'wrong-run' };
  assert.throws(() => store.acceptResult(bound(plan), claim, 1, [projection]), fail('identity_conflict'));
  assert.equal(store.get('operation', plan.operation.id).state, 'running');
  const good = { ...plan.projections[0], id: 'result-projection' };
  store.acceptResult(bound(plan), claim, 1, [good]);
  assert.equal(store.delivery(`projection:${good.id}`).state, 'pending');
});
test('reconciliation cannot apply a result for a different operation with the same revision', async t => {
  const { nextGeneration } = await import('./helpers/execution-fixture.mjs');
  const { store, plan } = fixture(t); store.markUnknown(plan.operation.id);
  const next = (await import('./helpers/execution-fixture.mjs')).nextIssue(store); store.markUnknown(next.operation.id);
  const wrong = bound(next);
  const adapter = { async validate() {}, async start() { throw Error(); }, async reconcile(request) {
    if (request.operationId === plan.operation.id) return wrong;
    throw Error('No evidence for second operation');
  } };
  await worker(store,plan,adapter).tick();
  assert.equal(store.get('operation',plan.operation.id).state,'outcome_unknown');
  assert.equal(store.get('operation',next.operation.id).state,'outcome_unknown');
});
test('a concurrent worker cannot initiate any effect before the intent transaction commits', async t => {
  const { root, state, store, plan } = fixture(t,{},false); const receiver = await target(t,root);
  const preparer = child(t,'inbox-process.mjs',['before',state]); await message(preparer);
  const waiting = message(preparer); preparer.send('go'); assert.equal((await waiting).stage,'before');
  const adapter = { async validate() {}, async start(operation) { return (await fetch(receiver.url+'/start',{ method:'POST',body:JSON.stringify(operation) })).json(); }, async reconcile() { throw Error(); } };
  const w = worker(store,plan,adapter); await w.tick(); assert.equal(receiver.calls(),0);
  const exit = preparer.exited; preparer.kill('SIGKILL'); await exit;
  assert.equal(store.snapshot().records.filter(r=>r.kind==='operation').length,0);
  schedule(store); await w.tick(); assert.equal(receiver.calls(),1);
});
test('concurrent distinct executor processes receive one authorized claim', async t => {
  const { state,store,plan } = fixture(t);
  const processes = await Promise.all([run(t,'claim-race',state,'unused'),run(t,'claim-race',state,'unused')]);
  const exits = processes.map(r=>r.p.exited); const results = await Promise.all(processes.map(r=>r.reply)); await Promise.all(exits);
  assert.equal(results.filter(r=>r.stage==='claimed').length,1);
  assert.equal(results.filter(r=>r.error==='resource_busy').length,1);
  assert.equal(store.get('operation',plan.operation.id).state,'claimed');
  assert.equal(store.executionHistory(plan.operation.id).filter(r=>r.kind==='claim').length,1);
});
test('restore requires a fresh observation epoch; delayed receipts cannot clear its gate', async t => {
  const { store,plan,root } = fixture(t); const claim=store.claim(plan.operation.id,'one','one');store.beginEffect(claim);
  const result=bound(plan);store.acceptResult(result,claim,1);const priorEpoch=store.recoveryEpoch();
  store.enterRestore(context);
  store.acceptResult(result,claim,1);
  assert.throws(()=>store.resumeAfterRestore(context),fail('recovery_required'));
  assert.throws(()=>store.acceptResult(result,null,store.get('operation',plan.operation.id).revision,[],priorEpoch),fail('revision_conflict'));
  store.acceptResult(result,null,store.get('operation',plan.operation.id).revision,[],store.recoveryEpoch());
  await observeRestoreProjections(store, join(root, 'restore-provider'));
  store.resumeAfterRestore(context);
});
test('the full bounded resource result commits atomically across lifecycle write batches', t => {
  const { store,plan } = fixture(t); const claim=store.claim(plan.operation.id,'one','one');store.beginEffect(claim);
  const result=bound(plan);result.result.resources=Array.from({length:128},(_,i)=>({type:'synthetic',id:`resource:${i}`,state:'ready'}));
  store.acceptResult(result,claim,1);
  assert.equal(store.snapshot().records.filter(r=>r.kind==='resource').length,128);
  assert.equal(store.get('operation',plan.operation.id).state,'succeeded');
  assert.equal(store.acceptResult(result,claim,1),true);
  assert.equal(store.snapshot().records.filter(r=>r.kind==='resource').length,128);
});
