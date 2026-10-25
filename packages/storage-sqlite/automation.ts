import { SchedulingStore, controlContext } from './scheduling.ts';
import { validated } from './validation.ts';
import { LifecycleError } from '../core/lifecycle.ts';
import { diagnosticEvent } from '../core/diagnostics.ts';
import type { AutomationContext } from '../../contracts/generated/automation-context.ts';
import type { RunBudget } from '../../contracts/generated/run-budget.ts';
import type { AuditContext } from '../core/lifecycle.ts';
import type { LocalPolicyAuthority } from '../core/policy.ts';

export class AutomationStore extends SchedulingStore {
  protected assertControlAuthority(_runId: string, _authority?: LocalPolicyAuthority): void {}
  automationContext(operationId: string): AutomationContext {
    const row = this.db.prepare('SELECT automation FROM operation_scheduling WHERE operation_id=?').get(operationId);
    if (!row) throw new LifecycleError('effect_blocked');
    return validated('automation-context', JSON.parse(String(row.automation)));
  }
  sessionGuard(operationId: string) { return this.automationContext(operationId).sessionGuard; }
  protected refreshAutomation(runId: string, repairRequested = false): void {
    this.transaction(() => {
      const c = this.db.prepare('SELECT c.*,a.admitted_at FROM run_controls c LEFT JOIN run_admissions a ON a.run_id=c.run_id WHERE c.run_id=?').get(runId);
      if (!c) return;
      const anchor = c.budget_anchor ?? c.admitted_at;
      const reason = (c.repairs as number) >= (c.max_repairs as number) && ((c.repairs as number) > 0 || repairRequested) ? 'repair_budget' :
        anchor && Date.parse(this.clock.now()) - Date.parse(String(anchor)) >= (c.unattended_ms as number) ? 'unattended_timeout' : null;
      if (reason && !c.budget_hold) {
        this.db.prepare('UPDATE run_controls SET budget_hold=? WHERE run_id=?').run(reason, runId);
        this.db.prepare('INSERT INTO execution_log(operation_id,at,kind,payload) VALUES (NULL,?,?,?)')
          .run(this.clock.now(), 'budget_hold', JSON.stringify(diagnosticEvent(reason, this.clock.now(), runId)));
      }
    });
  }
  protected assertAutomation(operationId: string, atomicGuards?: boolean): void {
    const op = this.get('operation', operationId), automation = this.automationContext(operationId);
    const control = this.db.prepare('SELECT * FROM run_controls WHERE run_id=?').get(op.runId);
    if (!control || control.human_hold || control.budget_hold ||
      this.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND state='outcome_unknown' AND id!=?").get(op.runId, op.id))
      throw new LifecycleError('effect_blocked');
    if (automation.repair && (control.repairs as number) >= (control.max_repairs as number)) throw new LifecycleError('effect_blocked');
    const guard = automation.sessionGuard;
    if (guard) {
      const session = this.get('session', guard.enrollmentId);
      if (session.runId !== op.runId || session.workspaceId !== op.workspaceId || session.sessionId !== guard.sessionId)
        throw new LifecycleError('identity_conflict');
      if (session.owner !== 'automation' || session.state !== 'ready' || session.lastTurnId !== guard.expectedLastTurnId ||
        session.humanActivityRevision !== guard.expectedHumanActivityRevision) throw new LifecycleError('stale_revision');
      if (atomicGuards === false) throw new LifecycleError('unsupported_capability');
      if (this.db.prepare(`SELECT 1 FROM claims c JOIN operation_scheduling s ON s.operation_id=c.operation_id
        WHERE c.active=1 AND c.operation_id!=? AND json_extract(s.automation,'$.sessionGuard.enrollmentId')=?`).get(op.id, guard.enrollmentId))
        throw new LifecycleError('resource_busy');
    }
  }
  protected countRepair(operationId: string): void {
    if (this.automationContext(operationId).repair) {
      this.db.prepare('UPDATE run_controls SET repairs=repairs+1 WHERE run_id=?').run(this.get('operation', operationId).runId);
    }
  }
  protected recordRepairResult(operationId: string, status: string): void {
    const op = this.get('operation', operationId), repair = this.automationContext(operationId).repair;
    if (!repair || !['succeeded','failed','cancelled'].includes(status)) return;
    const fingerprint = JSON.stringify([op.request.source.sha, repair.failureFingerprint]);
    const c = this.db.prepare('SELECT last_failure,failure_count FROM run_controls WHERE run_id=?').get(op.runId)!;
    const count = status === 'failed' ? (c.last_failure === fingerprint ? Number(c.failure_count) + 1 : 1) : 0;
    this.db.prepare(`UPDATE run_controls SET last_failure=?,failure_count=?,budget_hold=CASE WHEN ?>=2 THEN 'repeated_failure' ELSE budget_hold END WHERE run_id=?`)
      .run(status === 'failed' ? fingerprint : null, count, count, op.runId);
  }
  updateRunBudget(input: RunBudget, context: AuditContext, authority?: LocalPolicyAuthority): void {
    const budget = validated('run-budget', input), safe = controlContext(context);
    this.assertControlAuthority(budget.runId, authority);
    this.transaction(() => {
      const payload = JSON.stringify({ budget, context: safe });
      const old = this.db.prepare('SELECT payload FROM control_requests WHERE id=?').get(budget.id);
      if (old) { if (old.payload !== payload) throw new LifecycleError('identity_conflict'); return; }
      const run = this.get('run', budget.runId);
      if (run.revision !== budget.expectedRevision) throw new LifecycleError('revision_conflict');
      if (['completed','failed','cancelled'].includes(run.state)) throw new LifecycleError('invalid_transition');
      if (!this.db.prepare('SELECT 1 FROM run_controls WHERE run_id=?').get(run.id)) throw new LifecycleError('effect_blocked');
      this.db.prepare('INSERT INTO control_requests VALUES (?,?,?)').run(budget.id, run.id, payload);
      // Explicit policy renewal retains total repairs; ordinary resume never renews either budget.
      this.db.prepare('UPDATE run_controls SET max_repairs=?,unattended_ms=?,budget_anchor=?,budget_hold=NULL,failure_count=0,last_failure=NULL WHERE run_id=?')
        .run(budget.maxRepairs, budget.unattendedMs, this.clock.now(), run.id);
      this.write([{ expectedRevision: run.revision, record: { ...run, revision: run.revision + 1, updatedAt: this.clock.now() } }], safe);
      this.db.prepare('INSERT INTO execution_log(operation_id,at,kind,payload) VALUES (NULL,?,?,?)').run(this.clock.now(), 'budget_policy', payload);
    });
  }
}
