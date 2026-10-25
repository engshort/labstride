import { safeReason } from '../core/diagnostics.ts';
import { enrolledWorkflow } from '../workflow-broker/bindings.ts';
import { DeploymentOrderingStore } from './deployment-ordering.ts';
import { validated } from './validation.ts';
import { canonical, digest } from './execution.ts';
import { BrokerError, matchingRun, workflowAction, workflowVersion, workflowResource } from '../core/workflow-broker.ts';
import type { Enrollment, WorkflowClaim, WorkflowDispatch, WorkflowMessage, WorkflowReceipt, WorkflowRun } from '../core/workflow-broker.ts';
import { deploymentId, recoveryDetails, targetVerdict } from '../core/deployments.ts';
import type { DeploymentEvidence, TargetObservation, TargetObservationRequest } from '../core/deployments.ts';
import type { BoundResult, Claim } from '../core/execution.ts';
import type { RecordOf } from '../core/lifecycle.ts';

// The coordinator's existing claim protects dispatch. This second claim binds
// the external workflow executor; neither claim is inferred from hook progress.
export class WorkflowBrokerStore extends DeploymentOrderingStore {
  workflowEnrollment(operationId: string): Enrollment {
    const op = this.get('operation', operationId).request;
    return enrolledWorkflow(this.runConfiguration(op.runId), op);
  }
  workflowDispatch(operationId: string): WorkflowDispatch | null {
    const row = this.db.prepare('SELECT payload FROM workflow_dispatches WHERE operation_id=?').get(operationId);
    if (!row) return null;
    const record = validated('workflow-dispatch', JSON.parse(String(row.payload)) as WorkflowDispatch);
    const op = this.get('operation', operationId).request;
    if (record.operationId !== operationId || record.requestDigest !== op.requestDigest ||
      digest(record.enrollment) !== digest(this.workflowEnrollment(operationId))) throw new BrokerError('identity_rejected', 403);
    return record;
  }
  workflowAvailable(operationId: string): boolean {
    const enrollment = this.workflowEnrollment(operationId);
    return !this.db.prepare('SELECT 1 FROM workflow_dispatches WHERE resource_key=? AND active=1 AND operation_id!=?')
      .get(workflowResource(enrollment), operationId);
  }
  workflowTargetOrdered(operationId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM deployment_targets WHERE resource_key=?').get(workflowResource(this.workflowEnrollment(operationId)));
  }
  protected workflowEffectAllowed(operationId: string): void {
    const operation = this.get('operation', operationId), op = operation.request;
    this.assertConfigurationOperation(op.runId, op);
    this.assertPolicyOperation(op.runId, op);
    this.assertAutomation(operationId, false);
    // No legacy fixture bypass: broker execution always needs a bound policy.
    if (!this.operationAuthorization(operationId).allowed || !this.forwardAllowed(op.runId) ||
      operation.effectBoundary !== 'crossed' || !['running','outcome_unknown'].includes(operation.state) ||
      Date.parse(op.deadline) <= Date.parse(this.clock.now()) ||
      this.db.prepare('SELECT paused FROM recovery_control WHERE id=1').get()?.paused ||
      this.db.prepare('SELECT 1 FROM resource_holds WHERE resource_key=?').get(workflowResource(this.workflowEnrollment(operationId))))
      throw new BrokerError('effect_blocked', 403);
    const run = this.get('run', op.runId), request = this.get('request', run.requestId);
    const latest = this.db.prepare('SELECT max(generation) AS generation FROM requests WHERE installation_id=? AND provider_id=? AND issue_id=?')
      .get(request.installationId, request.providerId, request.issueId);
    if (latest?.generation !== request.generation) throw new BrokerError('effect_blocked', 403);
    const enrollment = this.workflowEnrollment(operationId);
    if (!this.db.prepare('SELECT 1 FROM claims WHERE operation_id=? AND resource_key=? AND active=1 AND consumed=1')
      .get(operationId, workflowResource(enrollment))) throw new BrokerError('effect_blocked', 403);
    if (enrollment.deployment) this.assertDeploymentOrder(operationId);
    else if (this.workflowTargetOrdered(operationId))
      throw new BrokerError('effect_blocked', 403); // A workflow-only enrollment cannot downgrade an ordered target.
  }
  beginWorkflowDispatch(operationId: string): { dispatch: boolean; record: WorkflowDispatch } {
    return this.transaction(() => {
      const enrollment = this.workflowEnrollment(operationId), previous = this.workflowDispatch(operationId);
      if (previous) {
        if (digest(previous.enrollment) !== digest(enrollment)) throw new BrokerError('claim_conflict', 409);
        return { dispatch: false, record: previous };
      }
      this.workflowEffectAllowed(operationId);
      if (!this.workflowAvailable(operationId)) throw new BrokerError('claim_conflict', 409);
      const op = this.get('operation', operationId).request;
      const record = validated<WorkflowDispatch>('workflow-dispatch', { schemaVersion: '1.0', operationId,
        requestDigest: op.requestDigest, enrollment, submittedAt: this.clock.now(), runId: null });
      this.db.prepare('INSERT INTO workflow_dispatches(operation_id,payload,resource_key) VALUES (?,?,?)')
        .run(operationId, canonical(record), workflowResource(enrollment));
      if (enrollment.deployment) {
        const now = this.clock.now();
        const deployment = this.get('deployment', deploymentId(operationId));
        const context = { actorId: 'coordinator', reason: 'Bound deployment dispatch', evidenceRefs: [`workflow:${operationId}`] };
        this.write([{ record: { ...deployment, state: 'running', revision: deployment.revision + 1, updatedAt: now }, expectedRevision: deployment.revision }], context);
      }
      this.log(operationId, 'workflow_dispatch_intent', { requestDigest: op.requestDigest, workflowSha: enrollment.workflowSha, sourceSha: op.source.sha });
      return { dispatch: true, record };
    });
  }
  bindWorkflowRun(operationId: string, runId: string): void {
    if (!/^[1-9][0-9]{0,31}$/.test(runId)) throw new BrokerError('invalid_payload', 400);
    const conflict = this.transaction(() => {
      const record = this.workflowDispatch(operationId);
      if (!record) throw new BrokerError('not_found', 404);
      if (record.runId !== null && record.runId !== runId) { this.workflowConflict(operationId); return true; }
      if (record.runId === null) this.db.prepare('UPDATE workflow_dispatches SET payload=? WHERE operation_id=?')
        .run(canonical({ ...record, runId }), operationId);
      return false;
    });
    if (conflict) throw new BrokerError('claim_conflict', 409);
  }
  workflowConflict(operationId: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE workflow_dispatches SET conflict=1 WHERE operation_id=?').run(operationId);
      const dispatch = this.workflowDispatch(operationId);
      if (dispatch) this.db.prepare('INSERT OR IGNORE INTO resource_holds VALUES (?,?)')
        .run(workflowResource(dispatch.enrollment), 'conflicting_workflow_evidence');
      this.log(operationId, 'workflow_evidence_conflict', { schemaVersion: '1.0' });
    });
  }
  workflowConflicted(operationId: string): boolean {
    return this.db.prepare('SELECT conflict FROM workflow_dispatches WHERE operation_id=?').get(operationId)?.conflict === 1;
  }
  workflowClaim(operationId: string): WorkflowClaim | null {
    const row = this.db.prepare('SELECT payload FROM workflow_claims WHERE operation_id=?').get(operationId);
    return row ? validated('workflow-claim', JSON.parse(String(row.payload)) as WorkflowClaim) : null;
  }
  claimWorkflow(operationId: string, input: WorkflowMessage, executor: WorkflowClaim['executor']): WorkflowClaim {
    const message = validated('workflow-message', input);
    return this.transaction(() => {
      const op = this.get('operation', operationId).request, dispatch = this.workflowDispatch(operationId);
      if (!dispatch || message.claimId !== undefined || message.requestDigest !== op.requestDigest || this.workflowConflicted(operationId)) throw new BrokerError('claim_conflict', 409);
      const enrollment = this.workflowEnrollment(operationId);
      if (executor.repositoryId !== enrollment.repository.id || executor.workflowPath !== enrollment.workflowPath || executor.workflowSha !== enrollment.workflowSha ||
        dispatch.runId !== null && dispatch.runId !== executor.runId) throw new BrokerError('claim_conflict', 409);
      const previous = this.workflowClaim(operationId);
      if (previous) {
        if (canonical(previous.executor) !== canonical(executor)) throw new BrokerError('claim_conflict', 409);
        return previous;
      }
      this.workflowEffectAllowed(operationId);
      const parent = this.db.prepare('SELECT payload FROM claims WHERE operation_id=? AND active=1 AND consumed=1').get(operationId);
      if (!parent) throw new BrokerError('effect_blocked', 403);
      const claim = validated<WorkflowClaim>('workflow-claim', { schemaVersion: '1.0', operationId, requestDigest: op.requestDigest,
        claimId: this.identities.next(), fencingNumber: JSON.parse(String(parent.payload)).fencingNumber, executor });
      this.bindWorkflowRun(operationId, executor.runId);
      this.db.prepare('INSERT INTO workflow_claims(operation_id,payload) VALUES (?,?)').run(operationId, canonical(claim));
      this.log(operationId, 'workflow_claim', claim);
      return claim;
    });
  }
  authorizeWorkflowEffect(operationId: string, input: WorkflowMessage, executor: WorkflowClaim['executor']): WorkflowClaim {
    const message = validated('workflow-message', input);
    this.refreshAutomation(this.get('operation', operationId).runId);
    return this.transaction(() => {
      const claim = this.workflowClaim(operationId);
      if (!claim || message.claimId !== claim.claimId || message.requestDigest !== claim.requestDigest ||
        canonical(executor) !== canonical(claim.executor) || this.workflowConflicted(operationId)) throw new BrokerError('claim_conflict', 409);
      this.workflowEffectAllowed(operationId);
      const changed = this.db.prepare('UPDATE workflow_claims SET consumed=1 WHERE operation_id=? AND consumed=0').run(operationId);
      if (changed.changes !== 1) throw new BrokerError('effect_consumed', 409);
      this.log(operationId, 'workflow_effect_boundary', claim);
      return claim;
    });
  }
  workflowReceipt(operationId: string): WorkflowReceipt | null {
    const row = this.db.prepare('SELECT payload FROM workflow_receipts WHERE operation_id=?').get(operationId);
    return row ? validated('receipt', JSON.parse(String(row.payload)) as WorkflowReceipt) : null;
  }
  acceptWorkflowReceipt(operationId: string, input: WorkflowReceipt, executor: WorkflowClaim['executor']): void {
    const receipt = validated('receipt', input), sourceDigest = digest(input);
    if (receipt.error) {
      receipt.error.code = safeReason(receipt.error.code);
      receipt.error.message = receipt.error.code;
    }
    const conflict = this.transaction(() => {
      const claim = this.workflowClaim(operationId), op = this.get('operation', operationId).request;
      if (!claim || receipt.operationId !== operationId || receipt.claimId !== claim.claimId || receipt.fencingNumber !== claim.fencingNumber ||
        receipt.requestDigest !== op.requestDigest || receipt.sourceSha !== op.source.sha || receipt.targetId !== op.targetId ||
        canonical(receipt.executor) !== canonical(executor) || canonical(executor) !== canonical(claim.executor) ||
        this.db.prepare('SELECT consumed FROM workflow_claims WHERE operation_id=?').get(operationId)?.consumed !== 1) throw new BrokerError('identity_rejected', 403);
      const previous = this.workflowReceipt(operationId);
      const originalDigest = this.db.prepare('SELECT source_digest FROM workflow_receipts WHERE operation_id=?').get(operationId)?.source_digest;
      if (previous && (originalDigest ?? digest(previous)) !== sourceDigest) { this.workflowConflict(operationId); return true; }
      if (!previous) {
        this.db.prepare('INSERT INTO workflow_receipts(operation_id,payload,source_digest) VALUES (?,?,?)').run(operationId, canonical(receipt), sourceDigest);
        this.log(operationId, 'workflow_receipt', { digest: sourceDigest, conclusion: receipt.conclusion });
      }
      return false;
    });
    if (conflict) throw new BrokerError('receipt_conflict', 409);
  }
  finishWorkflowObservation(operationId: string, run: WorkflowRun): WorkflowReceipt | null {
    return this.transaction(() => {
      const dispatch = this.workflowDispatch(operationId), claim = this.workflowClaim(operationId), receipt = this.workflowReceipt(operationId);
      const op = this.get('operation', operationId).request;
      const expected = { succeeded: 'success', failed: 'failure', cancelled: 'cancelled', outcome_unknown: null };
      if (!dispatch || !claim || !receipt || this.workflowConflicted(operationId) || run.runId !== claim.executor.runId || run.runAttempt !== claim.executor.runAttempt ||
        dispatch.runId !== run.runId || !matchingRun(dispatch.enrollment, op, run, dispatch.submittedAt) ||
        run.status !== 'completed' || receipt.conclusion === 'outcome_unknown') return null;
      if (receipt.operationId !== operationId || receipt.requestDigest !== op.requestDigest || receipt.sourceSha !== op.source.sha ||
        receipt.targetId !== op.targetId || claim.operationId !== operationId || claim.requestDigest !== op.requestDigest ||
        receipt.claimId !== claim.claimId || receipt.fencingNumber !== claim.fencingNumber || canonical(receipt.executor) !== canonical(claim.executor) ||
        this.db.prepare('SELECT consumed FROM workflow_claims WHERE operation_id=?').get(operationId)?.consumed !== 1) return null;
      if (run.conclusion !== expected[receipt.conclusion]) { this.workflowConflict(operationId); return null; }
      // Deployment profiles release only in the operation-finalization transaction.
      if (!dispatch.enrollment.deployment) this.db.prepare('UPDATE workflow_dispatches SET active=0 WHERE operation_id=?').run(operationId);
      return receipt;
    });
  }

  deploymentEvidence(operationId: string, id?: string): { id: string; evidence: DeploymentEvidence } | null {
    const row = id === undefined
      ? this.db.prepare('SELECT id,payload FROM deployment_evidence WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get(operationId)
      : this.db.prepare('SELECT id,payload FROM deployment_evidence WHERE operation_id=? AND id=?').get(operationId, id);
    if (!row) return null;
    const evidence = validated('deployment-evidence', JSON.parse(String(row.payload)) as DeploymentEvidence);
    if (digest(evidence) !== row.id || evidence.operationId !== operationId) throw new BrokerError('identity_rejected', 403);
    return { id: String(row.id), evidence };
  }

  recordDeploymentObservation(operationId: string, workflow: WorkflowRun, probeRequest: TargetObservationRequest,
    target: TargetObservation | null, unavailable: 'target_observer_unavailable' | 'target_observation_invalid', epoch: number) {
    return this.transaction(() => {
      const receipt = this.finishWorkflowObservation(operationId, workflow), dispatch = this.workflowDispatch(operationId);
      if (!receipt || !dispatch?.enrollment.deployment || epoch !== this.recoveryEpoch()) throw new BrokerError('identity_rejected', 403);
      const op = this.get('operation', operationId).request, profile = dispatch.enrollment.deployment;
      const request = validated('target-observation-request', probeRequest);
      if (request.targetId !== op.targetId || request.environment !== dispatch.enrollment.environment ||
        digest(request.configuration) !== digest(profile.observer.configuration)) throw new BrokerError('identity_rejected', 403);
      const observedAt = this.clock.now();
      const verdict = receipt.conclusion !== 'succeeded' ? { status: 'failed' as const, blocker: 'workflow_failed' as const }
        : target === null ? { status: 'outcome_unknown' as const, blocker: unavailable }
        : targetVerdict(request, target, profile, op.source, observedAt);
      const evidence = validated<DeploymentEvidence>('deployment-evidence', { schemaVersion: '1.0', operationId,
        requestDigest: op.requestDigest, enrollmentDigest: digest(dispatch.enrollment), claim: this.workflowClaim(operationId)!,
        receiptDigest: digest(receipt), recipe: profile.recipe, sourceRepositoryId: op.source.repositoryId, sourceSha: op.source.sha,
        targetId: op.targetId, environment: dispatch.enrollment.environment, workflow, probeRequest: request, target,
        observedAt, recoveryEpoch: epoch, ...verdict });
      const id = digest(evidence);
      this.db.prepare('INSERT OR IGNORE INTO deployment_evidence VALUES (?,?,?)').run(id, operationId, canonical(evidence));
      this.log(operationId, 'deployment_observation', { evidenceId: id, status: evidence.status, blocker: evidence.blocker });
      return { id, evidence };
    });
  }

  override acceptResult(input: BoundResult, claim: Claim | null, expectedRevision: number, projections: RecordOf<'projection'>[] = [], observedEpoch = 0, createsWorkspace = false): boolean {
    const bound = this.validateResult(input), operation = this.get('operation', bound.operationId);
    if (operation.request.actionId !== workflowAction || operation.request.actionVersion !== workflowVersion || !this.workflowEnrollment(operation.id).deployment)
      return super.acceptResult(bound, claim, expectedRevision, projections, observedEpoch, createsWorkspace);
    if (bound.result.status === 'superseded') return this.acceptSuperseded(bound, claim, expectedRevision, observedEpoch);
    return this.transaction(() => {
      const op = operation.request, enrollment = this.workflowEnrollment(op.operationId), profile = enrollment.deployment!;
      const terminal = ['succeeded', 'failed', 'cancelled'].includes(bound.result.status);
      let selected: ReturnType<WorkflowBrokerStore['deploymentEvidence']> = null;
      if (terminal) {
        const id = bound.result.outputs.deploymentEvidenceId;
        if (typeof id !== 'string') throw new BrokerError('identity_rejected', 403);
        selected = this.deploymentEvidence(op.operationId, id);
        if (!selected) throw new BrokerError('identity_rejected', 403);
        const evidence = selected.evidence;
        const receipt = this.finishWorkflowObservation(op.operationId, evidence.workflow);
        const currentClaim = this.workflowClaim(op.operationId);
        const latest = this.deploymentEvidence(op.operationId);
        if (!receipt || !currentClaim || latest?.id !== id || evidence.enrollmentDigest !== digest(enrollment) || evidence.requestDigest !== op.requestDigest ||
          evidence.sourceSha !== op.source.sha || evidence.sourceRepositoryId !== op.source.repositoryId || evidence.targetId !== op.targetId ||
          evidence.environment !== enrollment.environment || digest(evidence.recipe) !== digest(profile.recipe) ||
          canonical(evidence.claim) !== canonical(currentClaim) || evidence.receiptDigest !== digest(receipt) || evidence.recoveryEpoch !== this.recoveryEpoch())
          throw new BrokerError('identity_rejected', 403);
        const verdict = receipt.conclusion !== 'succeeded' ? { status: 'failed', blocker: 'workflow_failed' }
          : targetVerdict(evidence.probeRequest, evidence.target, profile, op.source,
            evidence.status === 'failed' ? evidence.observedAt : this.clock.now());
        if (verdict.status !== evidence.status || verdict.blocker !== evidence.blocker ||
          bound.result.status !== (evidence.status === 'verified' ? 'succeeded' : 'failed') ||
          bound.result.outputs.deploymentVerified !== (evidence.status === 'verified')) throw new BrokerError('identity_rejected', 403);
        if (evidence.status === 'verified' && this.db.prepare('SELECT 1 FROM resource_holds WHERE resource_key=?').get(workflowResource(enrollment)))
          throw new BrokerError('identity_rejected', 403);
      }
      const accepted = super.acceptResult(bound, claim, expectedRevision, projections, observedEpoch, createsWorkspace);
      if (!accepted) return false;
      const deployment = this.get('deployment', deploymentId(op.operationId));
      // Failed/verified records are historical outcomes, never rewritten by a
      // subsequent health recovery or an identical acknowledgement.
      if (['verified', 'failed'].includes(deployment.state)) return true;
      const state = selected ? selected.evidence.status === 'verified' ? 'verified' : 'failed'
        : bound.result.status === 'outcome_unknown' ? 'outcome_unknown' : deployment.state;
      if (state !== deployment.state) this.write([{ record: { ...deployment, state, revision: deployment.revision + 1, updatedAt: this.clock.now() },
        expectedRevision: deployment.revision, ...(deployment.state === 'outcome_unknown' ? { recovery: true } : {}) }],
      { actorId: 'coordinator', reason: 'Independent deployment verification', evidenceRefs: selected ? [`deployment:${selected.id}`] : [`workflow:${op.operationId}`] });
      if (selected?.evidence.status === 'verified') {
        this.finalizeDeploymentPointer(op.operationId, selected.id);
        this.db.prepare('UPDATE workflow_dispatches SET active=0 WHERE operation_id=?').run(op.operationId);
      }
      // Failure keeps both the active dispatch and a persistent recovery hold.
      if (selected?.evidence.status === 'failed') this.db.prepare('INSERT OR IGNORE INTO resource_holds VALUES (?,?)')
        .run(workflowResource(enrollment), selected.evidence.blocker);
      return true;
    });
  }
  brokerDenied(operationId: string, code: string): void {
    // Only safe codes and known operation IDs enter the audit, never tokens/bodies.
    if (this.db.prepare('SELECT 1 FROM workflow_dispatches WHERE operation_id=?').get(operationId))
      this.log(operationId, 'workflow_request_denied', { code });
  }
  workflowExecutions(runId: string) {
    this.get('run', runId);
    return this.db.prepare(`SELECT o.id AS operation_id,d.conflict,c.consumed FROM operations o
      LEFT JOIN workflow_dispatches d ON d.operation_id=o.id LEFT JOIN workflow_claims c ON c.operation_id=o.id
      LEFT JOIN deployment_orders q ON q.operation_id=o.id WHERE o.run_id=? AND (d.operation_id IS NOT NULL OR q.operation_id IS NOT NULL)`)
      .all(runId).map(row => {
        const id = String(row.operation_id), dispatch = this.workflowDispatch(id), enrollment = this.workflowEnrollment(id);
        const deployment = enrollment.deployment ? this.get('deployment', deploymentId(id)) : null;
        return { operationId: id, sourceSha: this.get('operation', id).request.source.sha, workflowSha: enrollment.workflowSha,
          workflowRunId: dispatch?.runId ?? null, claim: this.workflowClaim(id), effectConsumed: row.consumed === 1,
          receiptConclusion: this.workflowReceipt(id)?.conclusion ?? null, conflict: row.conflict === 1,
          deploymentVerified: deployment?.state === 'verified',
          ...(deployment ? { deployment, evidence: this.deploymentEvidence(id), order: this.deploymentOrder(id), orderCheck: this.orderCheck(id),
            successorEvidence: this.successorEvidence(id), successorFulfilled: this.successorFulfilled(id), successorSatisfied: this.successorSatisfied(id),
            cleanupBlocked: deployment.state !== 'verified' || row.conflict === 1,
            blocker: row.conflict === 1 ? 'conflicting_workflow_evidence' : deployment.state === 'superseded'
              ? this.successorSatisfied(id) || this.successorFulfilled(id) ? 'fulfilled_by_successor' : 'successor_proof_pending'
              : this.deploymentEvidence(id)?.evidence.blocker ?? this.orderCheck(id)?.check.blocker ?? 'workflow_evidence_pending',
            recovery: recoveryDetails(enrollment.deployment!, enrollment.targetId, enrollment.environment) } : {}) };
      });
  }
}
