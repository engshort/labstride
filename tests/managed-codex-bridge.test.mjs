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
import { requestDigest } from '../packages/storage-sqlite/execution.ts';
import { UnixRpc } from '../packages/session-codex/index.mjs';
import { socketServer } from './helpers/codex-socket.mjs';

async function fixture(t) {
  const f = workspaceFixture(t), registry = new WorkspaceRegistry(f.policy, f.dependencies); t.after(() => registry.close());
  const response = await registry.handle(f.request), receipt = response.workspace;
  assert.equal(response.outcome, 'ok');
  const binding = { runId: receipt.runId, workspaceId: receipt.workspaceId, path: f.sourcePath(receipt), receiptDigest: digest(receipt) };
  const requests = [], frames = [], state = { latest: null, items: [], version: '0.163.0', cwd: binding.path };
  const rpc = { onNotification() {}, onDisconnect() {}, notify() {}, frame(_opcode, bytes) { frames.push(JSON.parse(bytes.toString())); }, close() {}, async call(method, params) {
    requests.push({ method, params });
    if (method === 'initialize') return { userAgent: `codex/${state.version} linux` };
    if (method === 'model/list') return { data: [{ model: 'test-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
    if (method === 'thread/start' || method === 'thread/read' || method === 'thread/resume') return { thread: { id: 'managed-thread', cwd: state.cwd, source: 'cli', historyMode: 'legacy', preview: '', status: { type: state.latest?.status === 'inProgress' ? 'active' : 'idle' } } };
    if (method === 'thread/turns/list' && state.historyError) {
      if (state.activityDuringHistory) rpc.onNotification({ method: 'item/started', params: { threadId: 'managed-thread' } });
      throw Object.assign(new Error('rpc_rejected'), { rpcError: state.historyError });
    }
    if (method === 'thread/turns/list') return { data: state.latest ? [{ ...state.latest, ...(params.itemsView === 'full' ? { itemsView: 'full', items: state.items.filter(x => x.turnId === state.latest.id).map(x => x.item) } : {}) }] : [] };
    if (method === 'turn/start') { state.latest = { id: 'initial-turn', status: 'inProgress' }; return { turn: state.latest }; }
    if (method === 'thread/items/list') return { data: state.items, nextCursor: null };
    if (method === 'turn/interrupt') { state.latest.status = 'interrupted'; return {}; }
    throw Error('unexpected_method');
  } };
  const policy = { schemaVersion: '1.0', socket: join(f.root, 'bridge.sock'), backendSocket: join(f.root, 'backend.sock'), backendVersion: '0.163.0',
    sourceRoot: f.policy.roots[0].path, helperUid: process.getuid(), stateDirectory: f.root };
  const bridge = createCodexBridge(policy, rpc);
  t.after(() => bridge.close());
  return { ...f, registry, receipt, binding, requests, frames, state, bridge, rpc, policy };
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

test('a rejected session observation never reroutes an acknowledged report', async t => {
  const f = await fixture(t);
  const secondRequest = structuredClone(f.request);
  for (const key of ['runId', 'workspaceId', 'operationId']) secondRequest.operation[key] += ':second';
  secondRequest.requestId = secondRequest.operation.operationId;
  secondRequest.operation.requestDigest = requestDigest(secondRequest.operation);
  const response = await f.registry.handle(secondRequest);
  assert.equal(response.outcome, 'ok');
  const { runId, workspaceId } = response.workspace;
  const second = { runId, workspaceId, path: f.sourcePath(response.workspace), receiptDigest: digest(response.workspace) };
  const { thread } = await f.bridge.call({ schemaVersion: '1.0', method: 'start', binding: f.binding, parameters: { model: 'test-model' } });
  const observe = { schemaVersion: '1.0', method: 'observe', sessionId: thread.id };
  await assert.rejects(f.bridge.call({ ...observe, binding: second }), /identity_mismatch/);
  const report = { schemaVersion: '1.0', status: 'ready', commitSha: 'a'.repeat(40), summary: 'Done', prTitle: 'Verified', prBody: 'Tests passed', issueComplete: true };
  f.state.latest = { id: 'report-turn', status: 'inProgress' };
  f.rpc.onNotification({ id: 1, method: 'item/tool/call', params: { threadId: thread.id, turnId: f.state.latest.id, callId: 'call-1', tool: 'labstride_report', arguments: report } });
  assert.equal(f.frames.at(-1).result.success, true);
  const journal = new ReportJournal(f.root);
  try { assert.equal(journal.hasSession(second, thread.id), false); }
  finally { journal.close(); }

  f.bridge.close();
  f.state.latest.status = 'completed';
  const reopened = createCodexBridge({ ...f.policy, installationId: f.receipt.installationId }, f.rpc);
  t.after(() => reopened.close());
  const observed = await reopened.call({ ...observe, binding: f.binding });
  assert.equal(observed.report.runId, f.binding.runId);
  assert.equal(observed.report.commitSha, report.commitSha);
});

test('a scoped bridge rejects even a valid workspace receipt from a different installation', async t => {
  const f = await fixture(t);
  const foreign = createCodexBridge({ ...f.policy, installationId: 'installation-other' }, f.rpc);
  t.after(() => foreign.close());
  await assert.rejects(foreign.call({ schemaVersion: '1.0', method: 'start', binding: f.binding, parameters: { model: 'test-model' } }), /identity_mismatch/);
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
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
