import { removeDeploymentOrderingMigration } from './helpers/migration-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPair } from 'jose';
import { workflowFixture } from './helpers/workflow-fixture.mjs';
import { context, localAuthority, observation, planFor } from './helpers/configuration-fixture.mjs';
import { startExecution } from '../apps/coordinator/runtime.ts';
import { createServer } from 'node:net';
import { workflowResource } from '../packages/core/workflow-broker.ts';
import { configuredWorkflowAction } from '../packages/workflow-broker/action.ts';
import { claimOperation, executeClaim, reportReceipt } from '../tools/workflow-runner/client.mjs';

const body = x => ({ schemaVersion: '1.0', requestDigest: x.op.requestDigest });
async function claimed(x) { const reply = await x.post('claim'); assert.equal(reply.status, 200, JSON.stringify(reply.body)); return reply.body; }
const permit = (x, claim) => x.post('authorize-effect', { ...body(x), claimId: claim.claimId });
function receipt(x, claim, patch = {}) {
  return { schemaVersion: '1.0', operationId: x.op.operationId, requestDigest: x.op.requestDigest, claimId: claim.claimId, fencingNumber: claim.fencingNumber,
    executor: claim.executor, sourceSha: x.op.source.sha, targetId: x.op.targetId, conclusion: 'succeeded', observedAt: x.now(), resources: [], outputs: {}, ...patch };
}
function dispatchOnly(x) { const claim = x.store.claim(x.op.operationId, 'coordinator', 'dispatch'); x.store.beginEffect(claim); x.store.beginWorkflowDispatch(x.op.operationId); }
function child(t, file, args) {
  const p = fork(new URL(`./helpers/${file}`, import.meta.url), args, { stdio: ['ignore','ignore','pipe','ipc'] });
  p.done = once(p, 'exit'); t.after(async () => { if (p.exitCode === null && p.signalCode === null) { p.kill('SIGKILL'); await p.done; } }); return p;
}
const message = async child => (await once(child, 'message', { signal: AbortSignal.timeout(10000) }))[0];
async function receiver(t, root) {
  const path = join(root, 'receiver.sqlite'), p = child(t, 'effect-target.mjs', [path]);
  const { url } = await message(p);
  return { url, calls() { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT count(*) AS n FROM calls').get().n; } finally { db.close(); } } };
}

test('AC10 local: concurrent authenticated executors receive one claim and cross one effect boundary', async t => {
  const x = await workflowFixture(t, { prepared: true }); dispatchOnly(x);
  x.runs.push({ ...x.runs[0], runId: '302' });
  const replies = await Promise.all([x.post('claim', body(x), await x.sign()), x.post('claim', body(x), await x.sign({ run_id: '302' }))]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200,409]);
  const winner = replies.find(reply => reply.status === 200).body.claim;
  const token = await x.sign({ run_id: winner.executor.runId });
  const duplicate = await x.post('claim', body(x), token); assert.deepEqual(duplicate.body.claim, winner);
  const input = { ...body(x), claimId: winner.claimId };
  const grants = await Promise.all([x.post('authorize-effect', input, token), x.post('authorize-effect', input, token)]);
  assert.deepEqual(grants.map(reply => reply.status).sort(), [200,409]);
  const target = await receiver(t, x.root);
  await Promise.all(grants.map(async reply => { if (reply.status === 200) await fetch(target.url + '/start', { method: 'POST', body: JSON.stringify(x.op) }); }));
  assert.equal(target.calls(), 1);
  await x.restart();
  assert.equal((await x.post('authorize-effect', input, token)).status, 409);
  assert.deepEqual(x.store.workflowClaim(x.op.operationId), winner);
});

test('OIDC rejects signature, validity, audience, workflow, repository, run, attempt, environment and reusable/self-hosted identities', async t => {
  const x = await workflowFixture(t);
  const badKey = (await generateKeyPair('RS256')).privateKey;
  const iat = Date.parse(x.now()) / 1000;
  for (const patch of [{ aud: 'foreign' }, { aud: [x.f.config.broker.oidcAudience] }, { iss: 'https://issuer.invalid' }, { exp: iat - 1 }, { nbf: iat + 1 },
    { repository_id: '999' }, { repository_owner_id: '999' }, { repository: 'foreign/workflows' }, { workflow_ref: 'foreign/workflow@ref' },
    { workflow_sha: 'd'.repeat(40) }, { sha: 'd'.repeat(40) }, { ref: 'refs/heads/foreign' }, { event_name: 'pull_request_target' },
    { run_id: '999' }, { run_attempt: '2' }, { environment: 'foreign' }, { runner_environment: 'self-hosted' },
    { job_workflow_ref: 'example/reusable@trusted' }, { job_workflow_sha: x.enrollment.workflowSha }]) {
    const response = await x.post('claim', body(x), await x.sign(patch));
    assert([403,409,503].includes(response.status), JSON.stringify({ patch, response }));
    assert.equal(x.store.workflowClaim(x.op.operationId), null);
  }
  assert.equal((await x.post('claim', body(x), await x.sign({}, badKey))).status, 403);
  const initial = structuredClone(x.runs[0]);
  for (const patch of [{ repositoryNodeId: 'R_foreign' }, { repositoryId: '999' }, { repository: 'foreign/workflows' }, { ownerId: '99' },
    { workflowId: '999' }, { workflowPath: '.github/workflows/foreign.yml' }, { workflowSha: 'd'.repeat(40) },
    { runId: '999' }, { runAttempt: 2 }, { event: 'push' }, { status: 'completed' }, { name: 'forged marker' }, { createdAt: '2020-01-01T00:00:00Z' }]) {
    Object.assign(x.runs[0], initial, patch);
    assert.notEqual((await x.post('claim')).status, 200, JSON.stringify(patch));
  }
  Object.assign(x.runs[0], initial);
  x.readError(true); assert.equal((await x.post('claim')).status, 503); x.readError(false);
  assert.equal((await x.post('claim')).status, 200);
});

test('AC11 local: forged receipt bindings are rejected; duplicates are immutable and conflicts retain uncertainty', async t => {
  const x = await workflowFixture(t), { claim } = await claimed(x);
  assert.equal((await x.post('receipt', receipt(x, claim))).status, 403, 'receipt before the effect boundary');
  assert.equal((await permit(x, claim)).status, 200);
  for (const patch of [{ operationId: 'foreign' }, { requestDigest: 'd'.repeat(64) }, { sourceSha: 'd'.repeat(40) }, { targetId: 'foreign' },
    { claimId: 'foreign' }, { fencingNumber: claim.fencingNumber + 1 },
    ...[{ repositoryId: '999' }, { workflowPath: '.github/workflows/foreign.yml' }, { workflowSha: 'd'.repeat(40) }, { runId: '999' }, { runAttempt: 2 }].map(patch => ({ executor: { ...claim.executor, ...patch } }))]) {
    assert.equal((await x.post('receipt', receipt(x, claim, patch))).status, 403, JSON.stringify(patch));
    assert.equal(x.store.workflowReceipt(x.op.operationId), null);
  }
  const valid = receipt(x, claim);
  assert.equal((await x.post('receipt', valid)).status, 200);
  assert.equal((await x.post('receipt', valid)).status, 200);
  assert.equal((await x.post('receipt', { ...valid, outputs: { changed: true } })).status, 409);
  assert.deepEqual(x.store.workflowReceipt(x.op.operationId), valid);
  x.runs[0].status = 'completed'; x.runs[0].conclusion = 'success';
  const result = await configuredWorkflowAction(x.store, x.f.dependencies.host, x.provider).reconcile(x.op, null);
  assert.equal(result.result.status, 'outcome_unknown');
  assert.equal(x.store.snapshot().records.filter(record => record.kind === 'deployment' && record.state === 'verified').length, 0);
});

for (const dispatch of ['normal','empty','lost']) test(`AC12 local: ${dispatch} dispatch acknowledgement retains the original operation`, async t => {
  const x = await workflowFixture(t, { dispatch }), { claim } = await claimed(x);
  assert.equal(x.dispatches(), 1); assert.equal((await permit(x, claim)).status, 200);
  const valid = receipt(x, claim); assert.equal((await x.post('receipt', valid)).status, 200);
  await x.restart(); x.runs[0].status = 'completed'; x.runs[0].conclusion = 'success';
  x.advance(); const worker = x.worker(); await worker.tick(); await worker.drain();
  assert.equal(x.store.get('operation', x.op.operationId).state, 'succeeded');
  assert.equal(x.dispatches(), 1); assert.deepEqual(x.store.workflowReceipt(x.op.operationId), valid);
  const persisted = x.store.executionHistory(x.op.operationId);
  assert.equal(persisted.filter(entry => entry.kind === 'workflow_dispatch_intent').length, 1);
  assert(!JSON.stringify(persisted).includes('OIDC_PRIVATE_SENTINEL'));
});

test('absent, duplicate, unavailable and completed-without-receipt runs remain unknown without redispatch', async t => {
  const x = await workflowFixture(t, { dispatch: 'lost' }), adapter = configuredWorkflowAction(x.store, x.f.dependencies.host, x.provider);
  x.discover(false); assert.equal((await adapter.reconcile(x.op, null)).result.status, 'outcome_unknown');
  x.discover(true); x.runs.push({ ...x.runs[0], runId: '302' });
  assert.equal((await adapter.reconcile(x.op, null)).result.status, 'outcome_unknown');
  assert.equal(x.store.workflowConflicted(x.op.operationId), true);
  await x.restart(); assert.equal((await configuredWorkflowAction(x.store, x.f.dependencies.host, x.provider).start(x.op, null)).result.status, 'outcome_unknown'); assert.equal(x.dispatches(), 1);
});

test('AC23 local: policy revocation after claim denies effect while receipts and audit remain observable', async t => {
  const x = await workflowFixture(t), { claim } = await claimed(x);
  const status = x.store.policyStatus(x.f.config.installationId);
  x.store.applyPolicyChange({ schemaVersion: '1.0', id: 'revoke-deploy', installationId: x.f.config.installationId, expectedRevision: status.revision,
    change: { kind: 'restrict', runId: x.op.runId, paused: false, actorIds: [], repositoryIds: [], targetIds: [x.op.targetId], actions: [] } }, localAuthority, context);
  assert.equal((await permit(x, claim)).status, 403);
  assert.equal(x.store.workflowReceipt(x.op.operationId), null);
  assert.equal((await x.post('receipt', receipt(x, claim))).status, 403);
  assert(x.store.executionHistory(x.op.operationId).some(entry => entry.kind === 'workflow_request_denied'));
  const result = await configuredWorkflowAction(x.store, x.f.dependencies.host, x.provider).reconcile(x.op, null);
  assert.equal(result.result.status, 'accepted');
  assert.deepEqual(x.store.workflowClaim(x.op.operationId), claim);
});

test('policy revocation after the effect still permits the original authenticated receipt', async t => {
  const x = await workflowFixture(t), { claim } = await claimed(x); assert.equal((await permit(x, claim)).status, 200);
  x.store.applyPolicyChange({ schemaVersion: '1.0', id: 'revoke-after-effect', installationId: x.f.config.installationId,
    expectedRevision: x.store.policyStatus(x.f.config.installationId).revision,
    change: { kind: 'restrict', runId: x.op.runId, paused: false, actorIds: [], repositoryIds: [], targetIds: [x.op.targetId], actions: [] } }, localAuthority, context);
  assert.equal((await x.post('receipt', receipt(x, claim))).status, 200);
});

test('HTTP contract rejects oversized, malformed, unknown-version and hook-shaped requests before claims', async t => {
  const x = await workflowFixture(t);
  for (const input of ['{', {}, { ...body(x), schemaVersion: '2.0' }, { ...body(x), executor: { runId: '301' } },
    { ...body(x), approved: true, completed: true }, { ...body(x), payload: 'x'.repeat(262144) }]) {
    const reply = await x.post('claim', input); assert([400,413].includes(reply.status));
  }
  assert.equal((await x.post('claim', body(x), 'not-a-jwt')).status, 403);
  assert.equal((await x.post('claim', body(x), undefined, { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await x.post('claim', body(x), undefined, { 'content-encoding': 'gzip' })).status, 400);
  assert.equal(x.store.workflowClaim(x.op.operationId), null);
});

for (const phase of ['dispatch','authorize','receipt']) test(`actual SIGKILL after ${phase} commit preserves original identities and denies replay`, async t => {
  const x = await workflowFixture(t, { prepared: phase === 'dispatch' });
  let claim, valid;
  if (phase === 'dispatch') { const parent = x.store.claim(x.op.operationId, 'coordinator', 'dispatch'); x.store.beginEffect(parent); }
  else { ({ claim } = await claimed(x)); if (phase === 'receipt') { await permit(x, claim); valid = receipt(x, claim); } }
  await x.stopListener();
  const path = join(x.root, 'boundary.json');
  writeFileSync(path, JSON.stringify({ now: x.now(), operationId: x.op.operationId, message: { ...body(x), claimId: claim?.claimId }, executor: claim?.executor, receipt: valid }));
  const p = child(t, 'workflow-process.mjs', [x.state, phase, path]); assert.equal((await message(p)).committed, true);
  p.kill('SIGKILL'); await p.done;
  await x.restart();
  if (phase === 'dispatch') {
    assert.equal(x.store.beginWorkflowDispatch(x.op.operationId).dispatch, false);
    assert.equal(x.store.workflowDispatch(x.op.operationId).operationId, x.op.operationId);
  } else {
    assert.deepEqual(x.store.workflowClaim(x.op.operationId), claim);
    assert.equal((await permit(x, claim)).status, 409);
    if (phase === 'receipt') { assert.equal((await x.post('receipt', valid)).status, 200); assert.deepEqual(x.store.workflowReceipt(x.op.operationId), valid); }
  }
});

for (const variant of ['a','b']) test(`AC34 local: replacement ${variant} runner observes exact application SHA separately from workflow SHA`, async t => {
  const x = await workflowFixture(t, { variant, checkoutSource: true }), value = await claimOperation(x.runnerOptions);
  const repo = join(x.root, 'application');
  const git = args => { const response = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(response.status, 0, response.stderr); return response.stdout.trim(); };
  const actualSha = git(['rev-parse','HEAD']); assert.equal(actualSha, x.op.source.sha);
  // First prove that an unbound application checkout cannot reach the effect.
  let effects = 0;
  await assert.rejects(executeClaim(x.runnerOptions, value, { observeSource: () => 'd'.repeat(40), effect: () => { effects++; } }), /source_revision_mismatch/);
  assert.equal(effects, 0);
  const target = await receiver(t, x.root); let saved;
  const result = await executeClaim(x.runnerOptions, value, { observeSource: () => git(['rev-parse', 'HEAD']),
    async effect({ operation, enrollment }) { effects++; assert.equal(operation.source.sha, x.op.source.sha); assert.equal(enrollment.workflowPath, x.enrollment.workflowPath);
      await fetch(target.url + '/start', { method: 'POST', body: JSON.stringify(operation) }); return { conclusion: 'succeeded', resources: [], outputs: { revision: operation.source.sha } }; },
    saveReceipt(receipt) { saved = receipt; } });
  assert.equal(effects, 1); assert.equal(target.calls(), 1); assert.equal(result.sourceSha, x.op.source.sha); assert.equal(result.executor.workflowSha, x.enrollment.workflowSha);
  assert.notEqual(result.sourceSha, result.executor.workflowSha); assert.deepEqual(saved, result);
  await assert.rejects(executeClaim(x.runnerOptions, value, { observeSource: () => x.op.source.sha, effect: () => { effects++; } }));
  assert.equal(effects, 1);
});

test('lost authorization reply prevents effects; lost receipt reply can resend only the saved receipt', async t => {
  const x = await workflowFixture(t), value = await claimOperation(x.runnerOptions); let effects = 0;
  const lost = { ...x.runnerOptions, fetcher: async (url, init) => { const response = await x.runnerOptions.fetcher(url, init); if (String(url).endsWith('/authorize-effect')) throw Error('lost_authorization_reply'); return response; } };
  await assert.rejects(executeClaim(lost, value, { observeSource: () => x.op.source.sha, effect: () => { effects++; } }), /lost_authorization_reply/);
  assert.equal(effects, 0); await x.restart(); assert.equal((await permit(x, value.claim)).status, 409);
  const y = await workflowFixture(t), other = await claimOperation(y.runnerOptions); let saved;
  const lostReceipt = { ...y.runnerOptions, fetcher: async (url, init) => { const response = await y.runnerOptions.fetcher(url, init); if (String(url).endsWith('/receipt')) throw Error('lost_receipt_reply'); return response; } };
  await assert.rejects(executeClaim(lostReceipt, other, { observeSource: () => y.op.source.sha, effect: () => { effects++; return { conclusion: 'succeeded', resources: [], outputs: {} }; }, saveReceipt(receipt) { saved = receipt; } }), /lost_receipt_reply/);
  assert.equal(effects, 1); await y.restart(); await reportReceipt(y.runnerOptions, saved); assert.equal(effects, 1);
  assert.deepEqual(y.store.workflowReceipt(y.op.operationId), saved);
});

test('migration 14 preserves existing uncertain operations without inventing broker dispatch evidence', async t => {
  const x = await workflowFixture(t, { prepared: true });
  const parent = x.store.claim(x.op.operationId, 'legacy-coordinator', 'legacy-dispatch'); x.store.beginEffect(parent);
  const before = x.store.get('operation', x.op.operationId);
  await x.stopListener();
  const db = new DatabaseSync(join(x.state, 'state.sqlite'));
  removeDeploymentOrderingMigration(db);
  db.exec('DROP TABLE merge_intents; DELETE FROM schema_migrations WHERE version=16; DROP TABLE deployment_evidence; DROP TABLE workflow_receipts; DROP TABLE workflow_claims; DROP TABLE workflow_dispatches; DELETE FROM schema_migrations WHERE version>=14; PRAGMA user_version=13'); db.close();
  await x.restart();
  const current = x.store.get('operation', x.op.operationId);
  assert.deepEqual(current.request, before.request); assert.equal(current.effectBoundary, 'crossed');
  assert.equal(x.store.workflowDispatch(x.op.operationId), null);
  const worker = x.worker(); await worker.tick(); await worker.drain();
  assert.equal(x.dispatches(), 0); assert.equal(x.store.get('operation', x.op.operationId).state, 'outcome_unknown');
});

test('unknown workflows keep observing through repeated outages without consuming an effect retry', async t => {
  const x = await workflowFixture(t, { dispatch: 'lost' }); x.readError(true);
  for (let i = 0; i < 12; i++) { x.advance(); const worker = x.worker(); await worker.tick(); await worker.drain(); }
  assert.equal(x.dispatches(), 1); assert.equal(x.store.get('operation', x.op.operationId).state, 'outcome_unknown');
  assert.equal(x.store.delivery(`operation:${x.op.operationId}`).state, 'reconcile');
  x.readError(false); const { claim } = await claimed(x); assert.equal((await permit(x, claim)).status, 200);
});

test('completed workflow without a receipt and an attempt rerun cannot prove completion', async t => {
  const x = await workflowFixture(t), { claim } = await claimed(x); await permit(x, claim);
  x.runs[0].status = 'completed'; x.runs[0].conclusion = 'success';
  let adapter = configuredWorkflowAction(x.store, x.f.dependencies.host, x.provider);
  assert.equal((await adapter.reconcile(x.op, null)).result.status, 'outcome_unknown');
  await x.post('receipt', receipt(x, claim));
  x.runs[0].runAttempt = 2;
  assert.equal((await adapter.reconcile(x.op, null)).result.status, 'outcome_unknown');
  assert.equal((await x.post('claim', body(x), await x.sign({ run_attempt: '2' }))).status, 403);
  assert.equal(x.dispatches(), 1);
});


test('two authorized runs targeting one environment serialize through the coordinator claim', async t => {
  const x = await workflowFixture(t), observed = observation(x.f, x.compiled);
  observed.event.subjectId = 'another-issue'; observed.event.eventId = observed.event.externalId = 'another-request';
  const build = planFor(x.f, x.compiled, '-second');
  const admitted = x.store.requestConfiguredStart(x.compiled, observed, { source: x.f.source }, (steps, observation) => {
    const plan = build(steps, observation); plan.resourceKey = workflowResource(x.enrollment); return plan;
  }, context);
  assert.equal(admitted.evaluation.outcome, 'matched');
  const second = x.store.operations(admitted.runId)[0];
  assert.throws(() => x.store.claim(second.id, 'second-coordinator', 'second-dispatch'), e => e.code === 'resource_busy');
  assert.equal(x.store.get('operation', second.id).effectBoundary, 'not_crossed');
  assert.equal(x.store.workflowDispatch(second.id), null); assert.equal(x.dispatches(), 1);
});

test('opt-in execution runtime starts its loopback broker and closes the listener cleanly', async t => {
  const x = await workflowFixture(t); await x.stopListener();
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const execution = startExecution(x.state, { actions: { executorId: 'runtime-test', nextAttempt: () => 'runtime-attempt', adapters: new Map() },
    observations: { sessions: new Map(), projections: new Map() }, dependencies: x.dependencies,
    workflowBroker: { host: x.f.dependencies.host, provider: x.provider, port } });
  try {
    await execution.ready;
    const response = await fetch(`http://127.0.0.1:${port}/v1/operations/${x.op.operationId}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(x)) });
    assert.equal(response.status, 403); await execution.tick(); await execution.drain();
    assert.equal(x.dispatches(), 1);
  } finally { await execution.close(); }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/operations/${x.op.operationId}/claim`));
});

for (const command of ['pause','cancel','takeover']) test(`remote effect authorization rechecks the ${command} control after claiming`, async t => {
  const x = await workflowFixture(t), { claim } = await claimed(x), run = x.store.get('run', x.op.runId);
  x.store[`${command}Run`]({ schemaVersion: '1.0', id: `operator-${command}`, runId: run.id, expectedRevision: run.revision, command }, context, localAuthority);
  assert.equal((await permit(x, claim)).status, 403); assert.deepEqual(x.store.workflowClaim(x.op.operationId), claim);
});

test('deadline expiry and unattended budget expiry deny previously claimed effects', async t => {
  const x = await workflowFixture(t, { deadlineMs: 1000 }), { claim } = await claimed(x);
  x.advance(1001); assert.equal((await permit(x, claim)).status, 403);
  const y = await workflowFixture(t), other = await claimed(y); y.advance(86400001);
  assert.equal((await permit(y, other.claim)).status, 403);
});

test('restore mode denies new remote effects but retains the original executor for observation', async t => {
  const x = await workflowFixture(t), { claim } = await claimed(x);
  x.store.enterRestore(context); assert.equal((await permit(x, claim)).status, 403);
  assert.deepEqual(x.store.workflowClaim(x.op.operationId), claim);
});

test('a substituted persisted enrollment cannot authorize a workflow claim', async t => {
  const x = await workflowFixture(t), record = x.store.workflowDispatch(x.op.operationId);
  const db = new DatabaseSync(join(x.state, 'state.sqlite'));
  record.enrollment.environment = 'foreign'; db.prepare('UPDATE workflow_dispatches SET payload=? WHERE operation_id=?').run(JSON.stringify(record), x.op.operationId); db.close();
  assert.equal((await x.post('claim')).status, 403); assert.equal(x.store.workflowClaim(x.op.operationId), null);
});

test('AC28: authenticated workflow error receipts redact diagnostics while preserving original receipt conflict detection', async t => {
  const x=await workflowFixture(t), {claim}=await claimed(x);assert.equal((await permit(x,claim)).status,200);
  const input=receipt(x,claim,{conclusion:'failed',error:{code:'synthetic_secret_value',message:'ISSUE_BODY_SENTINEL SESSION_TRANSCRIPT_SENTINEL',retryClass:'none'}});
  assert.equal((await x.post('receipt',input)).status,200);assert.equal((await x.post('receipt',input)).status,200);
  const saved=x.store.workflowReceipt(x.op.operationId);assert.deepEqual(saved.error,{code:'operation_failed',message:'operation_failed',retryClass:'none'});
  const history=JSON.stringify(x.store.executionHistory(x.op.operationId));for(const secret of ['synthetic_secret_value','ISSUE_BODY_SENTINEL','SESSION_TRANSCRIPT_SENTINEL'])assert(!history.includes(secret));
  assert.equal((await x.post('receipt',{...input,error:{...input.error,message:'different secret'}})).status,409);
  assert.equal(saved.claimId,input.claimId);assert.equal(saved.requestDigest,input.requestDigest);
});
