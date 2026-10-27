import { safeReason } from '../core/diagnostics.ts';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { assertPrivateDatabase } from '../target-helper/filesystem.ts';
import { validated } from '../storage-sqlite/validation.ts';
import { verifySchema } from '../storage-sqlite/migrations.ts';
import { assertNoMaintenance } from '../storage-sqlite/maintenance.ts';
import { CleanupStore } from '../storage-sqlite/cleanup.ts';
import { inspectExtension } from '../extensions/loader.ts';
import { isPublic, installationHost } from './installation.ts';
import type { Installation } from './installation.ts';
import type { ManagedSessionStartV1 } from '../../contracts/generated/managed-session-start.ts';

export function readStatus(directory: string, installationId?: string) {
  assertNoMaintenance(directory);
  assertPrivateDatabase(directory, 'state.sqlite');
  lstatSync(join(directory, 'state.sqlite')); // Keep ENOENT distinct; do not create a DB.
  const db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
  try {
    verifySchema(db);
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw Error('storage_failure');
    if (installationId !== undefined) {
      const installations = db.prepare('SELECT id FROM installations').all();
      if (installations.length !== 1 || installations[0].id !== installationId) throw Error('installation_binding_invalid');
    }
    const recovery = db.prepare('SELECT paused,epoch FROM recovery_control WHERE id=1').get()!;
    const count = (sql: string) => Number(db.prepare(sql).get()!.n);
    const providers = db.prepare('SELECT payload FROM github_projects ORDER BY key').all().map(row => {
      const value = JSON.parse(String(row.payload));
      const items = db.prepare('SELECT count(*) AS n FROM github_items WHERE project_key=? AND dirty=1 AND removed=0').get(value.key)!;
      const blocked = db.prepare('SELECT count(*) AS n FROM github_items WHERE project_key=? AND last_error IS NOT NULL AND removed=0').get(value.key)!;
      return { providerId: String(value.providerId), scopeId: String(value.scopeId), configDigest: String(value.configDigest),
        epoch: Number(value.epoch), catchupPending: value.cursor !== null || Number(items.n) > 0,
        blockedItems: Number(blocked.n),
        overdue: Date.now() > Date.parse(value.nextAt) + 120000,
        lastError: value.lastError === null ? null : safeReason(value.lastError, 'provider_unavailable') };
    });
    return { schemaVersion: '1.0' as const,
      recovery: { schemaVersion: '1.0' as const, paused: !!recovery.paused, epoch: Number(recovery.epoch), unresolved: db.prepare('SELECT operation_id FROM restore_checks WHERE resolved=0 ORDER BY operation_id').all().map(row => String(row.operation_id)),
        unresolvedSessions: db.prepare("SELECT id FROM restore_observation_checks WHERE kind='session' AND resolved=0 ORDER BY id").all().map(row => String(row.id)),
        unresolvedProjections: db.prepare("SELECT id FROM restore_observation_checks WHERE kind='projection' AND resolved=0 ORDER BY id").all().map(row => String(row.id)) },
      projections: { pending: count("SELECT count(*) AS n FROM deliveries WHERE projection_id IS NOT NULL AND state IN ('pending','reconcile')"),
        blocked: count("SELECT count(*) AS n FROM deliveries WHERE projection_id IS NOT NULL AND state='blocked'"),
        conflict: count("SELECT count(*) AS n FROM deliveries WHERE projection_id IS NOT NULL AND state='conflict'") },
      unknownOperations: count("SELECT count(*) AS n FROM operations WHERE state='outcome_unknown'"), providers };
  } finally { db.close(); }
}
export function configurationView(spec: Installation) {
  const config = spec.configuration;
  return validated('configuration-inspection', { schemaVersion: '1.0' as const, profile: isPublic(spec) ? 'public' : 'native-self-build', enabled: config.enabled,
    installationId: config.installationId, stateDirectory: spec.stateDirectory, revision: spec.revision,
    repositories: [...config.github.repositories], credentialReferences: { repository: config.github.credentialRef, project: config.github.projectCredentialRef },
    pollIntervalSeconds: config.github.pollIntervalSeconds,
    fields: Object.fromEntries(Object.entries(config.fields).map(([name, value]) => [name, { source: value.source, scopeId: value.scopeId, fieldId: value.fieldId, type: value.type, options: value.options ?? {} }])),
    targets: Object.entries(config.targets).map(([id, target]) => ({ id, connector: target.connector })),
    limits: { ...config.limits, development: config.limits.development ?? config.limits.activeRuns, ciReview: config.limits.ciReview ?? config.limits.activeRuns },
    broker: config.broker.enabled === false ? { enabled: false } : { enabled: true, url: safeBrokerUrl(config.broker.url), oidcAudience: config.broker.oidcAudience },
    session: isPublic(spec) ? { enabled: false, fallback: 'provider_polling_and_operation_reconciliation' } : { enabled: true, backendIdentity: spec.agent.backendIdentity,
      backendVersion: spec.agent.backendVersion, hooks: 'disabled', atomicGuards: 'unsupported', continuity: 'requires_independent_client_evidence' } });
}
export function extensionView(spec: Installation) {
  return validated('extension-inspection', { schemaVersion: '1.0' as const, extensions: spec.lock.extensions.map(pin => {
    let code = 'extension_verified';
    try { inspectExtension(pin, installationHost(spec)); }
    catch (error) { const value = (error as { code?: string }).code; code = ['integrity_mismatch','artifact_unavailable','identity_mismatch','unsupported_capability','forbidden','validation_failed','configuration_invalid'].includes(value ?? '') ? value! : 'operation_failed'; }
    return { id: pin.id, version: pin.version, kind: pin.kind, integrity: pin.integrity, capabilities: pin.capabilities,
      permissions: pin.permissions, ok: code === 'extension_verified', code };
  }) });
}
export function runView(store: CleanupStore, id: string) {
  const status = store.controlStatus(id);
  return { ...status, recovery: store.recoveryStatus(),
    operations: status.operations.map(operation => ({ operationId: operation.operationId, state: operation.state, effectBoundary: operation.effectBoundary,
      delivery: operation.delivery ? { id: operation.delivery.id, state: operation.delivery.state, attempts: operation.delivery.attempts,
        code: operation.delivery.lastError ? safeReason(operation.delivery.lastError) : null } : null })),
    workflowExecutions: store.workflowExecutions(id).map(execution => ({ operationId: execution.operationId, sourceSha: execution.sourceSha,
      workflowSha: execution.workflowSha, workflowRunId: execution.workflowRunId, receiptConclusion: execution.receiptConclusion,
      conflict: execution.conflict, deploymentVerified: execution.deploymentVerified, blocker: 'blocker' in execution ? execution.blocker : null })),
    diagnostic: store.workflowDiagnostic(id) === null ? null : safeReason(store.workflowDiagnostic(id)), summaryDiagnostic: store.summaryDiagnostic(id) === null ? null : safeReason(store.summaryDiagnostic(id)), fieldConflicts: store.managedProjectionDiagnostics(id),
    session: store.managedSession(id),
    startup: store.operations(id).filter(operation => operation.request.actionId === 'labstride.self-build')
      .map(operation => store.managedSessionStart(operation.id)).filter((value): value is ManagedSessionStartV1 => value !== null),
    cleanup: store.cleanupRequests(id).map(request => ({ id: request.id, state: request.state, decisionId: store.cleanupDecision(request.id)?.id ?? null,
      blockers: store.cleanupDecision(request.id)?.decision.blockers ?? [] })),
    projections: store.runProjectionStatus(id) };
}

function safeBrokerUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.href : null; }
  catch { return null; }
}
