import { connect, createServer } from 'node:net';
import { safeError } from '../core/diagnostics.ts';
import { accessSync, constants, chmodSync, lstatSync, readFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { UnixRpc } from '../session-codex/index.mjs';
import { readProtected, directoryIdentity, sameIdentity } from '../target-helper/filesystem.ts';
import { validated } from '../storage-sqlite/validation.ts';
import type { ManagedCodingResultV1 } from '../../contracts/generated/managed-result.ts';
import { digest } from '../configuration/json.ts';
import { ReportJournal } from './report-journal.ts';
import { assertSeparate } from '../storage-sqlite/paths.ts';

const maxWire = 24 * 1024 * 1024;
export interface BridgeBinding { runId: string; workspaceId: string; path: string; receiptDigest: string }
export interface BridgeRequest { schemaVersion: '1.0'; method: 'catalog' | 'start' | 'turn' | 'observe' | 'bundle' | 'interrupt' | 'cleanup-observe';
  binding?: BridgeBinding; sessionId?: string; parameters?: Record<string, unknown> }
export interface BridgePort { call(request: BridgeRequest): Promise<any> }
export class BridgeClient implements BridgePort {
  readonly socket: string;
  constructor(socket: string) { this.socket = socket; }
  call(request: BridgeRequest): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socket); let bytes = Buffer.alloc(0), done = false;
      const finish = (error?: Error, value?: unknown) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(Error('bridge_unavailable')), 30000);
      socket.on('connect', () => socket.end(JSON.stringify(request)));
      socket.on('error', () => finish(Error('bridge_unavailable')));
      socket.on('data', part => { bytes = Buffer.concat([bytes, part]); if (bytes.length > maxWire) finish(Error('response_too_large')); });
      socket.on('end', () => { try { const response = JSON.parse(bytes.toString('utf8')); if (response.schemaVersion !== '1.0' || response.error) throw Error(response.error ?? 'bridge_invalid'); finish(undefined, response.result); }
        catch (error) { finish(error instanceof Error ? error : Error('bridge_invalid')); } });
    });
  }
}

export interface BridgePolicy { schemaVersion: '1.0'; socket: string; backendSocket: string; backendVersion: string;
  sourceRoot: string; helperUid: number; stateDirectory: string; reportDirectory?: string }
// All Git here executes as the coding user and has no installation credentials.
function codingGit(path: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', `safe.directory=${path}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args], {
    cwd: path, encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
export function createCodexBridge(policy: BridgePolicy, rpc: any = new UnixRpc(policy.backendSocket, 15000)) {
  const bindings = new Map<string, BridgeBinding>();
  const reportDirectory = policy.reportDirectory ?? policy.stateDirectory;
  assertSeparate(join(reportDirectory, 'managed-reports'), policy.sourceRoot);
  const reports = new ReportJournal(reportDirectory);
  let initialized: Promise<void> | undefined;
  // A new thread has no pageable rollout until its first user message. This
  // witness is intentionally process-local: disconnect/restart loses it and
  // cannot convert a pre-existing unknown delivery into permission to resend.
  const fresh = new Map<string, string>(), activity = new Set<string>();
  let witnessEpoch = 0;
  const freshBinding = (binding: BridgeBinding) => digest(binding);
  const reportSchema: any = JSON.parse(readFileSync(new URL('../../schemas/managed-result.schema.json', import.meta.url), 'utf8'));
  delete reportSchema.$schema; delete reportSchema.title;
  for (const key of ['runId', 'sessionId', 'turnId']) { delete reportSchema.properties[key]; reportSchema.required = reportSchema.required.filter((name: string) => name !== key); }
  rpc.onDisconnect = () => { initialized = undefined; witnessEpoch++; fresh.clear(); activity.clear(); };
  rpc.onNotification = (message: any) => {
    const threadId = message.params?.threadId ?? message.params?.thread?.id;
    const method = String(message.method ?? '');
    const activityEvent = method.startsWith('turn/') || method.startsWith('item/') || method === 'model/rerouted' ||
      method.startsWith('thread/') && !['thread/started', 'thread/readState/changed', 'thread/name/updated', 'thread/project/updated'].includes(method) &&
      !(method === 'thread/status/changed' && message.params?.status?.type === 'idle');
    // MCP startup metadata is emitted for a newly created thread. It is not a
    // user turn, pending question or settings change and does not consume it.
    if (typeof threadId === 'string' && activityEvent) {
      fresh.delete(threadId);
      if (activity.size >= 4096) { witnessEpoch++; fresh.clear(); activity.clear(); }
      activity.add(threadId);
    }
    if (message.method !== 'item/tool/call' || message.params?.tool !== 'labstride_report' || !bindings.has(message.params.threadId)) return;
    let success = false;
    try {
      const binding = bindings.get(message.params.threadId)!;
      reports.record(binding, message.params.callId, { ...message.params.arguments, runId: binding.runId,
        sessionId: message.params.threadId, turnId: message.params.turnId });
      success = true;
    } catch { /* Invalid or uncommitted reports never receive a success acknowledgement. */ }
    rpc.frame(1, Buffer.from(JSON.stringify({ id: message.id, result: { success, contentItems: [{ type: 'inputText', text: success ? 'Result journaled for this native turn; publication requires independent validation.' : 'Result not recorded; invalid report or unavailable journal.' }] } })));
  };
  async function ready() {
    if (!initialized) initialized = (async () => {
      const reply = await rpc.call('initialize', { clientInfo: { name: 'labstride-managed-bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      if (typeof reply.userAgent !== 'string' || !reply.userAgent.includes(`/${policy.backendVersion} `)) throw Error('backend_version_mismatch');
      rpc.notify('initialized', {});
    })().catch(error => { initialized = undefined; throw error; });
    await initialized;
  }
  function workspace(binding: BridgeBinding) {
    if (!binding || !/^[a-z0-9_.:-]{1,256}$/i.test(binding.runId) || !/^[a-z0-9_.:-]{1,256}$/i.test(binding.workspaceId)) throw Error('identity_mismatch');
    if (!binding.path.startsWith(policy.sourceRoot + '/') || !/^ws-[a-f0-9]{40}\/source$/.test(binding.path.slice(policy.sourceRoot.length + 1)) || realpathSync(binding.path) !== binding.path) throw Error('identity_mismatch');
    const markerPath = join(dirname(binding.path), 'workspace.json');
    const receipt = validated('ssh-workspace-receipt', JSON.parse(readProtected(markerPath, policy.helperUid).toString('utf8')));
    if (digest(receipt) !== binding.receiptDigest || receipt.runId !== binding.runId || receipt.workspaceId !== binding.workspaceId ||
      !sameIdentity(directoryIdentity(binding.path), receipt.checkoutIdentity)) throw Error('identity_mismatch');
    accessSync(binding.path, constants.W_OK);
    return receipt;
  }
  async function observe(binding: BridgeBinding, sessionId: string, allowFresh = false) {
    const { thread } = await rpc.call('thread/read', { threadId: sessionId, includeTurns: false });
    if (thread?.id !== sessionId || thread.cwd !== binding.path || thread.source?.subAgent || thread.historyMode !== 'legacy') throw Error('identity_mismatch');
    let history;
    try { history = await rpc.call('thread/turns/list', { threadId: sessionId, limit: 1, sortDirection: 'desc', itemsView: 'summary' }); }
    catch (error: any) {
      const expected = `thread ${sessionId} is not materialized yet; thread/turns/list is unavailable before first user message`;
      if (!allowFresh || fresh.get(sessionId) !== freshBinding(binding) || thread.status?.type !== 'idle' ||
        thread.preview !== '' || error?.rpcError?.code !== -32600 || error.rpcError.message !== expected) throw error;
      // Recheck metadata after the rejection. The uninterrupted creation and
      // activity witness covers this empty-thread case only; it is never a
      // general inference that unavailable history means empty history.
      const { thread: latest } = await rpc.call('thread/read', { threadId: sessionId, includeTurns: false });
      if (fresh.get(sessionId) !== freshBinding(binding) || latest?.id !== sessionId || latest.cwd !== binding.path ||
        latest.status?.type !== 'idle' || latest.preview !== '' || latest.source?.subAgent) throw Error('stale_revision');
      history = { data: [] };
    }
    if (!Array.isArray(history.data) || history.data.length > 1) throw Error('history_unavailable');
    const turn = history.data[0] ?? null;
    let report: ManagedCodingResultV1 | null = null;
    if (turn?.status === 'completed') {
      // The native handler committed this receipt before acknowledgement.
      // Reading the transcript again adds no receipt evidence and can exceed
      // the bounded RPC even for one turn containing a large tool response.
      report = reports.read(binding, sessionId, turn.id);
      if (!report && !reports.hasSession(binding, sessionId)) {
        // Older bridges did not journal reports. Their history-only receipts
        // still require an explicitly full view within the existing RPC bound.
        // Once journaled delivery is established for this bound session, an
        // unreported conversation turn is ordinary waiting, not legacy recovery.
        const full = await rpc.call('thread/turns/list', { threadId: sessionId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
        const completed = full.data?.[0];
        if (!Array.isArray(full.data) || full.data.length !== 1 || completed.id !== turn.id || completed.status !== 'completed' ||
          completed.itemsView !== 'full' || !Array.isArray(completed.items)) throw Error('stale_revision');
        for (const item of completed.items) if (item.type === 'dynamicToolCall' && item.tool === 'labstride_report' && item.status === 'completed' && item.success === true) {
          const candidate = validated<ManagedCodingResultV1>('managed-result', { ...item.arguments, runId: binding.runId, sessionId, turnId: turn.id });
          if (report && digest(report) !== digest(candidate)) throw Error('report_conflict'); report = candidate;
        }
      }
      const latest = await rpc.call('thread/turns/list', { threadId: sessionId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
      if (!Array.isArray(latest.data) || latest.data.length !== 1 || latest.data[0]?.id !== turn.id || latest.data[0]?.status !== 'completed') throw Error('stale_revision');
    }
    return { sessionId, path: binding.path, turn, state: thread.status?.type ?? 'unknown', report };
  }
  return {
    async call(request: BridgeRequest): Promise<any> {
      if (!request || request.schemaVersion !== '1.0' || Object.keys(request).some(key => !['schemaVersion', 'method', 'binding', 'sessionId', 'parameters'].includes(key))) throw Error('validation_failed');
      await ready();
      if (request.method === 'catalog') {
        const result = await rpc.call('model/list', { limit: 100, includeHidden: false });
        if (!Array.isArray(result.data) || result.nextCursor) throw Error('catalog_truncated');
        return { backendVersion: policy.backendVersion, models: result.data.map((m: any) => ({ model: m.model, reasoning: m.supportedReasoningEfforts?.map((e: any) => e.reasoningEffort) })) };
      }
      const binding = request.binding!, receipt = workspace(binding), parameters = request.parameters ?? {};
      if (request.method === 'bundle') {
        if (typeof parameters.sha !== 'string' || !/^[a-f0-9]{40}$/.test(parameters.sha)) throw Error('validation_failed');
        if (codingGit(binding.path, ['rev-parse', 'HEAD']) !== parameters.sha || codingGit(binding.path, ['symbolic-ref', '--short', 'HEAD']) !== receipt.branch ||
          codingGit(binding.path, ['status', '--porcelain=v1', '--untracked-files=all'])) throw Error('checkout_not_publishable');
        const temp = mkdtempSync(join(tmpdir(), 'labstride-bundle-'));
        try {
          codingGit(binding.path, ['bundle', 'create', join(temp, 'commit.bundle'), 'HEAD']);
          const bytes = readFileSync(join(temp, 'commit.bundle')); if (bytes.length > 16 * 1024 * 1024) throw Error('bundle_too_large');
          return { sha: parameters.sha, branch: receipt.branch, baseSha: receipt.source.sha, bundle: bytes.toString('base64') };
        } finally { rmSync(temp, { recursive: true }); }
      }
      if (request.method === 'start') {
        if (Object.keys(parameters).some(key => !['model'].includes(key)) || typeof parameters.model !== 'string') throw Error('validation_failed');
        const startEpoch = witnessEpoch;
        const result = await rpc.call('thread/start', { cwd: binding.path, model: parameters.model, historyMode: 'legacy', sandbox: 'workspace-write',
          approvalPolicy: 'on-request', approvalsReviewer: 'user', allowProviderModelFallback: false, ephemeral: false,
          serviceName: 'labstride', dynamicTools: [{ name: 'labstride_report', description: 'Report a committed result for independent Labstride PR validation. Never grants approval or deployment authority.', inputSchema: reportSchema }] });
        if (!result.thread?.id || result.thread.cwd !== binding.path || result.thread.historyMode !== 'legacy') throw Error('identity_mismatch');
        bindings.set(result.thread.id, binding);
        if (startEpoch === witnessEpoch && !activity.has(result.thread.id)) fresh.set(result.thread.id, freshBinding(binding));
        return { thread: { id: result.thread.id, cwd: result.thread.cwd } };
      }
      const sessionId = request.sessionId;
      if (!sessionId || !/^[a-z0-9-]{1,128}$/i.test(sessionId)) throw Error('identity_mismatch');
      bindings.set(sessionId, binding);
      if (request.method === 'cleanup-observe') {
        // Read metadata only. No resume, report recovery, turn or interrupt.
        const read = async () => {
          const {thread} = await rpc.call('thread/read',{threadId:sessionId,includeTurns:false});
          if(thread?.id!==sessionId || thread.cwd!==binding.path || thread.source?.subAgent || thread.historyMode!=='legacy') throw Error('identity_mismatch');
          const history = await rpc.call('thread/turns/list',{threadId:sessionId,limit:1,sortDirection:'desc',itemsView:'summary'});
          if(!Array.isArray(history.data)||history.data.length>1)throw Error('history_unavailable');
          const turn=history.data[0];
          return {state:thread.status?.type==='idle' && (!turn || ['completed','interrupted','failed'].includes(turn.status))?'idle':thread.status?.type==='active'?'active':'unknown',lastTurnId:turn?.id??null};
        };
        const first=await read(), second=await read();
        if(digest(first)!==digest(second))throw Error('stale_revision');
        return validated('managed-cleanup-observation',{schemaVersion:'1.0',runId:binding.runId,workspaceId:binding.workspaceId,sessionId,path:binding.path,...second,observedAt:new Date().toISOString()});
      }
      const before = await observe(binding, sessionId, request.method === 'turn' && parameters.expectedTurnId === null);
      if (request.method === 'observe') {
        // Metadata-only reattachment preserves the app's current settings.
        await rpc.call('thread/resume', { threadId: sessionId, excludeTurns: true });
        return before;
      }
      if (request.method === 'interrupt') {
        if (before.turn?.id !== parameters.turnId || before.turn?.status !== 'inProgress') throw Error('stale_revision');
        await rpc.call('turn/interrupt', { threadId: sessionId, turnId: parameters.turnId }); return { interrupted: parameters.turnId };
      }
      if (request.method !== 'turn' || Object.keys(parameters).some(key => !['expectedTurnId', 'prompt', 'model', 'reasoning', 'mode'].includes(key)) ||
        before.turn?.id !== (parameters.expectedTurnId ?? undefined) || before.turn !== null || before.state === 'active' ||
        typeof parameters.prompt !== 'string' || parameters.prompt.length > 128000 || !['plan', 'default'].includes(String(parameters.mode))) throw Error('stale_revision');
      // Checked delivery, explicitly NOT an atomic backend compare-and-start.
      fresh.delete(sessionId);
      const result = await rpc.call('turn/start', { threadId: sessionId, input: [{ type: 'text', text: parameters.prompt }],
        collaborationMode: { mode: parameters.mode, settings: { model: parameters.model, reasoning_effort: parameters.reasoning, developer_instructions: null } } });
      if (!result.turn?.id) throw Error('outcome_unknown');
      return { turn: { id: result.turn.id, status: result.turn.status } };
    },
    close() { rpc.close(); reports.close(); },
  };
}

export async function serveBridge(policy: BridgePolicy) {
  if (policy.schemaVersion !== '1.0' || !policy.socket.startsWith('/') || lstatSync(dirname(policy.socket)).uid !== process.getuid!()) throw Error('configuration_invalid');
  const bridge = createCodexBridge(policy);
  const server = createServer({ allowHalfOpen: true }, socket => {
    let bytes = Buffer.alloc(0); const timer = setTimeout(() => socket.destroy(), 30000);
    socket.on('error', () => {}); socket.on('close', () => clearTimeout(timer));
    socket.on('data', part => { bytes = Buffer.concat([bytes, part]); if (bytes.length > 262144) socket.destroy(); });
    socket.on('end', async () => {
      try { const result = await bridge.call(JSON.parse(bytes.toString('utf8'))); socket.end(JSON.stringify({ schemaVersion: '1.0', result })); }
      catch (error) { socket.end(JSON.stringify({ schemaVersion: '1.0', error: safeError(error) })); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(policy.socket, resolve); });
  chmodSync(policy.socket, 0o660);
  return { close: () => new Promise<void>(resolve => { bridge.close(); server.close(() => resolve()); }) };
}
