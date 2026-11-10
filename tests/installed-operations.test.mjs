import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { githubFixture } from './helpers/github-fixture.mjs';
import { configurationFixture } from './helpers/configuration-fixture.mjs';
import { startCoordinator } from '../apps/coordinator/main.ts';
import { seed, schedule, startPlan } from './helpers/execution-fixture.mjs';
import { acquireServiceLock, serviceLoop } from '../packages/operations/loop.ts';
import { ciDecision, selectAgent } from '../packages/operations/self-build.ts';
import { createWorker, actionKey } from '../packages/core/worker.ts';
import { loadExtension, freezeProfile } from '../packages/extensions/loader.ts';
import { backupDatabase, inspectDatabase } from '../packages/operations/runtime.ts';
import { GitHubRest } from '../packages/operations/github.ts';

test('outbound-only configuration compiles without a broker, but cannot enable workflow dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'labstride-installed-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = configurationFixture(root); f.config.broker = { enabled: false };
  assert.equal((await f.compile()).ok, true);
  f.config.workflows.prepare[0].action = 'labstride.github-workflow';
  const invalid = await f.compile(); assert.equal(invalid.ok, false); assert(invalid.diagnostics.some(d => d.path === '/broker'));
});

test('configured ordered advancement commits one next operation and retains it across reopen', async t => {
  const f = await githubFixture(t, { configure(f) { f.config.workflows.prepare.push({ ...structuredClone(f.config.workflows.prepare[0]), id: 'second', inputs: { ...f.config.workflows.prepare[0].inputs, note: 'second-step' } }); } });
  await f.worker.tick(); f.advance(); f.change(); await f.worker.tick();
  const run = f.store.runs()[0], first = f.store.operations(run.id)[0];
  const pin = f.compiled.snapshot.extensionLock.extensions.find(pin => pin.id === 'test.action');
  const loaded = await loadExtension(freezeProfile(run.id, f.compiled.snapshot.digest, pin, f.dependencies.host), f.dependencies.host);
  const worker = createWorker(f.store, { executorId: 'ordered-test', nextAttempt: () => crypto.randomUUID(), adapters: new Map([[actionKey('test.action', '1.0.0'), loaded.instance]]) });
  await worker.tick(); await worker.drain(); assert.equal(f.store.get('operation', first.id).state, 'succeeded');
  f.store.advanceWorkflows(f.dependencies.host); f.store.advanceWorkflows(f.dependencies.host);
  assert.equal(f.store.operations(run.id).length, 2);
  const second = f.store.operations(run.id)[1]; assert.equal(second.request.inputs.note, 'second-step');
  const other = startCoordinator(f.root); try { other.store.advanceWorkflows(f.dependencies.host); assert.equal(other.store.operations(run.id)[1].id, second.id); } finally { other.store.close(); }
  await worker.tick(); await worker.drain(); assert.equal(f.store.get('operation', second.id).state, 'succeeded');
});

test('a paused run does not advance or grant a new managed effect', async t => {
  const root = mkdtempSync(join(tmpdir(), 'labstride-effect-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store } = startCoordinator(root); t.after(() => store.close()); seed(store); schedule(store);
  const op = startPlan().operation, claim = store.claim(op.id, 'test', 'attempt'); store.beginEffect(claim);
  const run = store.get('run', op.runId);
  store.pauseRun({ schemaVersion: '1.0', id: 'pause-test', runId: run.id, expectedRevision: run.revision, command: 'pause' }, { actorId: 'operator', reason: 'Pause integration test', evidenceRefs: ['test:pause'] });
  assert.throws(() => store.beginManagedEffect(op.id, 'thread-start', { digest: 'original' }), /effect_blocked/);
});

test('actual process death after managed intent never grants another dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'labstride-managed-kill-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = startCoordinator(root); seed(runtime.store); schedule(runtime.store);
  const op = startPlan().operation, claim = runtime.store.claim(op.id, 'test', 'attempt'); runtime.store.beginEffect(claim); runtime.store.close();
  const child = fork(new URL('./helpers/managed-process.mjs', import.meta.url), [root, op.id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); assert.equal((await once(child, 'message'))[0].dispatch, true); child.kill('SIGKILL'); await exited;
  const reopened = startCoordinator(root);
  try {
    assert.deepEqual(reopened.store.beginManagedEffect(op.id, 'thread-start', { requestDigest: 'same' }), { dispatch: false, response: null });
    assert.throws(() => reopened.store.beginManagedEffect(op.id, 'thread-start', { requestDigest: 'changed' }), /identity_conflict/);
    reopened.store.finishManagedEffect(op.id, 'thread-start', { thread: 'original' });
    assert.deepEqual(reopened.store.beginManagedEffect(op.id, 'thread-start', { requestDigest: 'same' }), { dispatch: false, response: { thread: 'original' } });
  } finally { reopened.store.close(); }
});

test('service lock excludes a second process and the kernel releases it on actual death', async t => {
  const root = mkdtempSync(join(tmpdir(), 'labstride-service-lock-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = fork(new URL('./helpers/managed-process.mjs', import.meta.url), [root, 'lock'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); await once(child, 'message'); await assert.rejects(acquireServiceLock(root), /service_lock_present/);
  child.kill('SIGKILL'); await exited;
  await new Promise(resolve => setTimeout(resolve, 100)); const release = await acquireServiceLock(root); await release();
});

test('accepted long-running actions poll without consuming a transient failure budget', async t => {
  const root = mkdtempSync(join(tmpdir(), 'labstride-long-action-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = '2026-10-23T12:00:00Z'; const { store } = startCoordinator(root, { clock: { now: () => now } }); t.after(() => store.close()); seed(store); schedule(store);
  const operation = startPlan().operation;
  const adapter = { async validate() {}, async start(op) { return response(op); }, async reconcile(op) { return response(op); } };
  const response = op => ({ schemaVersion: '1.0', kind: 'result', operationId: op.operationId, requestDigest: op.requestDigest, result: { status: 'accepted', handle: 'original', resources: [], outputs: {}, evidenceRefs: ['test:running'], error: null } });
  const worker = createWorker(store, { executorId: 'test', nextAttempt: () => crypto.randomUUID(), adapters: new Map([[actionKey(operation.request.actionId, operation.request.actionVersion), adapter]]) });
  for (let i = 0; i < 12; i++) { await worker.tick(); await worker.drain(); now = new Date(Date.parse(now) + 20000).toISOString(); }
  assert.equal(store.delivery(`operation:${operation.id}`).attempts, 0); assert.equal(store.delivery(`operation:${operation.id}`).state, 'reconcile');
  assert.equal(store.get('operation', operation.id).state, 'running');
});

test('agent defaults apply only to absent fields and explicit unsupported values never fall back', () => {
  const options = { agent: { defaults: { aiMode: 'plan-id', model: 'model-id', reasoning: 'medium-id' }, runtimeValues: { aiMode: { 'plan-id': 'plan' }, model: { 'model-id': 'test-model' }, reasoning: { 'medium-id': 'medium' } } } };
  const fields = { aiMode: { present: false }, model: { present: false }, reasoning: { present: false } };
  assert.equal(selectAgent(options, fields).model.value, 'test-model');
  assert.throws(() => selectAgent(options, { ...fields, model: { present: true, value: 'foreign' } }), /unsupported_agent_choice/);
  assert.throws(() => selectAgent(options, { ...fields, reasoning: { present: true, value: null } }), /unsupported_agent_choice/);
});

test('CI requires the expected workflow and exact revision; skipped and missing checks are not green', () => {
  const sha = 'a'.repeat(40), workflows = ['.github/workflows/labstride.yml'];
  const runs = [{ path: workflows[0], head_sha: sha, event: 'pull_request', status: 'completed', conclusion: 'success', id: 10, check_suite_id: 7 }];
  const checks = [{ id: 1, head_sha: sha, check_suite: { id: 7 }, name: 'test', app: { id: 5 }, status: 'completed', conclusion: 'success' }];
  assert.equal(ciDecision(sha, workflows, runs, checks, []), 'passed');
  assert.equal(ciDecision(sha, workflows, runs, [...checks, { ...checks[0], id: 2, name: 'Optional deploy', check_suite: { id: 8 }, conclusion: 'skipped' }], []), 'passed');
  assert.equal(ciDecision(sha, workflows, runs, [{ ...checks[0], head_sha: 'b'.repeat(40) }], []), 'pending');
  assert.equal(ciDecision(sha, workflows, [{ ...runs[0], check_suite_id: undefined }], checks, []), 'pending');
  assert.equal(ciDecision(sha, workflows, [], checks, []), 'pending');
  assert.equal(ciDecision('b'.repeat(40), workflows, runs, checks, []), 'pending');
  assert.equal(ciDecision(sha, workflows, runs, [], []), 'pending');
  assert.equal(ciDecision(sha, workflows, runs, [{ ...checks[0], conclusion: 'skipped' }], []), 'failed');
  assert.equal(ciDecision(sha, workflows, runs, checks, [{ id: 1, context: 'external', state: 'failure' }]), 'failed');
});

test('dedicated installation diagnostics reject a broad user credential and extra repositories', async () => {
  const denied = new GitHubRest(async () => 'synthetic', 'secret:test', async () => new Response('{}', { status: 403 }));
  await assert.rejects(denied.installationRepositories(['repo-id']), /permission_denied/);
  const broad = new GitHubRest(async () => 'synthetic', 'secret:test', async () => Response.json({ total_count: 2, repositories: [{ node_id: 'repo-id' }, { node_id: 'foreign' }] }));
  await assert.rejects(broad.installationRepositories(['repo-id']), /repository_scope_mismatch/);
});

test('backup creates a consistent inspectable copy and refuses to replace an existing destination', async t => {
  const root = mkdtempSync(join(tmpdir(), 'labstride-backup-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'); mkdirSync(data, { mode: 0o700 }); const runtime = startCoordinator(data); seed(runtime.store); schedule(runtime.store);
  for (const suffix of ['', '-wal', '-shm']) { const file = join(data, 'state.sqlite' + suffix); if (existsSync(file)) chmodSync(file, 0o600); }
  const backup = join(root, 'copy.sqlite'); await backupDatabase(data, backup); await assert.rejects(backupDatabase(data, backup), /backup_exists/);
  assert.equal(inspectDatabase(data).runs, 1); runtime.store.close();
});

test('service loop closes exactly once after shutdown', async () => {
  const controller = new AbortController(); let ticks = 0, closes = 0;
  await serviceLoop({ async tick() { ticks++; controller.abort(); }, async close() { closes++; } }, controller.signal, 1);
  assert.equal(ticks, 1); assert.equal(closes, 1);
});

test('authenticated helper root proof preserves full target mount identity across coordinator mount namespaces', async t => {
  const { workspaceFixture } = await import('./helpers/workspace-fixture.mjs');
  const { WorkspaceRegistry } = await import('../packages/target-helper/workspaces.ts');
  const { verifyRootMapping } = await import('../packages/operations/runtime.ts');
  const f = workspaceFixture(t), registry = new WorkspaceRegistry(f.policy, f.dependencies); t.after(() => registry.close());
  const { operation: _operation, ...base } = f.request;
  const request = { ...base, method: 'probe' };
  const legacy = await registry.handle(request); assert.equal(legacy.outcome, 'ok'); assert.equal(legacy.roots, undefined);
  const proof = await registry.handle({ ...request, includeRoots: true });
  assert.equal(proof.outcome, 'ok'); assert.deepEqual(proof.roots, f.policy.roots);
  assert(proof.capabilities.includes('workspace.root-map.v1'));
  const root = f.policy.roots[0], spec = { sourceRoot: root.path, rootId: root.id, targetId: f.policy.targetId };
  const mapping = { schemaVersion: '1.0', ...spec, identity: root.identity };
  verifyRootMapping(spec, mapping, proof);
  assert.throws(() => verifyRootMapping(spec, { ...mapping, identity: { ...root.identity, mountId: root.identity.mountId + 1 } }, proof), /root_mapping_mismatch/);
  assert.throws(() => verifyRootMapping(spec, mapping, legacy), /root_mapping_mismatch/);
  const foreignView = structuredClone(proof); foreignView.roots[0].identity.inode++;
  assert.throws(() => verifyRootMapping(spec, mapping, foreignView), /root_mapping_mismatch/);
  // Model the coordinator seeing a different mount namespace while retaining
  // the same physical object; the target proof remains the full authority.
  const otherNamespace = structuredClone(proof); otherNamespace.roots[0].identity.mountId++;
  verifyRootMapping(spec, { ...mapping, identity: otherNamespace.roots[0].identity }, otherNamespace);
});

test('first installed activation atomically creates installation before policy and rolls back a rejected policy', async t => {
  const { policyFor, localAuthority, context } = await import('./helpers/configuration-fixture.mjs');
  const root = mkdtempSync(join(tmpdir(), 'labstride-first-activation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = configurationFixture(root); fixture.config.enabled = false;
  const compiled = (await fixture.compile()).configuration, policy = policyFor(fixture, compiled);
  const runtime = startCoordinator(root, { policyAuthority: localAuthority }); t.after(() => runtime.store.close());
  const id = fixture.config.installationId;
  assert.throws(() => runtime.store.activateOperationalProfile(compiled, { ...policy, installationId: 'foreign' }, localAuthority, context), /identity_conflict/);
  assert.throws(() => runtime.store.get('installation', id), /not_found/); assert.equal(runtime.store.policyHistory(id).length, 0);
  runtime.store.activateOperationalProfile(compiled, policy, localAuthority, context);
  assert.equal(runtime.store.get('installation', id).configRevision, compiled.snapshot.digest); assert.equal(runtime.store.policyStatus(id).policyRevision, 1);
  runtime.store.activateOperationalProfile(compiled, policy, localAuthority, context);
  assert.equal(runtime.store.get('installation', id).revision, 1); assert.equal(runtime.store.policyHistory(id).length, 1); assert.equal(runtime.store.runs().length, 0);
});

test('successful running observation resets consecutive read failures without replaying the action', async t => {
  const root = mkdtempSync(join(tmpdir(), 'labstride-read-recovery-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = '2026-10-23T12:00:00Z', starts = 0, reads = 0;
  const runtime = startCoordinator(root, { clock: { now: () => now } }); t.after(() => runtime.store.close()); seed(runtime.store); schedule(runtime.store);
  const operation = startPlan().operation;
  const accepted = op => ({ schemaVersion: '1.0', kind: 'result', operationId: op.operationId, requestDigest: op.requestDigest,
    result: { status: 'accepted', handle: 'original', resources: [], outputs: {}, evidenceRefs: ['test:running'], error: null } });
  const adapter = { async validate() {}, async start(op) { starts++; return accepted(op); }, async reconcile(op) { reads++; if (reads === 1) throw Error('temporary_read_failure'); return accepted(op); } };
  const worker = createWorker(runtime.store, { executorId: 'read-recovery', nextAttempt: () => crypto.randomUUID(), adapters: new Map([[actionKey(operation.request.actionId, operation.request.actionVersion), adapter]]) });
  const tick = async () => { now = new Date(Date.parse(now) + 60000).toISOString(); await worker.tick(); await worker.drain(); };
  await tick(); await tick();
  const id = `operation:${operation.id}`;
  assert.equal(runtime.store.delivery(id).attempts, 1); assert.equal(runtime.store.get('operation', operation.id).state, 'outcome_unknown');
  await tick();
  assert.equal(runtime.store.delivery(id).attempts, 0); assert.equal(runtime.store.delivery(id).lastError, null);
  assert.equal(runtime.store.get('operation', operation.id).state, 'running'); assert.equal(starts, 1); assert.equal(reads, 2);
});

test('activation catalog validates every configured model and effort, not only defaults', async()=>{
  const {validateAgentCatalog}=await import('../packages/operations/diagnostics.ts');
  const agent={defaults:{model:'default',reasoning:'high'},runtimeValues:{model:{default:'model-a',other:'model-b'},reasoning:{high:'high',low:'low'}}};
  const catalog={models:[{model:'model-a',reasoning:['high','low']},{model:'model-b',reasoning:['low']}]};
  validateAgentCatalog(agent,catalog);
  assert.throws(()=>validateAgentCatalog(agent,{models:catalog.models.slice(0,1)}),/unsupported_agent_choice/);
  assert.throws(()=>validateAgentCatalog(agent,{models:catalog.models.map(model=>({...model,reasoning:['high']}))}),/unsupported_agent_choice/);
  assert.throws(()=>validateAgentCatalog({...agent,defaults:{model:'other',reasoning:'high'}},catalog),/agent_default_unsupported/);
});

test('activation rejects incomplete, orphan and invalid agent mappings before native effects',async()=>{
  const {installationShape}=await import('../packages/operations/installation.ts');
  const {readFileSync}=await import('node:fs');
  const base=JSON.parse(readFileSync(new URL('../examples/operational-installation.json',import.meta.url)));
  installationShape(base);
  for(const change of [
    spec=>{delete spec.agent.runtimeValues.model[spec.agent.defaults.model];},
    spec=>{spec.agent.runtimeValues.model['unconfigured-option']='another-model';},
    spec=>{spec.agent.runtimeValues.aiMode[spec.agent.defaults.aiMode]='automatic-approval';},
  ]){
    const spec=structuredClone(base);change(spec);
    spec.lock.extensions.find(pin=>pin.id==='labstride.self-build').configuration.agent=spec.agent;
    assert.throws(()=>installationShape(spec),error=>['invalid_payload','unsupported_agent_choice'].includes(error.code??error.message));
  }
});
