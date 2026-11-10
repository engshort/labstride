import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBridge } from '../packages/operations/bridge.ts';
import { workspaceFixture } from './helpers/workspace-fixture.mjs';
import { WorkspaceRegistry } from '../packages/target-helper/workspaces.ts';
import { digest } from '../packages/configuration/json.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReportJournal } from '../packages/operations/report-journal.ts';
import { UnixRpc } from '../packages/session-codex/index.mjs';
import { socketServer } from './helpers/codex-socket.mjs';

async function fixture(t) {
  const f = workspaceFixture(t), registry = new WorkspaceRegistry(f.policy, f.dependencies); t.after(() => registry.close());
  const response = await registry.handle(f.request), receipt = response.workspace;
  assert.equal(response.outcome, 'ok');
  const binding = { runId: receipt.runId, workspaceId: receipt.workspaceId, path: f.sourcePath(receipt), receiptDigest: digest(receipt) };
  const requests = [], frames = [], state = { latest: null, items: [], version: '0.163.0', cwd: binding.path, historyMode: 'legacy', source: 'cli', threadId: 'managed-thread' };
  const rpc = { onNotification() {}, onDisconnect() {}, notify() {}, frame(_opcode, bytes) { frames.push(JSON.parse(bytes.toString())); }, close() {}, async call(method, params) {
    requests.push({ method, params });
    if (method === 'initialize') return { userAgent: `codex/${state.version} linux` };
    if (method === 'model/list') return { data: [{ model: 'test-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
    if (method === 'thread/start' || method === 'thread/read' || method === 'thread/resume') return { thread: { id: state.threadId, cwd: state.cwd, source: state.source, historyMode: state.historyMode, name: state.name ?? null, preview: '', status: { type: state.latest?.status === 'inProgress' ? 'active' : 'idle' } } };
    if (method === 'thread/turns/list' && state.historyError) {
      if (state.activityDuringHistory) rpc.onNotification({ method: 'item/started', params: { threadId: 'managed-thread' } });
      throw Object.assign(new Error('rpc_rejected'), { rpcError: state.historyError });
    }
    if (method === 'thread/turns/list') return { data: state.latest ? [{ ...state.latest, ...(params.itemsView === 'full' ? { itemsView: 'full', items: state.items.filter(x => x.turnId === state.latest.id).map(x => x.item) } : {}) }] : [] };
    if (method === 'thread/name/set') { state.name = params.name; return {}; }
    if (method === 'turn/start') { state.latest = { id: 'initial-turn', status: 'inProgress' }; return { turn: state.latest }; }
    if (method === 'thread/items/list') return { data: state.items, nextCursor: null };
    if (method === 'turn/interrupt') { state.latest.status = 'interrupted'; return {}; }
    throw Error('unexpected_method');
  } };
  const policy = { schemaVersion: '1.0', socket: join(f.root, 'bridge.sock'), backendSocket: join(f.root, 'backend.sock'), backendVersion: '0.163.0',
    sourceRoot: f.policy.roots[0].path, helperUid: process.getuid(), stateDirectory: f.root };
  const bridge = createCodexBridge(policy, rpc);
  t.after(() => bridge.close());
  return { ...f, receipt, binding, requests, frames, state, bridge, rpc, policy };
}

test('managed bridge validates original filesystem receipt and starts one configured native thread', async t => {
  const f = await fixture(t);
  const started = await f.bridge.call({ schemaVersion: '1.0', method: 'start', binding: f.binding, parameters: { model: 'test-model' } });
  assert.equal(started.thread.id, 'managed-thread');
  const request = f.requests.find(request => request.method === 'thread/start');
  assert.equal(request.params.historyMode, 'legacy');
  assert.equal(request.params.allowProviderModelFallback, false); assert.equal(request.params.sandbox, 'workspace-write');
  assert.equal(request.params.dynamicTools[0].name, 'labstride_report');
  await assert.rejects(f.bridge.call({ schemaVersion: '1.0', method: 'start', binding: { ...f.binding, receiptDigest: '0'.repeat(64) }, parameters: { model: 'test-model' } }), /identity_mismatch/);
  assert.equal(f.requests.filter(request => request.method === 'thread/start').length, 1);
});

test('checked initial delivery preserves native Plan mode and refuses later automatic instructions', async t => {
  const f = await fixture(t);
  const request = { schemaVersion: '1.0', method: 'turn', binding: f.binding, sessionId: 'managed-thread', parameters: { expectedTurnId: null, prompt: 'Task data', model: 'test-model', reasoning: 'medium', mode: 'plan' } };
  await f.bridge.call(request);
  assert.deepEqual(f.requests.find(request => request.method === 'turn/start').params.collaborationMode, { mode: 'plan', settings: { model: 'test-model', reasoning_effort: 'medium', developer_instructions: null } });
  f.state.latest = { id: 'human-turn', status: 'completed' };
  await assert.rejects(f.bridge.call(request), /stale_revision/);
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1);
  await f.bridge.call({ schemaVersion: '1.0', method: 'observe', binding: f.binding, sessionId: 'managed-thread' });
  assert.deepEqual(f.requests.find(request => request.method === 'thread/resume').params, { threadId: 'managed-thread', excludeTurns: true });
});

test('only a completed native main-thread report in the latest completed turn is returned', async t => {
  const f = await fixture(t); f.state.latest = { id: 'human-approved-work', status: 'completed' };
  const report = { schemaVersion: '1.0', status: 'ready', commitSha: 'a'.repeat(40), summary: 'Done', prTitle: 'Implement task', prBody: 'Actual validation evidence', issueComplete: true };
  const item = { type: 'dynamicToolCall', id: 'call-1', tool: 'labstride_report', status: 'completed', success: true, arguments: report };
  f.state.items = [{ turnId: 'older-turn', item }, { turnId: f.state.latest.id, item }];
  const observed = await f.bridge.call({ schemaVersion: '1.0', method: 'observe', binding: f.binding, sessionId: 'managed-thread' });
  assert.equal(observed.report.turnId, f.state.latest.id); assert.equal(observed.report.runId, f.binding.runId);
  f.state.items = [{ turnId: f.state.latest.id, item: { ...item, success: false } }];
  assert.equal((await f.bridge.call({ schemaVersion: '1.0', method: 'observe', binding: f.binding, sessionId: 'managed-thread' })).report, null);
  f.state.latest.status = 'inProgress'; f.state.items[0].item.success = true;
  assert.equal((await f.bridge.call({ schemaVersion: '1.0', method: 'observe', binding: f.binding, sessionId: 'managed-thread' })).report, null);
});

test('backend mismatch and foreign session paths fail before native mutation', async t => {
  const f = await fixture(t); f.state.version = '0.157.1';
  await assert.rejects(f.bridge.call({ schemaVersion: '1.0', method: 'start', binding: f.binding, parameters: { model: 'test-model' } }), /backend_version_mismatch/);
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
});

test('real shallow workspace commits export a credential-free bundle without executing source hooks in the coordinator', async t => {
  const f = await fixture(t), git = args => execFileSync('/usr/bin/git', ['-c', `safe.directory=${f.binding.path}`, '-c', 'core.hooksPath=/dev/null', ...args], { cwd: f.binding.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  writeFileSync(join(f.binding.path, 'new.txt'), 'implemented\n'); git(['add', 'new.txt']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Implement bounded task']);
  const sha = git(['rev-parse', 'HEAD']);
  const exported = await f.bridge.call({ schemaVersion: '1.0', method: 'bundle', binding: f.binding, parameters: { sha } });
  const temp = mkdtempSync(join(tmpdir(), 'labstride-bundle-verify-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(join(temp, 'source.bundle'), Buffer.from(exported.bundle, 'base64'));
  const bare = join(temp, 'objects.git'); execFileSync('/usr/bin/git', ['init', '--bare', '--template=', bare], { stdio: 'ignore' });
  execFileSync('/usr/bin/git', ['bundle', 'verify', join(temp, 'source.bundle')], { cwd: bare, stdio: 'ignore' });
  execFileSync('/usr/bin/git', ['fetch', join(temp, 'source.bundle'), 'HEAD'], { cwd: bare, stdio: 'ignore' });
  assert.equal(execFileSync('/usr/bin/git', ['rev-parse', 'FETCH_HEAD'], { cwd: bare, encoding: 'utf8' }).trim(), sha);
  writeFileSync(join(f.binding.path, 'dirty.txt'), 'preserved');
  await assert.rejects(f.bridge.call({ schemaVersion: '1.0', method: 'bundle', binding: f.binding, parameters: { sha } }), /checkout_not_publishable/);
});

const initial = f => ({ schemaVersion: '1.0', method: 'turn', binding: f.binding, sessionId: 'managed-thread', parameters: { expectedTurnId: null, prompt: 'Task data', model: 'test-model', reasoning: 'medium', mode: 'plan' } });
const unmaterialized = { code: -32600, message: 'thread managed-thread is not materialized yet; thread/turns/list is unavailable before first user message' };

const resultReport = () => ({ schemaVersion: '1.0', status: 'ready', commitSha: 'a'.repeat(40), summary: 'Done', prTitle: 'Implement task', prBody: 'Actual validation evidence', issueComplete: true });
const observeRequest = f => ({ schemaVersion: '1.0', method: 'observe', binding: f.binding, sessionId: 'managed-thread' });
const notifyReport = (f, arguments_ = resultReport(), callId = 'report-call') => f.rpc.onNotification({
  id: 73, method: 'item/tool/call', params: { threadId: 'managed-thread', turnId: f.state.latest.id, callId, tool: 'labstride_report', arguments: arguments_ },
});

test('native report is committed before acknowledgement even when legacy history omits dynamic tools', async t => {
  const f = await fixture(t); await f.bridge.call(observeRequest(f));
  f.state.latest = { id: 'implementation-turn', status: 'inProgress' };
  const frame = f.rpc.frame;
  f.rpc.frame = (...args) => {
    const independent = new ReportJournal(f.root);
    try { assert.equal(independent.read(f.binding, 'managed-thread', 'implementation-turn').commitSha, resultReport().commitSha); }
    finally { independent.close(); }
    frame(...args);
  };
  notifyReport(f);
  assert.equal(f.frames[0].result.success, true);
  assert.equal((await f.bridge.call(observeRequest(f))).report, null);
  f.state.latest.status = 'completed';
  assert.deepEqual((await f.bridge.call(observeRequest(f))).report, { ...resultReport(), runId: f.binding.runId, sessionId: 'managed-thread', turnId: 'implementation-turn' });
  // The actual daemon history observed in this canary contains no tool item.
  assert.deepEqual(f.state.items, []);
  f.bridge.close();
  const restarted = createCodexBridge(f.policy, f.rpc); t.after(() => restarted.close());
  assert.equal((await restarted.call(observeRequest(f))).report.commitSha, resultReport().commitSha);
  f.state.latest = { id: 'later-human-turn', status: 'completed' };
  assert.equal((await restarted.call(observeRequest(f))).report, null);
});

test('duplicate native requests are idempotent and conflicting successful reports block publication', async t => {
  const f = await fixture(t); await f.bridge.call(observeRequest(f));
  f.state.latest = { id: 'implementation-turn', status: 'inProgress' };
  notifyReport(f); notifyReport(f);
  assert(f.frames.every(frame => frame.result.success));
  notifyReport(f, { ...resultReport(), commitSha: 'b'.repeat(40) }, 'second-report-call');
  f.state.latest.status = 'completed';
  await assert.rejects(f.bridge.call(observeRequest(f)), /report_conflict/);
});

test('invalid reports and journal failures never receive successful acknowledgement', async t => {
  const f = await fixture(t); await f.bridge.call(observeRequest(f));
  f.state.latest = { id: 'implementation-turn', status: 'inProgress' };
  notifyReport(f, { ...resultReport(), commitSha: 'main' });
  assert.equal(f.frames.at(-1).result.success, false);
  notifyReport(f, resultReport(), null);
  assert.equal(f.frames.at(-1).result.success, false);
  f.bridge.close();
  notifyReport(f);
  assert.equal(f.frames.at(-1).result.success, false);
});

test('a journaled report rejects a changed latest turn, incomplete status or missing confirmation', async t => {
  for (const change of ['turn', 'inProgress', 'interrupted', 'failed', 'missing', 'unavailable']) {
    const f = await fixture(t); await f.bridge.call(observeRequest(f));
    f.state.latest = { id: 'implementation-turn', status: 'inProgress' };
    notifyReport(f); f.state.latest.status = 'completed';
    const original = f.rpc.call; let summaries = 0;
    f.rpc.call = async (method, params) => {
      const value = await original(method, params);
      if (method === 'thread/turns/list' && params.itemsView === 'summary' && ++summaries === 2) {
        if (change === 'turn') value.data[0].id = 'changed-turn';
        else if (change === 'missing') value.data = [];
        else if (change === 'unavailable') throw Error('outcome_unknown');
        else value.data[0].status = change;
      }
      return value;
    };
    await assert.rejects(f.bridge.call(observeRequest(f)), /stale_revision|outcome_unknown/);
  }
});

test('journaled reports survive an oversized native transcript through the real bounded WebSocket transport', async t => {
  const f = await fixture(t); await f.bridge.call(observeRequest(f));
  f.state.latest = { id: 'large-turn', status: 'inProgress' };
  notifyReport(f); assert.equal(f.frames.at(-1).result.success, true);
  f.state.latest.status = 'completed';
  const item = { type: 'agentMessage', text: 'x'.repeat(300000) };
  f.state.items = [{ turnId: f.state.latest.id, item }];
  f.bridge.close();
  const server = await socketServer(f.policy.backendSocket, async (request, { socket }) => {
    if (!Object.hasOwn(request, 'id')) return;
    const value = await f.rpc.call(request.method, request.params);
    if (request.params?.itemsView === 'full') {
      // Send a valid 64-bit-length WebSocket frame, larger than the production
      // client's unchanged 256 KiB bound. No large payload is mocked as success.
      const payload = Buffer.from(JSON.stringify({ id: request.id, result: value }));
      assert(payload.length > 262144);
      const header = Buffer.alloc(10); header[0] = 129; header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2); socket.write(Buffer.concat([header, payload])); return;
    }
    return value;
  });
  t.after(() => server.close());
  const rpc = new UnixRpc(f.policy.backendSocket, 1000), bridge = createCodexBridge(f.policy, rpc);
  t.after(() => bridge.close());
  const observed = await bridge.call(observeRequest(f));
  assert.equal(observed.report.commitSha, resultReport().commitSha);
  assert.equal(server.requests.filter(r => r.params?.itemsView === 'full').length, 0);
  assert.equal(server.requests.filter(r => r.params?.itemsView === 'summary').length, 2);
  // A later conversation neither reuses the earlier report nor loads its large
  // transcript. Normal questions must not exhaust the read-recovery budget.
  f.state.latest = { id: 'unjournaled-turn', status: 'completed' };
  f.state.items = [{ turnId: f.state.latest.id, item }];
  assert.equal((await bridge.call(observeRequest(f))).report, null);
  assert.equal(server.requests.filter(r => r.params?.itemsView === 'full').length, 0);
  // The transport limit itself remains enforced, including on legacy recovery.
  await assert.rejects(rpc.call('thread/turns/list', { threadId: 'managed-thread', limit: 1, sortDirection: 'desc', itemsView: 'full' }), /outcome_unknown/);
});

test('a witnessed newly created legacy thread accepts one initial turn before rollout materialization', async t => {
  const f = await fixture(t);
  await f.bridge.call({ schemaVersion: '1.0', method: 'start', binding: f.binding, parameters: { model: 'test-model' } });
  f.rpc.onNotification({ method: 'mcpServer/startupStatus/updated', params: { threadId: 'managed-thread', status: 'starting' } });
  f.rpc.onNotification({ method: 'thread/readState/changed', params: { threadId: 'managed-thread' } });
  f.state.historyError = unmaterialized;
  await f.bridge.call(initial(f));
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  await assert.rejects(f.bridge.call(initial(f)), /rpc_rejected/);
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
});

test('unavailable history is never empty without a fresh creation witness, after disconnect or during human activity', async t => {
  for (const scenario of ['existing', 'disconnected', 'human', 'settings', 'queue']) {
    const f = await fixture(t);
    if (scenario !== 'existing') await f.bridge.call({ schemaVersion: '1.0', method: 'start', binding: f.binding, parameters: { model: 'test-model' } });
    if (scenario === 'disconnected') f.rpc.onDisconnect();
    if (scenario === 'settings' || scenario === 'queue') f.rpc.onNotification({ method: scenario === 'settings' ? 'thread/settings/updated' : 'thread/queue/changed', params: { threadId: 'managed-thread' } });
    f.state.historyError = unmaterialized;
    if (scenario === 'human') f.state.activityDuringHistory = true;
    await assert.rejects(f.bridge.call(initial(f)), /rpc_rejected|stale_revision/);
    assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
  }
});

test('missing methods, generic history errors and foreign unmaterialized IDs never permit initial delivery', async t => {
  for (const error of [{ code: -32601, message: 'list_turns is not supported yet' }, { code: -32600, message: 'unavailable' }, { ...unmaterialized, message: unmaterialized.message.replace('managed-thread', 'foreign-thread') }]) {
    const f = await fixture(t);
    await f.bridge.call({ schemaVersion: '1.0', method: 'start', binding: f.binding, parameters: { model: 'test-model' } });
    f.state.historyError = error;
    await assert.rejects(f.bridge.call(initial(f)), /rpc_rejected/);
    assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
  }
});

test('a creation-time human event remains disqualifying when observation capacity overflows', async t => {
  const f = await fixture(t), original = f.rpc.call;
  f.rpc.call = async (method, parameters) => {
    if (method === 'thread/start') {
      f.rpc.onNotification({ method: 'turn/started', params: { threadId: 'managed-thread' } });
      for (let i = 0; i < 4096; i++) f.rpc.onNotification({ method: 'turn/started', params: { threadId: `other-${i}` } });
    }
    return original(method, parameters);
  };
  await f.bridge.call({ schemaVersion: '1.0', method: 'start', binding: f.binding, parameters: { model: 'test-model' } });
  f.state.historyError = unmaterialized;
  await assert.rejects(f.bridge.call(initial(f)), /rpc_rejected/);
  assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
});

test('a changed latest turn or an incomplete full-view reply cannot supply a report', async t => {
  for (const change of ['turn', 'view']) {
    const f = await fixture(t); f.state.latest = { id: 'completed-turn', status: 'completed' };
    const original = f.rpc.call;
    f.rpc.call = async (method, params) => {
      const value = await original(method, params);
      if (method === 'thread/turns/list' && params.itemsView === 'full') {
        if (change === 'turn') value.data[0].id = 'later-human-turn';
        else value.data[0].itemsView = 'summary';
      }
      return value;
    };
    await assert.rejects(f.bridge.call({ schemaVersion: '1.0', method: 'observe', binding: f.binding, sessionId: 'managed-thread' }), /stale_revision/);
  }
});

test('cleanup observes native sessions without resume, turn, interrupt, or transcript recovery',async t=>{
  const f=await fixture(t);f.state.latest={id:'completed-work',status:'completed'};
  const request={schemaVersion:'1.0',method:'cleanup-observe',binding:f.binding,sessionId:'managed-thread'};
  const observed=await f.bridge.call(request);assert.equal(observed.state,'idle');assert.equal(observed.lastTurnId,'completed-work');
  assert.equal(f.requests.some(r=>['thread/resume','turn/start','turn/interrupt'].includes(r.method)),false);
  assert.equal(f.requests.some(r=>r.params?.itemsView==='full'),false);
  f.state.latest.status='inProgress';assert.equal((await f.bridge.call(request)).state,'active');
  f.state.historyError={code:-32600,message:'history unavailable'};await assert.rejects(f.bridge.call(request));
});

// Existing-session history compatibility and native metadata recovery.
const cleanupRequest = f => ({ ...observeRequest(f), method: 'cleanup-observe' });
const noForwardEffects = f => assert.equal(f.requests.some(r => ['thread/start', 'turn/start', 'turn/interrupt', 'item/tool/requestUserInput/respond'].includes(r.method)), false);

for (const historyMode of ['legacy', 'paginated']) {
  test(`${historyMode}: completed plan observation and cleanup preserve human acceptance`, async t => {
    const f = await fixture(t); f.state.historyMode = historyMode;
    f.state.latest = { id: 'owner-unapproved-plan', status: 'completed' };
    f.state.items = [{ turnId: f.state.latest.id, item: { type: 'plan', text: 'Wait for the owner.' } }];
    const observed = await f.bridge.call(observeRequest(f));
    assert.equal(observed.report, null); assert.equal(observed.turn.id, f.state.latest.id);
    assert.deepEqual(f.requests.find(r => r.method === 'thread/resume').params, { threadId: 'managed-thread', excludeTurns: true });
    const mark = f.requests.length;
    assert.equal((await f.bridge.call(cleanupRequest(f))).state, 'idle');
    assert(f.requests.slice(mark).every(r => ['thread/read', 'thread/turns/list'].includes(r.method)));
    noForwardEffects(f);
    f.bridge.close();
    const restarted = createCodexBridge(f.policy, f.rpc); t.after(() => restarted.close());
    assert.equal((await restarted.call(observeRequest(f))).report, null);
    assert.equal((await restarted.call(cleanupRequest(f))).lastTurnId, 'owner-unapproved-plan');
    noForwardEffects(f);
  });
}

for (const historyMode of [undefined, null, '', 'unknown', 'legacy ', 'PAGINATED', 'future-format']) {
  for (const method of ['observe', 'cleanup-observe']) {
    test(`${method}: reject unsupported history mode ${JSON.stringify(historyMode)}`, async t => {
      const f = await fixture(t); f.state.historyMode = historyMode;
      f.state.latest = { id: 'plan', status: 'completed' };
      await assert.rejects(f.bridge.call({ ...observeRequest(f), method }), /identity_mismatch/);
      assert.equal(f.requests.some(r => ['thread/turns/list', 'thread/resume'].includes(r.method)), false);
      noForwardEffects(f);
    });
  }
}

for (const method of ['observe', 'cleanup-observe']) {
  for (const invalid of ['threadId', 'cwd', 'subAgent', 'receiptDigest', 'workspaceId']) {
    test(`paginated ${method}: reject foreign ${invalid}`, async t => {
      const f = await fixture(t); f.state.historyMode = 'paginated';
      const request = { ...observeRequest(f), method };
      if (invalid === 'threadId') f.state.threadId = 'foreign-thread';
      if (invalid === 'cwd') f.state.cwd = '/foreign/checkout';
      if (invalid === 'subAgent') f.state.source = { subAgent: { parentThreadId: 'foreign' } };
      if (invalid === 'receiptDigest') request.binding = { ...f.binding, receiptDigest: '0'.repeat(64) };
      if (invalid === 'workspaceId') request.binding = { ...f.binding, workspaceId: 'foreign-workspace' };
      await assert.rejects(f.bridge.call(request), /identity_mismatch/);
      assert.equal(f.requests.some(r => r.method === 'thread/resume'), false);
      noForwardEffects(f);
    });
  }
}

for (const change of ['turn', 'activity']) {
  test(`paginated cleanup double read rejects changed ${change}`, async t => {
    const f = await fixture(t); f.state.historyMode = 'paginated';
    f.state.latest = { id: 'original-turn', status: 'completed' };
    const call = f.rpc.call; let reads = 0;
    f.rpc.call = async (method, params) => {
      if (method === 'thread/turns/list' && ++reads === 2) {
        if (change === 'turn') f.state.latest = { id: 'new-human-turn', status: 'completed' };
        else f.state.latest.status = 'inProgress';
      }
      return call(method, params);
    };
    await assert.rejects(f.bridge.call(cleanupRequest(f)), /stale_revision/);
    noForwardEffects(f);
  });
}

for (const change of ['turn', 'status', 'summaryInsteadOfFull', 'missingItems']) {
  test(`paginated history-only report rejects ${change}`, async t => {
    const f = await fixture(t); f.state.historyMode = 'paginated';
    f.state.latest = { id: 'reported-turn', status: 'completed' };
    const report = resultReport();
    f.state.items = [{ turnId: 'reported-turn', item: { type: 'dynamicToolCall', tool: 'labstride_report', status: 'completed', success: true, arguments: report } }];
    const call = f.rpc.call;
    f.rpc.call = async (method, params) => {
      const value = await call(method, params);
      if (method === 'thread/turns/list' && params.itemsView === 'full') {
        if (change === 'turn') value.data[0].id = 'foreign-turn';
        if (change === 'status') value.data[0].status = 'inProgress';
        if (change === 'summaryInsteadOfFull') value.data[0].itemsView = 'summary';
        if (change === 'missingItems') delete value.data[0].items;
      }
      return value;
    };
    await assert.rejects(f.bridge.call(observeRequest(f)), /stale_revision/);
    noForwardEffects(f);
  });
}

test('paginated journal receipt survives bridge restart without transcript hydration or approval', async t => {
  const f = await fixture(t); f.state.historyMode = 'paginated';
  await f.bridge.call(observeRequest(f));
  f.state.latest = { id: 'reported-work', status: 'inProgress' };
  notifyReport(f); assert.equal(f.frames.at(-1).result.success, true);
  f.state.latest.status = 'completed';
  f.bridge.close();
  const restarted = createCodexBridge(f.policy, f.rpc); t.after(() => restarted.close());
  const start = f.requests.length;
  assert.equal((await restarted.call(observeRequest(f))).report.turnId, 'reported-work');
  assert.equal(f.requests.slice(start).some(r => r.params?.itemsView === 'full'), false);
  f.state.latest = { id: 'unapproved-new-plan', status: 'completed' };
  assert.equal((await restarted.call(observeRequest(f))).report, null);
  noForwardEffects(f);
});

for (const change of ['newTurn', 'inProgress', 'missing']) {
  test(`paginated journal confirmation rejects ${change}`, async t => {
    const f = await fixture(t); f.state.historyMode = 'paginated';
    await f.bridge.call(observeRequest(f));
    f.state.latest = { id: 'reported-work', status: 'inProgress' }; notifyReport(f);
    f.state.latest.status = 'completed';
    const call = f.rpc.call; let summaries = 0;
    f.rpc.call = async (method, params) => {
      const value = await call(method, params);
      if (method === 'thread/turns/list' && params.itemsView === 'summary' && ++summaries === 2) {
        if (change === 'newTurn') value.data[0].id = 'human-turn';
        if (change === 'inProgress') value.data[0].status = 'inProgress';
        if (change === 'missing') value.data = [];
      }
      return value;
    };
    await assert.rejects(f.bridge.call(observeRequest(f)), /stale_revision/);
    noForwardEffects(f);
  });
}

test('paginated history is not accepted for initial thread creation or automatic turn delivery', async t => {
  const f = await fixture(t); f.state.historyMode = 'paginated';
  await assert.rejects(f.bridge.call(initial(f)), /identity_mismatch/);
  assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
  await assert.rejects(f.bridge.call({ schemaVersion: '1.0', method: 'start', binding: f.binding, parameters: { model: 'test-model' } }), /identity_mismatch/);
  assert.equal(f.requests.find(r => r.method === 'thread/start').params.historyMode, 'legacy');
  assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
});

for (const scenario of ['unavailable', 'disconnected', 'foreignUnmaterialized']) {
  test(`paginated ${scenario} history never authorizes an initial turn after restart`, async t => {
    const f = await fixture(t); f.state.historyMode = 'paginated';
    f.state.historyError = scenario === 'foreignUnmaterialized'
      ? { ...unmaterialized, message: unmaterialized.message.replace('managed-thread', 'other') }
      : { code: -32600, message: 'history unavailable' };
    if (scenario === 'disconnected') f.rpc.onDisconnect();
    await assert.rejects(f.bridge.call(observeRequest(f)), /rpc_rejected/);
    await assert.rejects(f.bridge.call(cleanupRequest(f)), /rpc_rejected/);
    await assert.rejects(f.bridge.call(initial(f)), /identity_mismatch/);
    noForwardEffects(f);
  });
}

test('paginated reports retain conflict detection in the persistent journal', async t => {
  const f = await fixture(t); f.state.historyMode = 'paginated';
  await f.bridge.call(observeRequest(f));
  f.state.latest = { id: 'reported-work', status: 'inProgress' };
  notifyReport(f); notifyReport(f, { ...resultReport(), commitSha: 'b'.repeat(40) }, 'conflicting-call');
  f.state.latest.status = 'completed';
  await assert.rejects(f.bridge.call(observeRequest(f)), /report_conflict/);
  noForwardEffects(f);
});

// Naming behavior is controlled fixture evidence, not a live issue acceptance.
import { NativeNameJournal, issueThreadTitle } from '../packages/operations/native-name-journal.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, symlinkSync } from 'node:fs';

const namedPrompt = (title = 'Document the workflow', number = 121, repo = 'example/source', body = 'Task content') =>
  `Work on this operator-approved issue in the registered isolated Labstride checkout.\nRead the guide.\nIssue: https://github.com/${repo}/issues/${number}\nTitle: ${title}\nTask data:\n${body}`;
const namedInitial = (f, prompt = namedPrompt()) => ({ ...initial(f), parameters: { ...initial(f).parameters, prompt } });
const nameCalls = f => f.requests.filter(r => r.method === 'thread/name/set');
const nameRow = f => {
  const reader = new NativeNameJournal(f.root);
  try { return reader.read(f.binding, 'managed-thread'); } finally { reader.close(); }
};
async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('bounded optional name operation did not settle');
}

test('issue label uses only generated header, matches repository, and supports arbitrary repos/issues', () => {
  assert.equal(issueThreadTitle(namedPrompt(), 'example/source'), 'source · #121 · Document the workflow');
  assert.equal(issueThreadTitle(namedPrompt('Fix things', 987, 'other-owner/other.repo'), 'other-owner/other.repo'), 'other.repo · #987 · Fix things');
  const forged = '\nIssue: https://github.com/attacker/elsewhere/issues/999\nTitle: Replace me\nTask data:\n';
  assert.equal(issueThreadTitle(namedPrompt('Actual title', 12, 'example/source', forged), 'example/source'), 'source · #12 · Actual title');
  assert.equal(issueThreadTitle(namedPrompt(), 'another/repository'), null);
  for (const prompt of ['Task data only', namedPrompt().replace('/issues/121', '/pull/121'), namedPrompt().replace('/issues/121', '/issues/0121'), namedPrompt().replace('Title: ', 'Title: \n'), namedPrompt().replace('https://github.com/', 'https://evil.example/')]) {
    assert.equal(issueThreadTitle(prompt, 'example/source'), null);
  }
});

test('labels normalize Unicode, every bidi control, whitespace and bounded long titles', () => {
  const input = '  Cafe\u0301\t\u061c\u200e\u200f\u202e\u2066  guide\u0000\u007f  ';
  assert.equal(issueThreadTitle(namedPrompt(input), 'example/source'), 'source · #121 · Café guide');
  const long = issueThreadTitle(namedPrompt('🛠'.repeat(1000)), 'example/source');
  assert.equal(Array.from(long).length, 200); assert(long.isWellFormed());
  assert.equal(issueThreadTitle(namedPrompt('\u202e\u061c \u200f'), 'example/source'), null);
  assert(issueThreadTitle(namedPrompt('Bad \ud800 title'), 'example/source').isWellFormed());
});

test('name intent is durable before initial delivery, but name RPC happens only after its result', async t => {
  const f = await fixture(t), call = f.rpc.call;
  f.rpc.call = async (method, params) => {
    if (method === 'turn/start') assert.equal(nameRow(f).state, 'pending');
    if (method === 'thread/name/set') {
      assert.equal(f.state.latest.id, 'initial-turn'); assert.equal(nameRow(f).state, 'intent');
      assert.deepEqual(params, { threadId: 'managed-thread', name: 'source · #121 · Document the workflow' });
    }
    return call(method, params);
  };
  assert.equal((await f.bridge.call(namedInitial(f))).turn.id, 'initial-turn');
  await eventually(() => nameRow(f)?.state === 'applied');
  assert.equal(nameCalls(f).length, 1);
  assert(f.requests.findIndex(r => r.method === 'thread/name/set') > f.requests.findIndex(r => r.method === 'turn/start'));
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
});

test('a missing or mismatched generated header never affects task delivery or names', async t => {
  for (const prompt of ['Task data', namedPrompt('Unrelated', 12, 'foreign/source')]) {
    const f = await fixture(t);
    assert.equal((await f.bridge.call(namedInitial(f, prompt))).turn.id, 'initial-turn');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(nameCalls(f).length, 0); assert.equal(nameRow(f), null);
  }
});

test('existing manual name is preserved and later manual changes are never overwritten', async t => {
  const f = await fixture(t); f.state.name = 'Owner chose this title';
  await f.bridge.call(namedInitial(f));
  await eventually(() => nameRow(f)?.state === 'preserved');
  assert.equal(nameCalls(f).length, 0);
  f.state.name = 'Later owner title';
  await f.bridge.call(observeRequest(f));
  assert.equal(nameCalls(f).length, 0); assert.equal(f.state.name, 'Later owner title');
  const g = await fixture(t); await g.bridge.call(namedInitial(g));
  await eventually(() => nameRow(g)?.state === 'applied');
  g.state.name = 'Renamed after auto label';
  await g.bridge.call(observeRequest(g));
  assert.equal(nameCalls(g).length, 1); assert.equal(g.state.name, 'Renamed after auto label');
});

test('missing optional name metadata is unknown, not a blank writable name', async t => {
  const f = await fixture(t), call = f.rpc.call;
  f.rpc.call = async (method, params) => {
    const value = await call(method, params);
    if (method === 'thread/read') delete value.thread.name;
    return value;
  };
  assert.equal((await f.bridge.call(namedInitial(f))).turn.id, 'initial-turn');
  await eventually(() => nameRow(f)?.lastError === 'name_metadata_missing');
  assert.equal(nameCalls(f).length, 0);
});

test('failed name write cannot hide a successfully started native initial turn', async t => {
  const f = await fixture(t), call = f.rpc.call;
  f.rpc.call = async (method, params) => {
    if (method === 'thread/name/set') { f.requests.push({ method, params }); throw Error('outcome_unknown'); }
    return call(method, params);
  };
  assert.equal((await f.bridge.call(namedInitial(f))).turn.id, 'initial-turn');
  await eventually(() => nameRow(f)?.lastError === 'native_name_unavailable');
  assert.equal(nameRow(f).state, 'intent');
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  await assert.rejects(f.bridge.call(namedInitial(f)), /stale_revision/);
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
});

for (const applied of [true, false]) {
  test(`lost name acknowledgement is read-reconciled after restart; effect applied=${applied}`, async t => {
    const f = await fixture(t), call = f.rpc.call;
    f.rpc.call = async (method, params) => {
      if (method === 'thread/name/set') {
        f.requests.push({ method, params }); if (applied) f.state.name = params.name;
        throw Error('outcome_unknown');
      }
      return call(method, params);
    };
    await f.bridge.call(namedInitial(f));
    await eventually(() => nameRow(f)?.lastError === 'native_name_unavailable');
    f.bridge.close();
    const restarted = createCodexBridge(f.policy, f.rpc); t.after(() => restarted.close());
    await restarted.call(observeRequest(f));
    await eventually(() => applied ? nameRow(f)?.state === 'applied' : nameRow(f)?.lastError === 'name_effect_unknown');
    assert.equal(nameCalls(f).length, 1);
    assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
    assert.equal(f.requests.some(r => r.method === 'thread/start'), false);
  });
}

test('lost initial-turn reply preserves name proposal; later observe names without another turn', async t => {
  const f = await fixture(t), call = f.rpc.call; let lost = true;
  f.rpc.call = async (method, params) => {
    const value = await call(method, params);
    if (method === 'turn/start' && lost) { lost = false; throw Error('outcome_unknown'); }
    return value;
  };
  await assert.rejects(f.bridge.call(namedInitial(f)), /outcome_unknown/);
  assert.equal(f.state.latest.id, 'initial-turn'); assert.equal(nameRow(f).state, 'pending');
  assert.equal(nameCalls(f).length, 0);
  f.bridge.close(); const restarted = createCodexBridge(f.policy, f.rpc); t.after(() => restarted.close());
  await restarted.call(observeRequest(f));
  await eventually(() => nameRow(f)?.state === 'applied');
  assert.equal(nameCalls(f).length, 1);
  await assert.rejects(restarted.call(namedInitial(f)), /stale_revision/);
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
});

for (const invalid of ['cwd', 'threadId', 'subAgent', 'historyMode']) {
  test(`name reconciliation rejects changed ${invalid} without new metadata write`, async t => {
    const f = await fixture(t);
    const journal = new NativeNameJournal(f.root);
    journal.propose(f.binding, 'managed-thread', 'source · #121 · Pending title'); journal.close();
    if (invalid === 'cwd') f.state.cwd = '/foreign/path';
    if (invalid === 'threadId') f.state.threadId = 'foreign-thread';
    if (invalid === 'subAgent') f.state.source = { subAgent: {} };
    if (invalid === 'historyMode') f.state.historyMode = 'future';
    await assert.rejects(f.bridge.call(observeRequest(f)), /identity_mismatch/);
    assert.equal(nameCalls(f).length, 0);
  });
}

test('binding/session changes cannot borrow another registered naming proposal', async t => {
  const f = await fixture(t), journal = new NativeNameJournal(f.root); t.after(() => journal.close());
  journal.propose(f.binding, 'managed-thread', 'source · #1 · First');
  assert.equal(journal.read({ ...f.binding, receiptDigest: 'b'.repeat(64) }, 'managed-thread'), null);
  assert.equal(journal.read(f.binding, 'other-session'), null);
  assert.throws(() => journal.propose(f.binding, 'managed-thread', 'source · #2 · Different'), /name_intent_conflict/);
  assert.equal(journal.intent(f.binding, 'managed-thread'), true);
  assert.equal(journal.intent(f.binding, 'managed-thread'), false);
  assert.equal(journal.read(f.binding, 'managed-thread').title, 'source · #1 · First');
});

test('name intents survive actual writer SIGKILL without permission to resend', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {NativeNameJournal} from ${JSON.stringify(new URL('../packages/operations/native-name-journal.ts', import.meta.url).href)};
    const j=new NativeNameJournal(${JSON.stringify(f.root)});
    j.propose(${JSON.stringify(f.binding)},'managed-thread','source · #121 · Durable');
    j.intent(${JSON.stringify(f.binding)},'managed-thread');process.kill(process.pid,'SIGKILL');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(nameRow(f).state, 'intent');
  await f.bridge.call(observeRequest(f));
  await eventually(() => nameRow(f)?.lastError === 'name_effect_unknown');
  assert.equal(nameCalls(f).length, 0);
});

test('a denied optional metadata journal cannot prevent ordinary initial delivery', async t => {
  const f = await fixture(t); f.bridge.close();
  // An unrelated valid protected report directory is used, but its naming path
  // is intentionally unmanaged. It must be preserved rather than initialized.
  const other = join(f.root, 'another-report-state'); mkdirSync(other, { mode: 0o700 });
  const names = join(other, 'native-names'); mkdirSync(names, { mode: 0o700 });
  writeFileSync(join(names, 'names.sqlite'), 'UNMANAGED', { mode: 0o600 });
  const restarted = createCodexBridge({ ...f.policy, reportDirectory: other }, f.rpc); t.after(() => restarted.close());
  assert.equal((await restarted.call(namedInitial(f))).turn.id, 'initial-turn');
  assert.equal(readFileSync(join(names, 'names.sqlite'), 'utf8'), 'UNMANAGED');
  assert.equal(nameCalls(f).length, 0);
});

test('naming respects journaled completed reports and never supplies a human approval', async t => {
  const f = await fixture(t); await f.bridge.call(namedInitial(f));
  await eventually(() => nameRow(f)?.state === 'applied');
  f.state.latest = { id: 'actual-owner-approved-work', status: 'inProgress' }; notifyReport(f);
  f.state.latest.status = 'completed';
  const observed = await f.bridge.call(observeRequest(f));
  assert.equal(observed.report.turnId, 'actual-owner-approved-work');
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(f.requests.some(r => /approval|respond|steer/.test(r.method)), false);
});

test('paginated sessions can interrupt the exact active turn without initial input',async t=>{
  const f=await fixture(t);f.state.historyMode='paginated';f.state.latest={id:'active-work',status:'inProgress'};
  const result=await f.bridge.call({...observeRequest(f),method:'interrupt',parameters:{turnId:'active-work'}});
  assert.deepEqual(result,{interrupted:'active-work'});
  assert.equal(f.requests.filter(request=>request.method==='turn/interrupt').length,1);
  assert.equal(f.requests.some(request=>['thread/start','turn/start','thread/resume'].includes(request.method)),false);
});
