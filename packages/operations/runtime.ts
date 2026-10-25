import { lstatSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createLocalPolicyAuthority } from '../core/policy.ts';
import { startExecution } from '../../apps/coordinator/runtime.ts';
import type { GitHubIssueFieldsAdapter } from '../provider-github/issue-fields.ts';
import { configuredSelfBuildAction } from './self-build.ts';
import { BridgeClient } from './bridge.ts';
import { workspaceStart } from '../storage-sqlite/workflows.ts';
import { protectedPath, assertPrivateDatabase } from '../target-helper/filesystem.ts';
import { validated } from '../storage-sqlite/validation.ts';
import { digest } from '../configuration/json.ts';
import { actionKey } from '../core/worker.ts';
import { migrations, verifySchema } from '../storage-sqlite/migrations.ts';
import { publishRunSummary } from './summary.ts';
import { GitHubWorkflowProvider } from '../provider-github/workflows.ts';
import { GitHubMergeProvider } from '../provider-github/merges.ts';
import { readStatus } from './inspection.ts';
import { assertNoMaintenance } from '../storage-sqlite/maintenance.ts';

export { loadInstallation, installationShape, installationDependencies, verifyRootMapping } from './installation.ts';
import { isPublic, installationHost } from './installation.ts';
import type { Installation } from './installation.ts';
import { checkInstallation } from './diagnostics.ts';
import { runnerDiagnostics, probeReady } from './runner-probe.ts';
export const preflight = checkInstallation;
const audit = { actorId: 'local-operator', reason: 'Activate reviewed installed configuration', evidenceRefs: ['installation:owned-file'] };
export async function openOperationalRuntime(spec: Installation, options: Parameters<typeof checkInstallation>[2] = {}) {
  const mode = options.mode ?? 'normal';
  if (!['normal', 'reconcile-only'].includes(mode)) throw Error('configuration_invalid');
  if (mode === 'reconcile-only') {
    if (!isPublic(spec)) throw Error('configuration_invalid');
    validated('public-installation', spec);
    if (!readStatus(spec.stateDirectory, spec.configuration.installationId).recovery.paused) throw Error('recovery_required');
  }
  const checked = await preflight(spec, true, { ...options, route: false }); if (!checked.ok) throw Error('configuration_invalid');
  const authority = createLocalPolicyAuthority();
  if (mode === 'normal') {
    initializePrivateState(spec.stateDirectory);
    const runtime = startExecution(spec.stateDirectory, { actions: { executorId: `service:${spec.configuration.installationId}`, nextAttempt: randomUUID, adapters: new Map() },
      observations: { sessions: new Map(), projections: new Map() }, installedTargets: { host: installationHost(spec) }, dependencies: { policyAuthority: authority, localWorkspaceRoots: isPublic(spec) ? [] : [spec.sourceRoot] } });
    try {
      runtime.store.activateOperationalProfile(checked.compiled, spec.policy, authority, audit);
      await runtime.close();
    } catch (error) { await runtime.close(); throw error; }
  }
  // Adapters capture this exact store instance, so compose after activation and
  // close it with the single execution runtime.
  const execution = startExecution(spec.stateDirectory, { actions: { executorId: `service:${spec.configuration.installationId}`, nextAttempt: randomUUID, adapters: new Map() },
    serialized: true, mode,
    additionalActions: !isPublic(spec) ? store => new Map([[actionKey('labstride.self-build', '0.1.0'), configuredSelfBuildAction(store, spec, checked.adapter as GitHubIssueFieldsAdapter, checked.client, checked.rest)]]) : undefined,
    observations: { sessions: new Map(), projections: new Map() },
    installedTargets: { host: installationHost(spec) }, github: { compiled: checked.compiled, adapter: checked.adapter, buildPlan: (steps, observed) => workspaceStart(checked.compiled, steps, observed) },
    workflowBroker: spec.brokerListener ? { host: installationHost(spec), port: spec.brokerListener.port, provider: new GitHubWorkflowProvider(checked.credential, options.transport),
      diagnostics: runnerDiagnostics(spec), allowEffects: isPublic(spec) ? () => probeReady(spec) : undefined } : undefined,
    githubMerge: spec.mergeEnabled ? { host: installationHost(spec), provider: new GitHubMergeProvider({ credential: checked.credential, fetch: options.transport,
      identity(reference) {
        const binding = spec.credentials[reference];
        if (!binding || typeof binding === 'string' || binding.permissions.contents !== 'write') return null;
        return { appId: Number(binding.appId), installationId: binding.installationId, repositoryIds: binding.repositoryIds, contents: 'write' };
      } }) } : undefined,
    cleanup: spec.configuration.cleanup ? { host:installationHost(spec),
      async keepItem(context) {
        const snapshot=execution.store.runConfiguration(context.run.id)!;
        const adapter=checked.adapter.withConfiguration(snapshot.configuration);
        adapter.beginTick();
        const itemId = isPublic(spec) ? execution.store.originalObservation(context.run.id).event.facts.itemId : context.request.issueId;
        if (typeof itemId !== 'string') throw Error('identity_mismatch');
        return adapter.item(itemId);
      },
      managedSession: !isPublic(spec) ? async context => {
        const receipt=execution.store.workspaceReceipt(context.run.id),session=context.managed!;
        return new BridgeClient(spec.agent.bridgeSocket).call({schemaVersion:'1.0',method:'cleanup-observe',sessionId:session.sessionId,
          binding:{runId:context.run.id,workspaceId:context.workspace.id,path:session.path,receiptDigest:digest(receipt)}});
      } : undefined
    } : undefined,
    dependencies: { policyAuthority: authority, localWorkspaceRoots: isPublic(spec) ? [] : [spec.sourceRoot] } });
  try { await execution.ready; } catch (error) { await execution.close(); throw error; }
  const store = execution.store;
  return { ...execution, authority,
    async tick() {
      if (mode === 'normal') store.advanceWorkflows(installationHost(spec));
      await execution.tick(); await execution.drain();
      if (mode === 'normal') for (const run of store.runs()) {
        try { await publishRunSummary(store, run.id, checked.rest, checked.client); }
        catch { store.summaryError(run.id, 'summary_observation_failed'); }
      }
      if (isPublic(spec)) return;
      for (const pr of store.pullRequests()) {
        store.deferPullRequest(pr.runId);
        try {
          const run = store.get('run', pr.runId), config = store.runConfiguration(run.id)!;
          const source = store.operations(run.id)[0].request.source;
          const current = await checked.rest.request('GET', `/repos/${source.repository}/pulls/${pr.number}`);
          if (current.head?.sha !== pr.sha) { store.workflowError(run.id, 'pull_request_changed'); continue; }
          if (current.merged && config) {
            const issue = store.get('request', run.requestId).issueId, item = await checked.adapter.withConfiguration(config.configuration).item(issue);
            if (item) store.enqueueGitHubProgress(run.id, 'self-build.merged', item);
            store.managedRunComplete(run.id);
          }
        } catch { store.workflowError(pr.runId, 'pull_request_observation_failed'); }
      }
    },
  };
}

export function inspectDatabase(directory: string) {
  assertNoMaintenance(directory);
  assertPrivateDatabase(directory, 'state.sqlite');
  const db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
  try { return { schemaVersion: Number(db.prepare('PRAGMA user_version').get()!.user_version), expectedSchemaVersion: migrations.length,
    integrity: db.prepare('PRAGMA quick_check').get(), runs: Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n) }; }
  finally { db.close(); }
}
export async function backupDatabase(directory: string, destination: string) {
  assertNoMaintenance(directory);
  assertPrivateDatabase(directory, 'state.sqlite');
  try { lstatSync(destination); throw Error('backup_exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  protectedPath(dirname(destination));
  writeFileSync(destination, '', { flag: 'wx', mode: 0o600 }); // Parent exists and is operator-owned.
  const db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
  try { await backup(db, destination); } finally { db.close(); }
}

export async function openDiagnosticsOnly(spec: Installation) {
  validated('public-installation', spec);
  if (!isPublic(spec) || spec.configuration.enabled || !spec.brokerListener || !spec.brokerProbe || spec.configuration.broker.enabled === false) throw Error('broker_configuration_invalid');
  const handler = runnerDiagnostics(spec); if (!handler) throw Error('probe_policy_missing');
  const server = createServer({ maxHeaderSize: 24576 }, handler);
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.timeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(spec.brokerListener!.port, '127.0.0.1', resolve); });
  return { async tick() {}, async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

export function initializePrivateState(directory: string): void {
  assertNoMaintenance(directory);
  assertPrivateDatabase(directory, 'state.sqlite');
  try { writeFileSync(join(directory, 'state.sqlite'), '', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Installed startup is not an automatic database upgrade operation.
    const database = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
    try { verifySchema(database); } finally { database.close(); }
  }
  assertPrivateDatabase(directory, 'state.sqlite');
}
