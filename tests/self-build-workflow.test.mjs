import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceFixture } from './helpers/workspace-fixture.mjs';
import { githubFixture, localAuthority, context } from './helpers/github-fixture.mjs';
import { WorkspaceRegistry } from '../packages/target-helper/workspaces.ts';
import { workspaceStart } from '../packages/storage-sqlite/workflows.ts';
import { createSelfBuildAction } from '../packages/operations/self-build.ts';
import { createControlWorker } from '../packages/core/control-worker.ts';
import { createWorker, actionKey } from '../packages/core/worker.ts';
import { createObservationWorker } from '../packages/core/observation-worker.ts';
import { createGitHubProjection } from '../packages/provider-github/projection.ts';
import { loadExtension, freezeProfile } from '../packages/extensions/loader.ts';
import { runGit } from '../packages/target-helper/workspace-git.ts';
import { createCodexBridge } from '../packages/operations/bridge.ts';
import { backupDatabase } from '../packages/operations/runtime.ts';
import { cli } from '../apps/cli/main.ts';

// Real checkout, bundle verification, local Git push and SQLite sequencing.
// GitHub and Codex wire responses are controlled peers, not live qualification.
async function setup(t, { losePrReply = false, loseStartReply = false, supported = true, nativeReports = false, losePushReply = false, prepareFailure = false, loseReadyReply = false } = {}) {
  // The in-process helper and coordinator must share the fixture's clock;
  // otherwise its fixed one-day request expires with the real calendar.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-23T12:00:00.000Z') });
  const source = workspaceFixture(t, undefined, { priorHistory: true }); source.policy.installationId = 'installation-a'; source.policy.targetId = 'target-a';
  const registry = new WorkspaceRegistry(source.policy, source.dependencies); t.after(() => registry.close());
  const options = { sourceRoot: source.policy.roots[0].path, rootId: 'source', baseBranch: 'main', requiredWorkflows: ['.github/workflows/labstride.yml'],
    agent: { bridgeSocket: '/unused', backendIdentity: 'test', backendVersion: '0.163.0', checkedDelivery: true,
      defaults: { aiMode: 'mode-plan', model: 'model-test', reasoning: 'reason-medium' },
      runtimeValues: { aiMode: { 'mode-plan': 'plan', 'mode-none': 'none' }, model: { 'model-test': 'test-model' }, reasoning: { 'reason-medium': 'medium' } } } };
  const pins = [];
  const f = await githubFixture(t, { native: true, configure(f) {
    f.source = source.operation.source; f.config.github.repositories = [f.source.repository]; f.config.controls = {};
    f.dependencies.host.permissions.push('session.manage');
    for (const [name, value] of Object.entries({ aiMode: 'mode-plan', model: 'model-test', reasoning: 'reason-medium' })) {
      f.config.fields[name] = { source: 'organization_issue_field', scopeId: 'scope-a', fieldId: name, type: 'single-select', options: { default: value } };
      f.descriptors[name] = { ...f.descriptors['status-a'], fieldId: name, source: 'organization_issue_field', credentialRef: 'secret:repository', optionIds: [value] };
    }
    f.config.fields.aiMode.options.none = 'mode-none'; f.descriptors.aiMode.optionIds.push('mode-none');
    f.config.fields.session = { source: 'organization_issue_field', scopeId: 'scope-a', fieldId: 'session', type: 'string' };
    f.descriptors.session = { ...f.descriptors['note-a'], fieldId: 'session', scopeId: 'scope-a', source: 'organization_issue_field' };
    f.config.projections = [
      { fact: 'workspace.ready', field: 'status', value: 'busy' },
      { fact: 'workspace.ready', field: 'session', value: 'registered-checkout' },
      { fact: 'self-build.session-ready', field: 'session', valueFrom: { kind: 'session-id' } },
      ...['planning','waiting-accept','working','testing','review'].map(name => ({ fact: `self-build.${name}`, field: 'status', value: 'busy' })),
    ];
    for (const packageName of ['action-workspace-create', 'action-self-build']) {
      const artifactPath = join(f.root, packageName + '.json');
      execFileSync(process.execPath, ['scripts/package_extension.mjs', 'packages/' + packageName, artifactPath]);
      const metadata = JSON.parse(readFileSync(artifactPath)).manifest;
      pins.push({ id: metadata.id, version: metadata.version, kind: 'action', artifactPath,
        integrity: createHash('sha256').update(readFileSync(artifactPath)).digest('hex'), permissions: metadata.permissions, capabilities: metadata.capabilities,
        configuration: packageName === 'action-self-build' ? options : {} });
    }
    f.dependencies.lock.extensions = f.dependencies.lock.extensions.filter(pin => pin.kind !== 'action').concat(pins);
    f.config.workflows.prepare = [
      { id: 'checkout', action: 'labstride.workspace-create', inputs: { target: 'target-a', rootId: 'source', source: 'context.source' } },
      { id: 'coding', action: 'labstride.self-build', inputs: { schemaVersion: '1.0', target: 'target-a', workspaceId: 'context.workspaceId' } },
    ];
  }, buildPlan(_f, compiled) { return (steps, observed) => workspaceStart(compiled, steps, observed); } });
  f.item.fields.session = { present: false };
  for (const name of ['aiMode','model','reasoning']) f.item.fields[name] = { present: true, value: options.agent.defaults[name] };
  await f.worker.tick(); f.advance(); f.change(); await f.worker.tick();
  const run = f.store.runs()[0]; assert(run);
  const loaded = await loadExtension(freezeProfile(run.id, f.compiled.snapshot.digest, pins[0], f.dependencies.host), f.dependencies.host, {
    target: { async binding() { return { installationId: 'installation-a', revision: 1 }; }, async validate() {}, async invoke(request) { return registry.handle(request); } },
  });
  const checkoutWorker = createWorker(f.store, { executorId: 'checkout', nextAttempt: () => crypto.randomUUID(), adapters: new Map([[actionKey(pins[0].id, pins[0].version), loaded.instance]]) });
  await checkoutWorker.tick(); await checkoutWorker.drain();
  const workspace = f.store.workspace(run.id), cwd = join(options.sourceRoot, workspace.locator, 'source');
  f.store.advanceWorkflows(f.dependencies.host); assert.equal(f.store.operations(run.id).length, 2);
  const op = f.store.operations(run.id)[1].request, state = { starts: 0, turns: 0, latest: { id: 'initial', status: 'completed' }, report: null, creates: 0, pr: null, loss: losePrReply, startLoss: loseStartReply,
    pushes: 0, credentialReads: 0, pushLoss: losePushReply, prepareFailure, headConflict: false, readyLoss: loseReadyReply, readies: 0, changeTurnOnBundle: false };
  const remote = join(source.root, 'published.git'); runGit(source.root, ['-c', 'protocol.file.allow=always', 'clone', '--bare', '--no-hardlinks', source.repository, remote]);
  const branchSha = () => runGit(remote, ['rev-parse', `refs/heads/${workspace.branch}`]);
  const git = args => runGit(cwd, ['-c', `safe.directory=${cwd}`, ...args]);
  let bridge = { async call(request) {
    if (request.method === 'catalog') return { models: [{ model: 'test-model', reasoning: supported ? ['medium'] : [] }] };
    if (request.method === 'start') { state.starts++; if (state.startLoss) throw Error('transport_unknown'); return { thread: { id: 'original-session', cwd } }; }
    if (request.method === 'turn') { state.turns++; assert.equal(request.parameters.mode, 'plan'); return { turn: state.latest }; }
    if (request.method === 'cleanup-observe') return { schemaVersion: '1.0', runId: request.binding.runId, workspaceId: request.binding.workspaceId, path: request.binding.path, observedAt: f.now(), sessionId: request.sessionId, state: state.latest?.status === 'inProgress' ? 'active' : state.cleanupState ?? 'idle', lastTurnId: state.latest?.id ?? null };
    if (request.method === 'interrupt') { state.interrupts = (state.interrupts ?? 0) + 1; state.latest.status = 'interrupted'; if (state.interruptLoss) throw Error('transport_unknown'); return { interrupted: state.latest.id }; }
    if (request.method === 'observe') return { sessionId: 'original-session', path: cwd, state: 'idle', turn: state.latest, report: state.report };
    if (request.method === 'bundle') {
      const path = join(source.root, 'result.bundle'); git(['bundle','create',path,'HEAD']);
      if (state.changeTurnOnBundle) state.latest = { id: 'new-human-turn', status: 'inProgress' };
      return { sha: git(['rev-parse','HEAD']), branch: workspace.branch, baseSha: source.operation.source.sha, bundle: readFileSync(path).toString('base64') };
    }
    throw Error('unexpected_bridge_request');
  } };
  let nativeRpc;
  const acknowledgements = [];
  if (nativeReports) {
    state.latest = null;
    nativeRpc = { notify() {}, frame(_op, bytes) { acknowledgements.push(JSON.parse(bytes)); }, close() {}, async call(method, params) {
      if (method === 'initialize') return { userAgent: 'codex/0.163.0 linux' };
      if (method === 'model/list') return { data: [{ model: 'test-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
      if (method === 'thread/start') { state.starts++; return { thread: { id: 'original-session', cwd, historyMode: 'legacy' } }; }
      if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: 'original-session', cwd, source: 'cli', historyMode: 'legacy', status: { type: state.latest?.status === 'inProgress' ? 'active' : 'idle' } } };
      if (method === 'thread/turns/list') return { data: state.latest ? [{ ...state.latest, ...(params.itemsView === 'full' ? { itemsView: 'full', items: [] } : {}) }] : [] };
      if (method === 'turn/start') { state.turns++; state.latest = { id: 'initial', status: 'completed' }; return { turn: state.latest }; }
      throw Error('unexpected_native_method');
    } };
    bridge = createCodexBridge({ schemaVersion: '1.0', socket: join(f.root, 'native-bridge.sock'), backendSocket: '/unused', backendVersion: '0.163.0',
      sourceRoot: options.sourceRoot, helperUid: process.getuid(), stateDirectory: f.root }, nativeRpc);
    t.after(() => bridge.close());
  }
  const rest = { reference: 'secret:repository', credential: async () => { state.credentialReads++; return 'synthetic'; }, async request(method, path, input) {
    if (path.includes('/git/ref/')) {
      if (state.pushLoss) { state.pushLoss = false; throw Error('provider_unavailable'); }
      return { ref: `refs/heads/${workspace.branch}`, object: { sha: state.headConflict ? 'f'.repeat(40) : branchSha() } };
    }
    if (method === 'POST' && path.endsWith('/pulls')) {
      state.creates++; state.pr = { number: 42, node_id: 'pull-42', state: 'open', body: input.body, title: input.title, draft: true,
        head: { ref: workspace.branch, sha: branchSha(), repo: { node_id: source.operation.source.repositoryId } }, base: { ref: 'main', repo: { node_id: source.operation.source.repositoryId } }, html_url: 'https://github.com/example/source/pull/42' };
      if (state.loss) { state.loss = false; throw Error('transport_unknown'); } return state.pr;
    }
    if (path.includes('/pulls')) { if (state.readFailure) throw Error('provider_unavailable'); if (state.pr) state.pr.head.sha = branchSha(); return path.includes('?') ? state.pr ? [state.pr] : [] : state.pr; }
    if (path.includes('/actions/runs')) return { workflow_runs: [{ id: 1, check_suite_id: 7, path: options.requiredWorkflows[0], head_sha: branchSha(), event: 'pull_request', status: 'completed', conclusion: 'success' }] };
    if (path.includes('/check-runs')) return { check_runs: [{ id: 1, head_sha: branchSha(), check_suite: { id: 7 }, name: 'verify', app: { id: 1 }, status: 'completed', conclusion: 'success' }] };
    if (path.includes('/statuses')) return [];
    throw Error('unexpected_rest_request');
  } };
  const client = { async query(query) {
    if (query.includes('LabstrideCodingTask')) return { node: { title: 'Implement issue', body: 'Task data', url: 'https://github.com/example/source/issues/1', state: 'OPEN' } };
    if (query.includes('LabstrideIssueLink')) return { node: { url: 'https://github.com/example/source/issues/1' } };
    if (query.includes('LabstrideReady')) {
      state.readies++; state.pr.draft = false;
      if (state.readyLoss) { state.readyLoss = false; throw Error('transport_unknown'); }
      return {};
    }
    throw Error('unexpected_graphql_query');
  } };
  const provider = { ...f.adapter, withConfiguration() { return this; }, async describeField(field) { return f.descriptors[field.fieldId]; },
    async setField(_scope, _item, fieldId, _type, value) {
      const name = Object.keys(f.config.fields).find(name => f.config.fields[name].fieldId === fieldId);
      f.item.fields[name] = { present: true, value }; f.advance(1000); f.item.updatedAt = f.now();
    } };
  const observer = createObservationWorker(f.store, { sessions: new Map(), projections: new Map([['test.provider', createGitHubProjection(f.store, provider)]]) });
  const publicationGit = (path, args, access) => {
    if (args[0] === 'bundle' && args[1] === 'verify' && state.prepareFailure) { state.prepareFailure = false; throw Error('bundle_invalid'); }
    if (args[0] === 'push') { state.pushes++; return runGit(path, ['-c','protocol.file.allow=always','push', '--porcelain', remote, args.at(-1)]); }
    return runGit(path, args, access);
  };
  const action = createSelfBuildAction(f.store, options, provider, client, rest, bridge, publicationGit);
  const worker = createWorker(f.store, { executorId: 'coding', nextAttempt: () => crypto.randomUUID(), adapters: new Map([[actionKey(op.actionId, op.actionVersion), action]]) });
  const tick = async () => { f.advance(20000); await worker.tick(); await worker.drain(); await f.worker.tick(); await observer.tick(); };
  function commit(file, message = 'Implement issue') {
    writeFileSync(join(cwd, file), 'implemented\n'); git(['add', file]);
    git(['-c','user.name=Test','-c','user.email=test@example.test','commit','--signoff','-m',message]);
    state.latest = { id: 'human-' + file.replaceAll('.', '-'), status: 'completed' };
    state.report = { schemaVersion: '1.0', runId: run.id, sessionId: 'original-session', turnId: state.latest.id, commitSha: git(['rev-parse','HEAD']), status: 'ready', summary: 'Actual commit', prTitle: message, prBody: 'Verified tests', issueComplete: true };
    if (nativeReports) {
      state.latest.status = 'inProgress';
      nativeRpc.onNotification({ id: 73, method: 'item/tool/call', params: { threadId: 'original-session', turnId: state.latest.id, callId: 'report-' + file, tool: 'labstride_report', arguments: state.report } });
      assert.equal(acknowledgements.at(-1).result.success, true);
      state.latest.status = 'completed';
    }
  }
  return { ...f, run, op, state, cwd, tick, commit, action, provider, observer, branchSha };
}

test('journaled native report advances through real bundle and local push to one review PR without a history tool item', async t => {
  const f = await setup(t, { nativeReports: true });
  for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  assert.equal(f.state.turns, 1);
  f.commit('native-report.txt');
  await f.tick(); await f.tick();
  assert.equal(f.state.creates, 1, f.store.workflowDiagnostic(f.run.id));
  assert.equal(f.state.pr.draft, false);
  assert.equal(f.branchSha(), f.state.report.commitSha);
  assert.equal(f.store.managedReport(f.run.id).turnId, f.state.latest.id);
  assert.equal(f.state.starts, 1); assert.equal(f.state.turns, 1);
});

test('checkout advances to the original Plan session and publishes follow-up commits to the same review PR', async t => {
  const f = await setup(t); for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  assert.equal(f.state.starts, 1); assert.equal(f.state.turns, 1);
  assert.equal(f.store.managedSession(f.run.id).sessionId, 'original-session');
  f.commit('first.txt'); await f.tick(); await f.tick();
  assert.equal(f.state.creates, 1, JSON.stringify({diagnostic:f.store.workflowDiagnostic(f.run.id),operations:f.store.controlStatus(f.run.id).operations})); assert.equal(f.state.pr.draft, false); assert.equal(f.state.pr.head.sha, f.state.report.commitSha);
  f.state.pr.title = 'Human review title'; f.commit('second.txt'); await f.tick(); await f.tick();
  assert.equal(f.state.creates, 1, JSON.stringify({diagnostic:f.store.workflowDiagnostic(f.run.id),operations:f.store.controlStatus(f.run.id).operations})); assert.equal(f.state.pr.title, 'Human review title'); assert.equal(f.branchSha(), f.state.report.commitSha);
  assert.equal(f.store.managedProjectionDiagnostics(f.run.id).length, 0);
  assert.equal(f.store.get('operation', f.op.operationId).state, 'running');
  assert.equal(f.store.workflowDiagnostic(f.run.id), null);
  assert.equal(f.state.starts, 1); assert.equal(f.state.turns, 1);
});

test('a lost PR creation response adopts exact independent PR evidence without creating a second PR', async t => {
  const f = await setup(t, { losePrReply: true }); for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick(); f.commit('lost.txt');
  await f.tick(); await f.tick(); await f.tick();
  assert.equal(f.state.creates, 1); assert.equal(f.state.pushes, 1);
  assert.equal(f.store.readManagedEffect(f.op.operationId, 'pull-request-create').number, f.state.pr.number);
  assert.equal(f.store.get('operation', f.op.operationId).state, 'running');
});

test('failed local preparation records no push intent or credential read and can be retried safely', async t => {
  const f = await setup(t, { prepareFailure: true });
  for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  f.commit('preparation.txt'); await f.tick();
  const name = `push-${f.state.report.commitSha.slice(0, 20)}`;
  assert.equal(f.store.hasManagedEffect(f.op.operationId, name), false);
  assert.equal(f.state.pushes, 0); assert.equal(f.state.credentialReads, 0); assert.equal(f.state.creates, 0);
  await f.tick(); await f.tick();
  assert.equal(f.state.pushes, 1); assert.equal(f.state.creates, 1); assert.equal(f.state.pr.draft, false);
  assert.equal(f.store.delivery(`operation:${f.op.operationId}`).lastError, null);
});

test('lost push readback adopts the exact remote ref and never repeats the push', async t => {
  const f = await setup(t, { losePushReply: true });
  for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  f.commit('push-reply.txt'); await f.tick();
  const name = `push-${f.state.report.commitSha.slice(0, 20)}`;
  assert.equal(f.state.pushes, 1); assert.equal(f.store.readManagedEffect(f.op.operationId, name), null);
  await f.tick(); await f.tick();
  assert.equal(f.state.pushes, 1); assert.equal(f.state.creates, 1);
  assert.equal(f.store.readManagedEffect(f.op.operationId, name).sha, f.state.report.commitSha);
});

test('conflicting remote evidence retains the unknown intent and never repeats a push', async t => {
  const f = await setup(t, { losePushReply: true });
  for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  f.commit('conflict.txt'); await f.tick(); f.state.headConflict = true;
  await f.tick(); await f.tick();
  assert.equal(f.state.pushes, 1); assert.equal(f.state.creates, 0);
  assert.equal(f.store.readManagedEffect(f.op.operationId, `push-${f.state.report.commitSha.slice(0, 20)}`), null);
  assert.equal(f.store.get('operation', f.op.operationId).state, 'outcome_unknown');
});

test('manual PR marker changes cannot resolve an unknown PR creation', async t => {
  const f = await setup(t, { losePrReply: true });
  for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  f.commit('pr-conflict.txt'); await f.tick(); f.state.pr.body = 'Human description without a run marker';
  await f.tick(); await f.tick();
  assert.equal(f.state.creates, 1); assert.equal(f.state.pushes, 1);
  assert.equal(f.store.readManagedEffect(f.op.operationId, 'pull-request-create'), null);
});

test('lost review-readiness reply is adopted from the exact current PR without another mutation', async t => {
  const f = await setup(t, { loseReadyReply: true });
  for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  f.commit('ready-reply.txt'); await f.tick();
  assert.equal(f.state.readies, 1);
  await f.tick(); await f.tick();
  assert.equal(f.state.readies, 1); assert.equal(f.state.creates, 1); assert.equal(f.state.pushes, 1);
  assert.equal(f.store.readManagedEffect(f.op.operationId, `ready-${f.state.report.commitSha.slice(0, 20)}`).sha, f.state.report.commitSha);
});

test('a newer independently reported commit never rewrites or repeats an older uncertain push', async t => {
  const f = await setup(t);
  for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  f.commit('older.txt'); const older = f.state.report.commitSha;
  f.store.beginManagedEffect(f.op.operationId, `push-${older.slice(0, 20)}`, { requestDigest: 'preserved-unknown' });
  f.commit('newer.txt'); await f.tick(); await f.tick();
  assert.equal(f.state.pushes, 1); assert.equal(f.branchSha(), f.state.report.commitSha);
  assert.equal(f.store.readManagedEffect(f.op.operationId, `push-${older.slice(0, 20)}`), null);
  assert.equal(f.state.creates, 1);
});

test('a human turn during preparation records no remote push intent', async t => {
  const f = await setup(t);
  for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  f.commit('stale.txt'); f.state.changeTurnOnBundle = true; await f.tick();
  assert.equal(f.state.pushes, 0); assert.equal(f.state.creates, 0);
  assert.equal(f.store.hasManagedEffect(f.op.operationId, `push-${f.state.report.commitSha.slice(0, 20)}`), false);
});


test('a lost native start reply keeps its frozen Plan choice despite later No agent fields and never starts again', async t => {
  const f = await setup(t, { loseStartReply: true });
  for (let i = 0; i < 8 && !f.state.starts; i++) await f.tick();
  assert.equal(f.state.starts, 1); assert.equal(f.store.managedSessionStart(f.op.operationId).mode, 'plan');
  f.item.fields.aiMode = { present: true, value: 'mode-none' };
  await f.tick(); await f.tick();
  assert.equal(f.state.starts, 1); assert.equal(f.state.turns, 0); assert.equal(f.store.managedSession(f.run.id), null);
  assert.equal(f.store.get('operation', f.op.operationId).state, 'outcome_unknown');
  const selected = f.store.managedSessionStart(f.op.operationId);
  const stateDirectory = join(f.root, 'inspection'); mkdirSync(stateDirectory, { mode: 0o700 });
  await backupDatabase(f.root, join(stateDirectory, 'state.sqlite'));
  const spec = JSON.parse(readFileSync(new URL('../examples/operational-installation.json', import.meta.url)));
  Object.assign(spec, { stateDirectory, sourceRoot: join(f.cwd, '..', '..'), configuration: f.compiled.snapshot.configuration });
  const path = join(f.root, 'inspection.json'); writeFileSync(path, JSON.stringify(spec), { mode: 0o600 });
  const views = [];
  await cli(['runs','show',f.run.id,'--config',path], value => views.push(value));
  await cli(['runs','list','--config',path], value => views.push(value.runs[0]));
  for (const view of views) {
    assert.equal(view.session, null); assert.deepEqual(view.startup, [selected]);
    assert.equal(view.startup[0].mode, 'plan'); assert.equal(view.startup[0].model, 'test-model');
    assert.equal(view.startup[0].choices.aiMode, 'mode-plan');
    assert.equal(JSON.stringify(view).includes('Task data'), false);
  }
  assert.equal(f.state.starts, 1);
  assert.equal((await f.action.cancel(f.op, null, 'cancel-unknown')).result.status, 'accepted');
});

test('unsupported startup choices create no native intent and operator cancellation releases the retained workspace', async t => {
  const f = await setup(t, { supported: false });
  for (let i = 0; i < 6; i++) await f.tick();
  assert.equal(f.state.starts, 0); assert.equal(f.store.hasManagedEffect(f.op.operationId, 'thread-start'), false);
  assert.equal(f.store.workflowDiagnostic(f.run.id), 'unsupported_agent_choice');
  const run = f.store.get('run', f.run.id);
  f.store.cancelRun({ schemaVersion: '1.0', id: 'cancel-unsupported-start', runId: run.id, expectedRevision: run.revision, command: 'cancel' }, context, localAuthority);
  const controls = createControlWorker(f.store, { executorId: 'test-cancel', nextAttempt: () => crypto.randomUUID(), adapters: new Map([[actionKey(f.op.actionId, f.op.actionVersion), f.action]]) });
  await controls.tick(); await controls.drain();
  assert.equal(f.store.get('run', run.id).state, 'cancelled'); assert.equal(f.store.workspace(run.id).keep, true);
  assert.equal(f.state.starts, 0);
});


async function readyMergeFixture(t) {
  const f = await setup(t);
  for (let i = 0; i < 8 && !f.state.turns; i++) await f.tick();
  f.commit('merge-ready.txt'); await f.tick(); await f.tick();
  assert.equal(f.state.creates, 1);
  assert.equal(f.store.get('operation', f.op.operationId).state, 'running');
  f.state.pr.merged = true; f.state.pr.state = 'closed';
  return f;
}
const writeCounts = f => ({ pushes: f.state.pushes, creates: f.state.creates, starts: f.state.starts, turns: f.state.turns, readies: f.state.readies });
test('exact acknowledged owner merge succeeds through ordinary executor without publication or native input', async t => {
  const f = await readyMergeFixture(t), before = writeCounts(f);
  await f.tick();
  assert.equal(f.store.get('operation', f.op.operationId).state, 'succeeded');
  assert.deepEqual(writeCounts(f), before);
  assert.equal(f.store.workflowDiagnostic(f.run.id), null);
});
for (const [name, alter] of [
  ['node ID', f => { f.state.pr.node_id = 'other-pr'; }],
  ['number', f => { f.state.pr.number++; }],
  ['marker', f => { f.state.pr.body = '<!-- labstride:other -->'; }],
  ['head repository', f => { f.state.pr.head.repo.node_id = 'other-repository'; }],
  ['base repository', f => { f.state.pr.base.repo.node_id = 'other-repository'; }],
  ['head branch', f => { f.state.pr.head.ref = 'other-branch'; }],
  ['base branch', f => { f.state.pr.base.ref = 'other-base'; }],
  ['head SHA', f => { f.state.report = { ...f.state.report, commitSha: 'f'.repeat(40) }; }],
  ['open merged state', f => { f.state.pr.state = 'open'; }],
]) test(`merged acknowledgement rejects mismatched ${name} before any remote write`, async t => {
  const f = await readyMergeFixture(t), before = writeCounts(f); alter(f);
  await assert.rejects(f.action.reconcile(f.op, f.op.operationId), /pull_request_conflict/);
  assert.equal(f.store.get('operation', f.op.operationId).state, 'running');
  assert.deepEqual(writeCounts(f), before);
});
test('closed unmerged PR cannot acknowledge the operation', async t => {
  const f = await readyMergeFixture(t), before = writeCounts(f); f.state.pr.merged = false;
  await assert.rejects(f.action.reconcile(f.op, f.op.operationId), /pull_request_conflict/);
  assert.deepEqual(writeCounts(f), before);
});
test('open unmerged PR retains normal accepted review workflow', async t => {
  const f = await readyMergeFixture(t), before = writeCounts(f); f.state.pr.merged = false; f.state.pr.state = 'open';
  assert.equal((await f.action.reconcile(f.op, f.op.operationId)).result.status, 'accepted');
  assert.deepEqual(writeCounts(f), before);
});
test('lost exact PR read cannot publish or acknowledge success', async t => {
  const f = await readyMergeFixture(t), before = writeCounts(f); f.state.readFailure = true;
  await assert.rejects(f.action.reconcile(f.op, f.op.operationId), /provider_unavailable/);
  assert.deepEqual(writeCounts(f), before);
  f.state.readFailure = false;
  assert.equal((await f.action.reconcile(f.op, f.op.operationId)).result.status, 'succeeded');
  assert.deepEqual(writeCounts(f), before);
});
test('missing durable original PR acknowledgement never claims merged success', async t => {
  const f = await readyMergeFixture(t), before = writeCounts(f);
  const original = f.store.readManagedEffect.bind(f.store);
  f.store.readManagedEffect = (id, name) => name === 'pull-request-create' ? null : original(id, name);
  await assert.rejects(f.action.reconcile(f.op, f.op.operationId), /pull_request_conflict/);
  assert.deepEqual(writeCounts(f), before);
});
test('a new native turn observed during merge confirmation prevents completion', async t => {
  const f = await readyMergeFixture(t), before = writeCounts(f);
  const original = f.store.readManagedEffect.bind(f.store);
  f.store.readManagedEffect = (id, name) => {
    const value = original(id,name);
    if (name === 'pull-request-create') f.state.latest = { id: 'new-human-turn', status: 'inProgress' };
    return value;
  };
  await assert.rejects(f.action.reconcile(f.op, f.op.operationId), /stale_revision/);
  assert.deepEqual(writeCounts(f), before);
});

async function cancelFixture(f) {
  const run=f.store.get('run',f.run.id);
  f.store.cancelRun({schemaVersion:'1.0',id:'explicit-stop',runId:run.id,expectedRevision:run.revision,command:'cancel'},context,localAuthority);
  const controls=createControlWorker(f.store,{executorId:'stop',nextAttempt:()=>crypto.randomUUID(),adapters:new Map([[actionKey(f.op.actionId,f.op.actionVersion),f.action]])});
  await controls.tick(); await controls.drain();
}
for (const active of [false,true]) test(`explicit cancellation confirms native inactivity and retains original session; active=${active}`,async t=>{
  const f=await setup(t); for(let i=0;i<8&&!f.state.turns;i++)await f.tick();
  const original=f.store.managedSession(f.run.id), before=writeCounts(f);
  if(active)f.state.latest.status='inProgress';
  await cancelFixture(f); await f.tick();
  assert.equal(f.store.get('run',f.run.id).state,'cancelled');
  assert.equal(f.store.get('operation',f.op.operationId).state,'cancelled');
  assert.equal(f.store.workspace(f.run.id).keep,true);
  assert.deepEqual(f.store.managedSession(f.run.id),original); assert.deepEqual(writeCounts(f),before);
  assert.equal(f.state.interrupts??0,active?1:0);
  await f.tick(); assert.equal(f.state.interrupts??0,active?1:0);
});
for(const unknown of ['publication','interrupt']) test(`idle cancellation retains uncertain ${unknown} and never replays it`,async t=>{
  const f=await setup(t); for(let i=0;i<8&&!f.state.turns;i++)await f.tick();
  if(unknown==='publication')f.store.beginManagedEffect(f.op.operationId,'uncertain-publication',{requestDigest:'retained'});
  else {f.state.latest.status='inProgress';f.state.interruptLoss=true;}
  const before=writeCounts(f); await cancelFixture(f); await f.tick(); await f.tick();
  assert.notEqual(f.store.get('run',f.run.id).state,'cancelled');
  assert.equal(f.store.unresolvedManagedEffects(f.op.operationId).length,1);
  assert.deepEqual(writeCounts(f),before); assert.equal(f.state.interrupts??0,unknown==='interrupt'?1:0);
});

test('read-only status and runs explain identify unknown effects without task data or writes',async t=>{
  const f=await setup(t,{loseStartReply:true}); for(let i=0;i<8&&!f.state.starts;i++)await f.tick();
  const spec=JSON.parse(readFileSync(new URL('../examples/operational-installation.json',import.meta.url)));
  Object.assign(spec,{stateDirectory:f.root,configuration:f.compiled.snapshot.configuration});
  const path=join(f.root,'explain.json');writeFileSync(path,JSON.stringify(spec),{mode:0o600});
  const output=[],before=writeCounts(f);
  await cli(['status','--json','--config',path],value=>output.push(value));
  await cli(['runs','explain',f.run.id,'--json','--config',path],value=>output.push(value));
  assert.deepEqual(output[0].unknownEffects,[{runId:f.run.id,operationId:f.op.operationId,effect:'thread-start'}]);
  assert.equal(output[1].code,'outcome_unknown');assert.match(output[1].nextStep,/do not replay/);
  assert.equal(JSON.stringify(output).includes('Task data'),false);assert.deepEqual(writeCounts(f),before);
});

test('runs explain distinguishes the last observed plan approval wait from frozen startup mode',async t=>{
  const f=await setup(t);for(let i=0;i<8&&!f.state.turns;i++)await f.tick();await f.tick();
  const {explainRun}=await import('../packages/operations/inspection.ts');
  const waiting=explainRun(f.store,f.run.id);
  assert.equal(waiting.workflowPhase,'waiting-accept');assert.equal(waiting.code,'waiting_acceptance');
  assert.match(waiting.nextStep,/registered session/);assert.equal(f.state.turns,1);
  f.state.latest={id:'human-approved-work',status:'inProgress'};await f.tick();
  const working=explainRun(f.store,f.run.id);
  assert.equal(working.workflowPhase,'working');assert.equal(working.blockers.includes('waiting_acceptance'),false);
  assert.equal(working.status.startup[0].mode,'plan');assert.equal(f.state.turns,1);
});

test('cancellation never treats an unknown native state as stable inactivity',async t=>{
  const f=await setup(t);for(let i=0;i<8&&!f.state.turns;i++)await f.tick();
  f.state.cleanupState='unknown';await cancelFixture(f);await f.tick();
  assert.notEqual(f.store.get('run',f.run.id).state,'cancelled');assert.equal(f.state.interrupts??0,0);
});
