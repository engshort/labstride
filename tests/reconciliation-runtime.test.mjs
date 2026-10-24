import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { publicRecoveryFixture } from './helpers/public-recovery-fixture.mjs';
import { publicFixture } from './helpers/public-installation-fixture.mjs';
import { mergeFixture } from './helpers/merge-fixture.mjs';
import { cleanupFixture } from './helpers/cleanup-fixture.mjs';
import { workflowFixture } from './helpers/workflow-fixture.mjs';
import { seed, schedule, nextIssue } from './helpers/execution-fixture.mjs';
import { provider } from './helpers/observation-fixture.mjs';
import { checkInstallation } from '../packages/operations/diagnostics.ts';
import { readStatus } from '../packages/operations/inspection.ts';
import { openOperationalRuntime } from '../packages/operations/runtime.ts';
import { createBackupBundle, restoreBundle } from '../packages/operations/recovery.ts';
import { probeReady, saveProbe } from '../packages/operations/runner-probe.ts';
import { cli } from '../apps/cli/main.ts';
import { startExecution } from '../apps/coordinator/runtime.ts';
import { startCoordinator } from '../apps/coordinator/main.ts';
import { actionKey } from '../packages/core/worker.ts';
import { context, localAuthority } from './helpers/configuration-fixture.mjs';

const oldUmask = process.umask(0o077); process.on('exit', () => process.umask(oldUmask));
test('public bundle restore retains frozen configuration and original broker receipt identity with retained artifact bytes', async t => {
  const f = await publicRecoveryFixture(t, { fence: false }), bundle = join(f.root, 'complete-backup');
  await createBackupBundle(f.spec, bundle);
  f.spec.stateDirectory = join(f.root, 'restored'); mkdirSync(f.spec.stateDirectory, { mode: 0o700 }); f.write();
  await restoreBundle(f.spec, bundle);
  for (const pin of f.spec.lock.extensions) renameSync(pin.artifactPath, pin.artifactPath + '.unavailable');
  const runtime = await f.open();
  assert.equal(runtime.store.runConfiguration(f.op.runId).digest, f.original.digest);
  assert.deepEqual(runtime.store.workflowClaim(f.op.operationId), f.original.claim);
  assert.equal((await f.post('claim', f.message)).status, 403);
  assert.equal((await f.post('receipt', f.receipt)).status, 200);
  f.complete(); t.mock.timers.tick(16000); await runtime.tick();
  assert.equal(runtime.store.get('operation', f.op.operationId).state, 'succeeded');
  assert.deepEqual(runtime.store.recoveryStatus().unresolved, []);
  assert.equal(f.dispatches(), 1); assert.equal(f.methods.filter(method => method === 'create').length, 1);
  await f.close(); await cli(['recovery','resume','--config',f.path], () => {});
  assert.equal(readStatus(f.spec.stateDirectory).recovery.paused, false);
});
for (const evidence of ['missing','expired','corrupt','future','mismatched']) test(`fenced installed restart with ${evidence} runner proof retains authenticated receipts and independent recovery`, async t => {
  const f = await publicRecoveryFixture(t), proof = join(f.spec.stateDirectory, 'runner-probe.json');
  if (evidence === 'missing') unlinkSync(proof);
  if (evidence === 'expired') t.mock.timers.tick(61000);
  if (evidence === 'corrupt') writeFileSync(proof, '{"schemaVersion":"unknown"}');
  if (evidence === 'future') { const value = JSON.parse(readFileSync(proof)); value.observedAt = new Date(Date.now() + 60000).toISOString(); writeFileSync(proof, JSON.stringify(value)); }
  if (evidence === 'mismatched') f.spec.configuration.limits.development++;
  assert.equal(probeReady(f.spec), false);
  const database = join(f.spec.stateDirectory, 'state.sqlite'), before = readFileSync(database);
  await assert.rejects(f.open('normal'), /configuration_invalid/);
  assert.deepEqual(readFileSync(database), before);
  const checked = await checkInstallation(f.spec, true, { transport: f.transport, route: false, mode: 'reconcile-only' });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  assert.equal(checked.diagnostics.find(item => item.code === 'runner_probe_required').severity, 'warning');
  const doctor = await checkInstallation(f.spec, true, { transport: f.transport, route: false, database: true });
  assert.equal(doctor.ok, false); assert.equal(doctor.diagnostics.find(item => item.code === 'runner_probe_required').severity, 'error');
  const runtime = await f.open();
  const views = []; await cli(['runs','show',f.op.runId,'--config',f.path], value => views.push(value));
  assert.deepEqual(views[0].startup, []);
  assert.equal(runtime.store.get('installation', f.spec.configuration.installationId).configRevision, f.original.digest);
  assert.deepEqual(runtime.store.policyStatus(f.spec.configuration.installationId), f.original.policy);
  const queries = f.queries.length;
  await runtime.tick(); assert.equal(f.queries.length, queries); assert(f.reads() > 0);
  assert.equal((await f.post('claim', f.message)).status, 403);
  assert.equal((await f.post('authorize-effect', { ...f.message, claimId: f.receipt.claimId })).status, 403);
  assert.equal((await f.post('receipt', f.receipt, await f.sign({ repository_id: '999' }))).status, 403);
  assert.notEqual((await f.post('receipt', { ...f.receipt, sourceSha: 'f'.repeat(40) })).status, 200);
  assert(runtime.store.recoveryStatus().unresolved.includes(f.op.operationId));
  await assert.rejects(cli(['recovery','resume','--config',f.path]), /service_lock_present/);
  assert.equal((await f.post('receipt', f.receipt)).status, 200);
  f.complete(); t.mock.timers.tick(16000); await runtime.tick();
  assert.equal(runtime.store.get('operation', f.op.operationId).state, 'succeeded');
  assert.deepEqual(runtime.store.recoveryStatus().unresolved, []);
  assert.deepEqual(runtime.store.workflowDispatch(f.op.operationId), f.original.dispatch);
  assert.deepEqual(runtime.store.workflowClaim(f.op.operationId), f.original.claim);
  saveProbe(f.spec, 'renewed-controlled-fixture'); assert.equal(probeReady(f.spec), true);
  await runtime.tick(); assert.equal(runtime.store.operations(f.op.runId).length, 2);
  assert.equal((await f.post('claim', f.message)).status, 403);
  assert.equal((await f.post('authorize-effect', { ...f.message, claimId: f.receipt.claimId })).status, 403);
  assert.equal(f.dispatches(), 1); assert.equal(f.workspace.fetches(), 1);
  assert.equal(f.methods.filter(method => method === 'create').length, 1);
  await f.close();
  await cli(['recovery','resume','--config',f.path], () => {});
  assert.equal(readStatus(f.spec.stateDirectory).recovery.paused, false);
});

test('reconciliation-only startup requires an existing matching fenced database and preserves unsupported state', async t => {
  const f = publicFixture(t); f.write();
  await assert.rejects(openOperationalRuntime(f.spec, { mode: 'reconcile-only' }));
  assert.deepEqual(readdirSync(f.spec.stateDirectory), []);
  await assert.rejects(cli(['serve','--reconcile-only','--diagnostics-only','--config',f.path]), /usage/);
  const file = join(f.spec.stateDirectory, 'state.sqlite'), db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=1; CREATE TABLE preserve(value TEXT)'); db.close(); chmodSync(file, 0o600);
  const before = readFileSync(file);
  await assert.rejects(openOperationalRuntime(f.spec, { mode: 'reconcile-only' })); assert.deepEqual(readFileSync(file), before);
  writeFileSync(file, 'corrupt database'); const corrupt = readFileSync(file);
  await assert.rejects(openOperationalRuntime(f.spec, { mode: 'reconcile-only' })); assert.deepEqual(readFileSync(file), corrupt);
});

test('an unfenced or differently bound installation cannot use reconciliation-only admission', async t => {
  const f = await publicRecoveryFixture(t, { fence: false });
  await assert.rejects(f.open(), /recovery_required/);
  await cli(['recovery','begin','--config',f.path], () => {});
  const originalId = f.spec.configuration.installationId; f.spec.configuration.installationId = 'another-installation';
  await assert.rejects(f.open(), /installation_binding_invalid/); f.spec.configuration.installationId = originalId;
  const pin = f.spec.lock.extensions[0], integrity = pin.integrity; pin.integrity = 'f'.repeat(64);
  await assert.rejects(f.open(), /configuration_invalid/); pin.integrity = integrity;
  const reference = f.spec.credentials['secret:project']; delete f.spec.credentials['secret:project'];
  await assert.rejects(f.open(), /configuration_invalid/); f.spec.credentials['secret:project'] = reference;
  const runtime = await f.open();
  assert(runtime.store.recoveryStatus().unresolved.includes(f.op.operationId));
  await f.close(); await assert.rejects(cli(['recovery','resume','--config',f.path]), error => error.code === 'recovery_required');
});

test('fenced reconciliation cannot create a merge intent from an adapter reconcile path', async t => {
  const f = await mergeFixture(t), op = f.op;
  f.store.enterRestore(context); f.close();
  const runtime = startExecution(f.state, { mode: 'reconcile-only', dependencies: f.dependencies,
    actions: { executorId: 'recovery', nextAttempt: () => 'never', adapters: new Map() }, observations: { sessions: new Map(), projections: new Map() },
    githubMerge: { host: f.f.dependencies.host, provider: f.provider } });
  try {
    await runtime.tick(); await runtime.drain();
    assert.equal(runtime.store.mergeRecord(op.operationId), null);
    assert.equal(f.target.effects().length, 0); assert.equal(f.target.puts().length, 0);
    assert(runtime.store.recoveryStatus().unresolved.includes(op.operationId));
  } finally { await runtime.close(); }
});

test('reconciliation reads preserve projection conflicts, pending actions and requested cancellation without effects', async t => {
  const f = publicFixture(t), dependencies = { policyAuthority: localAuthority };
  const { store } = startCoordinator(f.spec.stateDirectory, dependencies); seed(store); const plan = schedule(store);
  const claim = store.claim(plan.operation.id, 'original', 'original'); store.beginEffect(claim); store.markUnknown(plan.operation.id);
  const external = provider(join(f.root, 'field.sqlite'), plan.projections[0]); t.after(() => external.close()); external.human();
  store.cancelRun({ schemaVersion: '1.0', id: 'cancel', runId: plan.run.id, expectedRevision: store.get('run', plan.run.id).revision, command: 'cancel' }, context, localAuthority);
  store.enterRestore(context); const pending = nextIssue(store);
  const cancellation = store.controlStatus(plan.run.id).cancellations;
  store.close();
  let starts = 0, validates = 0, cancellations = 0, reads = 0;
  const adapter = { async validate() { validates++; }, async start() { starts++; throw Error('unexpected_effect'); },
    async cancel() { cancellations++; throw Error('unexpected_effect'); }, async reconcile(request) { reads++;
      return { schemaVersion: '1.0', kind: 'result', operationId: request.operationId, requestDigest: request.requestDigest,
        result: { status: 'outcome_unknown', handle: null, resources: [], outputs: {}, evidenceRefs: ['fixture:uncertain'],
          error: { code: 'outcome_unknown', message: 'Retain uncertainty', retryClass: 'reconcile', evidenceId: null } } }; } };
  const runtime = startExecution(f.spec.stateDirectory, { mode: 'reconcile-only', dependencies,
    actions: { executorId: 'recovery', nextAttempt: () => 'never', adapters: new Map([[actionKey(plan.operation.request.actionId, plan.operation.request.actionVersion), adapter]]) },
    observations: { sessions: new Map(), projections: new Map([[plan.projections[0].providerId, external.adapter]]) } });
  try {
    await runtime.tick(); await runtime.drain();
    assert.equal(reads, 1); assert.equal(starts, 0); assert.equal(validates, 0); assert.equal(cancellations, 0);
    assert.equal(external.count(), 0); assert.equal(external.adapter.reads, 1); assert.equal(external.view().value, 'human-edited');
    assert.equal(runtime.store.delivery(`projection:${plan.projections[0].id}`).state, 'conflict');
    assert.equal(runtime.store.get('operation', pending.operation.id).state, 'prepared');
    assert.deepEqual(runtime.store.controlStatus(plan.run.id).cancellations, cancellation);
    assert(runtime.store.recoveryStatus().unresolved.includes(plan.operation.id));
    await runtime.tick(); assert.equal(runtime.store.delivery(`projection:${plan.projections[0].id}`).state, 'conflict');
  } finally { await runtime.close(); }
});

test('reconciliation-only runtime leaves a real queued cleanup request and checkout untouched', async t => {
  const f = await cleanupFixture(t); f.store.enterRestore(context);
  const requests = f.store.cleanupRequests(f.runId);
  const runtime = startExecution(f.state, { mode: 'reconcile-only', dependencies: f.dependencies,
    actions: { executorId: 'recovery', nextAttempt: () => 'never', adapters: new Map() },
    observations: { sessions: new Map(), projections: new Map() }, cleanup: f.options });
  try {
    await runtime.tick(); await runtime.drain();
    assert.equal(f.inspectCalls, 0); assert.deepEqual(runtime.store.cleanupRequests(f.runId), requests);
    assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8'), 'original source\n');
  } finally { await runtime.close(); }
});

test('SIGKILL after a fenced broker receipt commit preserves the original receipt before any HTTP reply', async t => {
  const f = await workflowFixture(t), claimReply = await f.post('claim'); assert.equal(claimReply.status, 200);
  const claim = claimReply.body.claim, message = { schemaVersion: '1.0', requestDigest: f.op.requestDigest, claimId: claim.claimId };
  assert.equal((await f.post('authorize-effect', message)).status, 200);
  const receipt = { schemaVersion: '1.0', operationId: f.op.operationId, requestDigest: f.op.requestDigest, claimId: claim.claimId,
    fencingNumber: claim.fencingNumber, executor: claim.executor, sourceSha: f.op.source.sha, targetId: f.op.targetId,
    conclusion: 'succeeded', observedAt: f.now(), resources: [], outputs: {} };
  f.store.enterRestore(context); const epoch = f.store.recoveryEpoch(); await f.stopListener();
  const file = join(f.root, 'receipt-boundary.json'); writeFileSync(file, JSON.stringify({ now: f.now(), runs: f.runs, jwk: f.jwk }), { mode: 0o600 });
  const child = fork(new URL('./helpers/recovery-receipt-process.mjs', import.meta.url), [f.state, file], { stdio: ['ignore','ignore','pipe','ipc'] });
  const exited = once(child, 'exit'); let errors = ''; child.stderr.on('data', part => { errors += part; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const next = async () => (await once(child, 'message', { signal: AbortSignal.timeout(10000) }))[0];
  const { origin } = await next(); assert(origin, errors);
  const committed = next();
  const pending = fetch(`${origin}/v1/operations/${f.op.operationId}/receipt`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await f.sign()}` }, body: JSON.stringify(receipt) })
    .then(() => assert.fail('the killed receiver must not acknowledge the receipt'), () => {});
  assert.equal((await committed).committed, true); child.kill('SIGKILL'); await exited; await pending;
  await f.restart();
  assert.deepEqual(f.store.workflowReceipt(f.op.operationId), receipt); assert.equal(f.store.recoveryEpoch(), epoch);
  assert.throws(() => f.store.resumeAfterRestore(context), error => error.code === 'recovery_required');
  assert.equal((await f.post('receipt', receipt)).status, 200);
  f.runs[0].status = 'completed'; f.runs[0].conclusion = 'success';
  const worker = f.worker(); await worker.tick(); await worker.drain();
  assert.equal(f.store.get('operation', f.op.operationId).state, 'succeeded');
  assert.deepEqual(f.store.recoveryStatus().unresolved, []); assert.equal(f.dispatches(), 1);
});
