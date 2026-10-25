import { enrolledWorkflow } from '../workflow-broker/bindings.ts';
import { WorkflowBrokerStore } from './workflow-broker.ts';
import { workflowAction, workflowResource } from '../core/workflow-broker.ts';
import { mergeAction, mergeResource } from '../core/merges.ts';
import { enrolledMerge } from '../github-merge/bindings.ts';
import { LifecycleError } from '../core/lifecycle.ts';
import { safeReason } from '../core/diagnostics.ts';
import type { RecordOf, AuditContext } from '../core/lifecycle.ts';
import type { CompiledConfiguration } from '../configuration/compiler.ts';
import type { HostProfile } from '../extensions/loader.ts';
import type { RuleObservation } from '../configuration/rules.ts';
import type { BoundStep } from '../configuration/bindings.ts';
import type { StartPlan } from '../core/execution.ts';
import { bindWorkflow } from '../configuration/bindings.ts';
import { digest, requestDigest, canonical } from './execution.ts';
import { prepareWorkspaceStart } from '../connector-ssh/workspaces.ts';
import { validated } from './validation.ts';
import type { ManagedCodingResultV1 } from '../../contracts/generated/managed-result.ts';
import type { Policy, LocalPolicyAuthority } from '../core/policy.ts';
import type { ManagedSessionStartV1 } from '../../contracts/generated/managed-session-start.ts';

const audit: AuditContext = { actorId: 'coordinator', reason: 'Advance original configured workflow', evidenceRefs: ['workflow:durable'] };
export function workspaceStart(compiled: CompiledConfiguration, steps: BoundStep[], observation: RuleObservation): StartPlan {
  const config = compiled.snapshot.configuration, step = steps[0];
  if (step.actionId !== 'labstride.workspace-create' || typeof step.inputs.target !== 'string') throw new LifecycleError('unsupported_capability');
  const source = step.inputs.source as RecordOf<'operation'>['request']['source'];
  const seed = digest([config.installationId, observation.event.provider, observation.event.subjectId, observation.generation]);
  const runId = `run-${seed}`, workspaceId = `ws-${seed}`, operationId = `op-${seed}`;
  const base = { schemaVersion: '1.0' as const, revision: 1, createdAt: observation.event.observedAt, updatedAt: observation.event.observedAt };
  const request: RecordOf<'operation'>['request'] = { schemaVersion: '1.0', operationId, runId, workspaceId,
    actionId: step.actionId, actionVersion: step.actionVersion, configDigest: compiled.snapshot.digest, source,
    targetId: step.inputs.target, deadline: new Date(Date.parse(base.createdAt) + (config.limits.unattendedMs ?? 86400000)).toISOString(),
    inputs: step.inputs, requestDigest: '' };
  request.requestDigest = requestDigest(request);
  return prepareWorkspaceStart({
    request: { ...base, kind: 'request', id: `request-${seed}`, installationId: config.installationId,
      providerId: observation.event.provider, issueId: observation.event.subjectId, generation: observation.generation },
    run: { ...base, kind: 'run', id: runId, requestId: `request-${seed}`, repositoryId: source.repositoryId,
      configRevision: compiled.snapshot.digest, state: 'queued', paused: false, checkpoint: null },
    workspace: { ...base, kind: 'workspace', id: workspaceId, runId, targetId: request.targetId,
      locator: '', localPath: null, ownershipRef: '', branch: '', state: 'requested', keep: true },
    operation: { ...base, kind: 'operation', id: operationId, runId, workspaceId, request, state: 'prepared', effectBoundary: 'not_crossed' },
    outbox: { ...base, kind: 'outbox', id: `intent-${seed}`, runId, operationId, intentKey: `start:${seed}`, payload: { schemaVersion: '1.0', operationId } },
    projections: [], resourceKey: `workspace:${workspaceId}`,
  }, config.installationId);
}

export class WorkflowStore extends WorkflowBrokerStore {
  runProjectionStatus(runId: string) {
    this.get('run', runId);
    return this.db.prepare('SELECT p.id,d.state,d.last_error FROM projections p JOIN deliveries d ON d.projection_id=p.id WHERE p.run_id=? ORDER BY p.id')
      .all(runId).map(row => ({ id: String(row.id), state: String(row.state), code: row.last_error === null ? null : safeReason(row.last_error, 'projection_blocked') }));
  }
  reconcileRunObservations(runId: string, context: AuditContext, authority: LocalPolicyAuthority): void {
    this.assertOperator(authority);
    this.get('run', runId);
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT d.id FROM deliveries d LEFT JOIN operations o ON o.id=d.operation_id LEFT JOIN projections p ON p.id=d.projection_id WHERE (o.run_id=? OR p.run_id=?) AND d.state='blocked'").all(runId, runId)) {
        this.resumeObservation(String(row.id), context);
      }
      for (const row of this.db.prepare('SELECT id FROM sessions WHERE run_id=?').all(runId)) this.resumeSessionObservation(String(row.id), context);
    });
  }
  managedSessionStart(operationId: string): ManagedSessionStartV1 | null {
    const row = this.db.prepare("SELECT digest,request,response FROM managed_effects WHERE operation_id=? AND name='session-start-input'").get(operationId);
    if (!row) return null;
    if (row.response === null) throw new LifecycleError('recovery_required');
    const value = validated('managed-session-start', JSON.parse(String(row.response)) as ManagedSessionStartV1);
    const op = this.get('operation', operationId).request;
    if (row.digest !== digest(value) || row.request !== canonical(value) || value.runId !== op.runId || value.workspaceId !== op.workspaceId ||
      value.configDigest !== op.configDigest || value.sourceSha !== op.source.sha || value.receiptDigest !== digest(this.workspaceReceipt(op.runId))) throw new LifecycleError('identity_conflict');
    return value;
  }
  freezeSessionStart(operationId: string, input: ManagedSessionStartV1): ManagedSessionStartV1 {
    const start = validated('managed-session-start', input);
    return this.transaction(() => {
      const operation = this.get('operation', operationId), op = operation.request;
      this.assertConfigurationOperation(op.runId, op); this.assertPolicyOperation(op.runId, op, 'execute');
      if (!this.forwardAllowed(op.runId) || operation.effectBoundary !== 'crossed' || op.actionId !== 'labstride.self-build' ||
        start.runId !== op.runId || start.workspaceId !== op.workspaceId || start.configDigest !== op.configDigest || start.sourceSha !== op.source.sha ||
        start.receiptDigest !== digest(this.workspaceReceipt(op.runId))) throw new LifecycleError('identity_conflict');
      const previous = this.managedSessionStart(operationId), payload = canonical(start);
      if (previous) { if (canonical(previous) !== payload) throw new LifecycleError('identity_conflict'); return previous; }
      // This is local input selection, committed atomically with its value. It
      // has no external dispatch window and is never reconstructed from later
      // GitHub field edits after a possibly completed native session start.
      this.db.prepare('INSERT INTO managed_effects VALUES (?,?,?,?,?)').run(operationId, 'session-start-input', digest(start), payload, payload);
      this.log(operationId, 'session_start_selected', { digest: digest(start) });
      return start;
    });
  }
  hasManagedEffect(operationId: string, name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM managed_effects WHERE operation_id=? AND name=?').get(operationId, name);
  }
  activateOperationalProfile(compiled: CompiledConfiguration, policy: Policy, authority: LocalPolicyAuthority, context: AuditContext): void {
    this.assertOperator(authority);
    this.transaction(() => {
      const id = compiled.snapshot.configuration.installationId;
      const row = this.db.prepare('SELECT id FROM installations WHERE id=?').get(id);
      const previous = row ? this.get('installation', id) : null;
      // A policy references an existing installation. Publish both atomically
      // before any worker can observe an enabled configuration without policy.
      if (previous?.configRevision !== compiled.snapshot.digest) this.activateConfiguration(compiled, previous?.revision ?? null, context, authority);
      const status = this.policyStatus(id);
      if (!status || canonical(this.policyRevision(id, status.policyRevision)) !== canonical(policy)) {
        const revision = status?.revision ?? 0;
        this.applyPolicyChange({ schemaVersion: '1.0', id: `installed:${digest(policy)}:${revision}`, installationId: id,
          expectedRevision: revision, change: { kind: 'publish', policy } }, authority, context);
      }
    });
  }
  protected override serializeGitHubProgress(runId: string): boolean {
    return Object.values(this.runConfiguration(runId)?.configuration.workflows ?? {})
      .some(steps => steps.some(step => step.action === 'labstride.self-build'));
  }
  phaseRevision(runId: string, name: string): string {
    if (!/^[a-z-]{1,64}$/.test(name)) throw new LifecycleError('invalid_payload');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT name,revision FROM managed_phases WHERE run_id=?').get(runId);
      if (row?.name === name) return String(row.revision);
      const revision = Number(row?.revision ?? 0) + 1;
      this.db.prepare('INSERT INTO managed_phases VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET name=excluded.name,revision=excluded.revision').run(runId, name, revision);
      return String(revision);
    });
  }
  managedProjectionDiagnostics(runId: string) {
    return this.db.prepare("SELECT p.id,json_extract(p.payload,'$.fieldId') AS fieldId,d.state,d.last_error AS code FROM projections p JOIN deliveries d ON d.projection_id=p.id WHERE p.run_id=? AND d.state IN ('blocked','conflict')").all(runId).map(row => ({ ...row, code: row.code === null ? null : safeReason(row.code, 'projection_blocked') }));
  }
  summaryError(runId: string, code: string): void {
    code = safeReason(code, 'summary_observation_failed');
    this.db.prepare('INSERT INTO managed_summary_errors VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET code=excluded.code').run(runId, code);
  }
  summaryDiagnostic(runId: string): string | null { return this.db.prepare('SELECT code FROM managed_summary_errors WHERE run_id=?').get(runId)?.code as string ?? null; }
  registeredPullRequest(runId: string): { number: number; sha: string } | null {
    const row = this.db.prepare('SELECT number,sha FROM managed_pull_requests WHERE run_id=?').get(runId);
    return row ? { number: Number(row.number), sha: String(row.sha) } : null;
  }
  originalObservation(runId: string): RuleObservation {
    const row = this.db.prepare('SELECT payload FROM inbox WHERE run_id=? ORDER BY rowid LIMIT 1').get(runId);
    if (!row) throw new LifecycleError('not_found');
    return validated('rule-observation', JSON.parse(String(row.payload)).event.facts.configurationObservation);
  }
  managedSession(runId: string): { operationId: string; sessionId: string; path: string; mode: string; model: string; reasoning: string } | null {
    const row = this.db.prepare('SELECT * FROM managed_sessions WHERE run_id=?').get(runId);
    return row ? { operationId: String(row.operation_id), sessionId: String(row.session_id), path: String(row.workspace_path), mode: String(row.mode), model: String(row.model), reasoning: String(row.reasoning) } : null;
  }
  registerManagedSession(operationId: string, sessionId: string, path: string, mode: string, model: string, reasoning: string): void {
    this.transaction(() => {
      const operation = this.get('operation', operationId), workspace = this.workspace(operation.runId);
      if (operation.request.actionId !== 'labstride.self-build' || operation.effectBoundary !== 'crossed' ||
        workspace.state !== 'ready' || !/^[a-z0-9-]{1,128}$/i.test(sessionId) || !path.startsWith('/')) throw new LifecycleError('identity_conflict');
      const result = this.readManagedEffect(operationId, 'thread-start') as { thread?: { id?: string; cwd?: string } } | null;
      if (result?.thread?.id !== sessionId || result.thread.cwd !== path) throw new LifecycleError('identity_conflict');
      const old = this.managedSession(operation.runId), expected = { operationId, sessionId, path, mode, model, reasoning };
      if (old && canonical(old) !== canonical(expected)) throw new LifecycleError('identity_conflict');
      this.db.prepare('INSERT OR IGNORE INTO managed_sessions VALUES (?,?,?,?,?,?,?)').run(operation.runId, operationId, sessionId, path, mode, model, reasoning);
    });
  }
  protected override githubProgressValue(runId: string, mapping: import('../configuration/snapshot.ts').ConfigurationSnapshot['configuration']['projections'][number]): unknown {
    const managed = this.managedSession(runId);
    if (mapping.valueFrom?.kind === 'session-id' && managed) {
      const operation = this.get('operation', managed.operationId);
      if (operation.runId !== runId || operation.request.actionId !== 'labstride.self-build') throw new LifecycleError('identity_conflict');
      return managed.sessionId;
    }
    return super.githubProgressValue(runId, mapping);
  }
  saveManagedReport(input: unknown): void {
    const report = validated<ManagedCodingResultV1>('managed-result', input as ManagedCodingResultV1);
    const session = this.managedSession(report.runId);
    if (!session || session.sessionId !== report.sessionId) throw new LifecycleError('identity_conflict');
    this.db.prepare('INSERT INTO managed_reports VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET session_id=excluded.session_id,turn_id=excluded.turn_id,payload=excluded.payload')
      .run(report.runId, report.sessionId, report.turnId, canonical(report));
  }
  managedReport(runId: string): ManagedCodingResultV1 | null {
    const row = this.db.prepare('SELECT payload FROM managed_reports WHERE run_id=?').get(runId);
    return row ? validated('managed-result', JSON.parse(String(row.payload)) as ManagedCodingResultV1) : null;
  }
  workspaceReceipt(runId: string) {
    const first = this.operations(runId)[0];
    const row = this.db.prepare('SELECT payload FROM execution_results WHERE operation_id=?').get(first.id);
    if (first.state !== 'succeeded' || first.request.actionId !== 'labstride.workspace-create' || !row) throw new LifecycleError('effect_blocked');
    return validated('ssh-workspace-receipt', JSON.parse(String(row.payload)).result.outputs.workspace as import('../../contracts/generated/ssh-workspace-receipt.ts').OwnedWorkspaceCreationReceiptV1);
  }
  registerPullRequest(runId: string, number: number, sha: string): void {
    if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(sha)) throw new LifecycleError('invalid_payload');
    const old = this.db.prepare('SELECT number FROM managed_pull_requests WHERE run_id=?').get(runId);
    if (old && old.number !== number) throw new LifecycleError('identity_conflict');
    this.db.prepare('INSERT INTO managed_pull_requests VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET sha=excluded.sha').run(runId, number, sha, this.clock.now());
  }
  pullRequests(): { runId: string; number: number; sha: string }[] {
    return this.db.prepare('SELECT * FROM managed_pull_requests WHERE next_at<=? LIMIT 32').all(this.clock.now())
      .map(row => ({ runId: String(row.run_id), number: Number(row.number), sha: String(row.sha) }));
  }
  deferPullRequest(runId: string): void { this.db.prepare('UPDATE managed_pull_requests SET next_at=? WHERE run_id=?').run(new Date(Date.parse(this.clock.now()) + 60000).toISOString(), runId); }
  managedRunActive(runId: string): void {
    const run = this.get('run', runId);
    if (run.state === 'ready') this.commit([{ expectedRevision: run.revision, record: { ...run, state: 'active', revision: run.revision + 1, updatedAt: this.clock.now() } }], audit);
  }
  managedRunComplete(runId: string): void {
    const run = this.get('run', runId);
    if (run.state === 'active') this.commit([{ expectedRevision: run.revision, record: { ...run, state: 'completed', revision: run.revision + 1, updatedAt: this.clock.now() } }], audit);
  }
  summaryDue(runId: string): boolean {
    const row = this.db.prepare('SELECT next_at FROM managed_summaries WHERE run_id=?').get(runId);
    return !row || String(row.next_at) <= this.clock.now();
  }
  summaryIntent(runId: string, body: string): { number: number | null; body: string; previous: string | null; pending: boolean; dispatch: boolean } {
    if (body.length > 16000) throw new LifecycleError('invalid_payload');
    return this.transaction(() => {
      if (!this.summaryAllowed(runId)) throw new LifecycleError('effect_blocked');
      const row = this.db.prepare('SELECT * FROM managed_summaries WHERE run_id=?').get(runId), next = new Date(Date.parse(this.clock.now()) + 60000).toISOString();
      if (!row) {
        this.db.prepare('INSERT INTO managed_summaries VALUES (?,NULL,?,NULL,1,?)').run(runId, body, next);
        return { number: null, body, previous: null, pending: true, dispatch: true };
      }
      this.db.prepare('UPDATE managed_summaries SET next_at=? WHERE run_id=?').run(next, runId);
      if (row.pending || row.body === body) return { number: row.comment_id as number | null, body: String(row.body), previous: row.previous_body as string | null, pending: !!row.pending, dispatch: false };
      this.db.prepare('UPDATE managed_summaries SET previous_body=body,body=?,pending=1 WHERE run_id=?').run(body, runId);
      return { number: row.comment_id as number, body, previous: String(row.body), pending: true, dispatch: true };
    });
  }
  completeSummary(runId: string, number: number, body: string): void {
    if (!Number.isSafeInteger(number) || number < 1) throw new LifecycleError('invalid_payload');
    const row = this.db.prepare('SELECT comment_id,body FROM managed_summaries WHERE run_id=?').get(runId);
    if (!row || row.body !== body || row.comment_id !== null && row.comment_id !== number) throw new LifecycleError('identity_conflict');
    this.db.prepare('UPDATE managed_summaries SET comment_id=?,pending=0 WHERE run_id=?').run(number, runId);
  }
  runs(): RecordOf<'run'>[] { return this.db.prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 100').all().map(row => this.get('run', String(row.id))); }
  operations(runId: string): RecordOf<'operation'>[] {
    return this.db.prepare('SELECT id FROM operations WHERE run_id=? ORDER BY rowid').all(runId).map(row => this.get('operation', String(row.id)));
  }
  workspace(runId: string): RecordOf<'workspace'> {
    const rows = this.db.prepare('SELECT id FROM workspaces WHERE run_id=?').all(runId);
    if (rows.length !== 1) throw new LifecycleError('identity_conflict');
    return this.get('workspace', String(rows[0].id));
  }
  workflowDiagnostic(runId: string): string | null { return this.db.prepare('SELECT code FROM workflow_diagnostics WHERE run_id=?').get(runId)?.code as string ?? null; }
  clearWorkflowDiagnostic(runId: string): void { this.db.prepare('DELETE FROM workflow_diagnostics WHERE run_id=?').run(runId); }
  workflowError(runId: string, code: string): void {
    code = safeReason(code, 'workflow_blocked');
    this.db.prepare('INSERT INTO workflow_diagnostics VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET code=excluded.code').run(runId, code);
  }
  advanceWorkflows(host: HostProfile): void {
    for (const run of this.runs().reverse()) {
      if (!this.forwardAllowed(run.id)) continue;
      const receipt = this.db.prepare('SELECT payload FROM rule_evaluations WHERE run_id=?').get(run.id);
      if (!receipt) continue; // Legacy probes are never adopted by the installed runner.
      try {
        this.transaction(() => {
          const snapshot = this.runConfiguration(run.id);
          if (!snapshot) throw new LifecycleError('effect_blocked');
          const evaluation = JSON.parse(String(receipt.payload)), workflow = snapshot.configuration.workflows[evaluation.workflow];
          if (!workflow?.length) throw new LifecycleError('identity_conflict');
          const operations = this.operations(run.id), first = operations[0];
          if (!first || first.request.actionId !== workflow[0].action) throw new LifecycleError('identity_conflict');
          this.db.prepare('INSERT OR IGNORE INTO workflow_steps VALUES (?,0,?)').run(run.id, first.id);
          const rows = this.db.prepare('SELECT * FROM workflow_steps WHERE run_id=? ORDER BY position').all(run.id);
          const tail = this.get('operation', String(rows.at(-1)!.operation_id));
          if (tail.state !== 'succeeded' && !(tail.state === 'superseded' && this.consumeSuccessorEvidence(tail.id))) return;
          const position = rows.length;
          if (position === workflow.length) return;
          const original = this.db.prepare('SELECT payload FROM inbox WHERE run_id=? ORDER BY rowid LIMIT 1').get(run.id);
          const observation = JSON.parse(String(original!.payload)).event.facts.configurationObservation as RuleObservation;
          let source = first.request.source;
          if (workflow[position].action === workflowAction) {
            const merged = operations.filter(op => op.state === 'succeeded' && op.request.actionId === mergeAction).at(-1);
            if (merged) {
              const record = this.mergeRecord(merged.id);
              if (record?.outcome !== 'confirmed' || !record.mergeSha || record.enrollment.repository.nodeId !== source.repositoryId ||
                record.enrollment.repository.name !== source.repository) throw new LifecycleError('identity_conflict');
              source = { ...source, sha: record.mergeSha };
            }
          }
          const step = bindWorkflow(snapshot.configuration, snapshot.extensionLock.extensions, host, evaluation.workflow,
            observation.current, { source, workspaceId: first.workspaceId }, workflow[position].id)[0];
          const id = `step-${digest([run.id, position])}`, now = this.clock.now();
          const descriptor = { ...first.request, source, operationId: id, actionId: step.actionId, actionVersion: step.actionVersion,
            inputs: step.inputs, targetId: typeof step.inputs.target === 'string' ? step.inputs.target : first.request.targetId };
          descriptor.requestDigest = requestDigest(descriptor);
          const base = { schemaVersion: '1.0' as const, revision: 1, createdAt: now, updatedAt: now };
          this.scheduleOperation({
            operation: { ...base, kind: 'operation', id, runId: run.id, workspaceId: first.workspaceId, request: descriptor, state: 'prepared', effectBoundary: 'not_crossed' },
            outbox: { ...base, kind: 'outbox', id: `intent-${id}`, runId: run.id, operationId: id, intentKey: id, payload: { schemaVersion: '1.0', operationId: id } },
            resourceKey: descriptor.actionId === workflowAction ? workflowResource(enrolledWorkflow(snapshot, descriptor)) :
              descriptor.actionId === mergeAction ? mergeResource(enrolledMerge(snapshot, descriptor).enrollment) : `workspace:${first.workspaceId}`, capacityClass: descriptor.actionId === workflowAction ? 'ciReview' : 'development',
          }, audit);
          this.db.prepare('INSERT INTO workflow_steps VALUES (?,?,?)').run(run.id, position, id);
          this.db.prepare('DELETE FROM workflow_diagnostics WHERE run_id=?').run(run.id);
        });
      } catch (error) { this.workflowError(run.id, error instanceof LifecycleError ? error.code : 'binding_invalid'); }
    }
  }
  // Durable intent is committed before a caller may dispatch. An absent reply is
  // deliberately not a retry permit, including after actual process death.
  beginManagedEffect(operationId: string, name: string, input: unknown, cancellationId?: string): { dispatch: boolean; response: unknown | null } {
    if (!/^[a-z0-9_.:-]{1,256}$/.test(name)) throw new LifecycleError('invalid_payload');
    const payload = canonical(input); if (Buffer.byteLength(payload) > 262144) throw new LifecycleError('invalid_payload');
    return this.transaction(() => {
      const operation = this.get('operation', operationId);
      this.assertConfigurationOperation(operation.runId, operation.request);
      this.assertPolicyOperation(operation.runId, operation.request, cancellationId ? 'cancel' : 'execute');
      if (cancellationId) {
        if (!this.db.prepare("SELECT 1 FROM cancellations WHERE operation_id=? AND control_id=? AND state='submitted'").get(operationId, cancellationId)) throw new LifecycleError('effect_blocked');
      } else if (!this.forwardAllowed(operation.runId)) throw new LifecycleError('effect_blocked');
      if (operation.effectBoundary !== 'crossed') throw new LifecycleError('effect_blocked');
      const prior = this.db.prepare('SELECT * FROM managed_effects WHERE operation_id=? AND name=?').get(operationId, name);
      if (prior) {
        if (prior.digest !== digest(input) || prior.request !== payload) throw new LifecycleError('identity_conflict');
        return { dispatch: false, response: prior.response === null ? null : JSON.parse(String(prior.response)) };
      }
      this.db.prepare('INSERT INTO managed_effects VALUES (?,?,?,?,NULL)').run(operationId, name, digest(input), payload);
      this.log(operationId, 'managed_effect_intent', { name, digest: digest(input) });
      return { dispatch: true, response: null };
    });
  }
  finishManagedEffect(operationId: string, name: string, response: unknown, evidenceRefs?: string[]): void {
    const payload = canonical(response); if (Buffer.byteLength(payload) > 262144) throw new LifecycleError('invalid_payload');
    if (evidenceRefs && (!evidenceRefs.length || evidenceRefs.length > 16 || evidenceRefs.some(ref => typeof ref !== 'string' || !ref || ref.length > 4096))) throw new LifecycleError('invalid_payload');
    this.transaction(() => {
      const prior = this.db.prepare('SELECT response FROM managed_effects WHERE operation_id=? AND name=?').get(operationId, name);
      if (!prior) throw new LifecycleError('not_found');
      if (prior.response !== null && prior.response !== payload) throw new LifecycleError('identity_conflict');
      this.db.prepare('UPDATE managed_effects SET response=? WHERE operation_id=? AND name=?').run(payload, operationId, name);
      if (prior.response === null && evidenceRefs) this.log(operationId, 'managed_effect_observed', { schemaVersion: '1.0', name, evidenceRefs });
    });
  }
  readManagedEffect(operationId: string, name: string): unknown | null {
    const row = this.db.prepare('SELECT response FROM managed_effects WHERE operation_id=? AND name=?').get(operationId, name);
    return row?.response ? JSON.parse(String(row.response)) : null;
  }
}
