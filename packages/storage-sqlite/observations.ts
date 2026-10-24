import { ExecutionStore, digest, recoveryContext } from './execution.ts';
import { validated } from './validation.ts';
import { LifecycleError } from '../core/lifecycle.ts';
import type { RecordOf, AuditContext } from '../core/lifecycle.ts';
import type { Delivery, RetryPolicy, InboxInput } from '../core/execution.ts';
import type { Hook, ObservationPort, ProjectionView, SessionObservation, SessionPoll } from '../core/observations.ts';
import type { LabstrideHookAcknowledgement } from '../../contracts/generated/hook-ack.ts';
import { same } from '../configuration/values.ts';
import type { LocalPolicyAuthority } from '../core/policy.ts';

export class ObservationStore extends ExecutionStore implements ObservationPort {
  private currentGeneration(runId: string): boolean {
    const run = this.get('run', runId), request = this.get('request', run.requestId);
    return this.db.prepare('SELECT max(generation) AS generation FROM requests WHERE installation_id=? AND provider_id=? AND issue_id=?')
      .get(request.installationId, request.providerId, request.issueId)!.generation === request.generation;
  }
  receiveHook(enrollmentId: string, input: Hook): LabstrideHookAcknowledgement {
    const hook = validated('hook-observation', input);
    return this.transaction(() => {
      const session = this.get('session', enrollmentId), run = this.get('run', session.runId), request = this.get('request', run.requestId);
      if (session.providerId !== hook.providerId || session.sessionId !== hook.sessionId || session.runId !== hook.runId ||
        session.workspaceId !== hook.workspaceId || request.generation !== hook.requestGeneration || !this.currentGeneration(run.id))
        throw new LifecycleError('identity_conflict');
      const input = validated<InboxInput>('execution-inbox', { schemaVersion: '1.0', stream: `session:${session.id}`, checkpoint: null, event: {
        schemaVersion: '1.0', eventId: hook.eventId, installationId: request.installationId, provider: session.providerId,
        externalId: hook.eventId, subjectId: session.sessionId, actorId: session.providerId, kind: 'session.observation', origin: 'extension',
        occurredAt: hook.occurredAt, observedAt: this.clock.now(), sourceVersion: hook.sourceVersion, facts: { ...hook },
      } });
      const receipt = this.receiveInside(input);
      if (!receipt.duplicate) {
        this.db.prepare('UPDATE inbox SET session_record_id=? WHERE id=?').run(session.id, receipt.id);
        this.db.prepare(`INSERT INTO session_polls(session_record_id,next_at) VALUES (?,?) ON CONFLICT(session_record_id)
          DO UPDATE SET revision=revision+1,next_at=excluded.next_at`).run(session.id, this.clock.now());
      }
      return validated('hook-ack', { schemaVersion: '1.0', eventId: hook.eventId, outcome: receipt.duplicate ? 'duplicate' : 'accepted',
        persistence: 'durable', observationId: receipt.id, error: null } as LabstrideHookAcknowledgement);
    });
  }
  bootObservations(): void {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO session_polls(session_record_id,next_at) SELECT id,? FROM sessions WHERE true
        ON CONFLICT(session_record_id) DO UPDATE SET next_at=excluded.next_at,revision=revision+1 WHERE blocked=0`).run(this.clock.now());
    });
  }
  dueSessions(): SessionPoll[] {
    this.db.prepare('INSERT OR IGNORE INTO session_polls(session_record_id,next_at) SELECT id,? FROM sessions').run(this.clock.now());
    return this.db.prepare(`SELECT * FROM session_polls WHERE (blocked=0 OR EXISTS
      (SELECT 1 FROM restore_observation_checks c WHERE c.kind='session' AND c.id=session_polls.session_record_id AND c.resolved=0))
      AND next_at<=? ORDER BY rowid LIMIT 64`).all(this.clock.now())
      .map(row => ({ sessionId: String(row.session_record_id), revision: Number(row.revision), nextAt: String(row.next_at), attempts: Number(row.attempts), blocked: !!row.blocked }));
  }
  applySession(poll: SessionPoll, expectedRevision: number, input: SessionObservation, intervalMs: number, projections: RecordOf<'projection'>[] = [], observedEpoch?: number): void {
    const observation = validated('session-observation', input);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 86400000) throw new LifecycleError('invalid_payload');
    this.transaction(() => {
      if (observedEpoch !== undefined && observedEpoch !== this.recoveryEpoch()) throw new LifecycleError('revision_conflict');
      const queued = this.db.prepare('SELECT revision FROM session_polls WHERE session_record_id=?').get(poll.sessionId);
      const session = this.get('session', poll.sessionId);
      if (!queued || queued.revision !== poll.revision || session.revision !== expectedRevision) throw new LifecycleError('revision_conflict');
      if (session.providerId !== observation.providerId || session.sessionId !== observation.sessionId ||
        session.workspaceId !== observation.workspaceId || !this.currentGeneration(session.runId) ||
        observation.humanActivityRevision < session.humanActivityRevision) throw new LifecycleError('identity_conflict');
      const changed = session.state !== observation.state || session.lastTurnId !== observation.lastTurnId || session.humanActivityRevision !== observation.humanActivityRevision;
      if (changed) this.write([{ expectedRevision, recovery: session.state === 'outcome_unknown' && observation.state !== session.state,
        record: { ...session, state: observation.state, lastTurnId: observation.lastTurnId, humanActivityRevision: observation.humanActivityRevision,
          owner: observation.humanActivityRevision > session.humanActivityRevision ? 'human' : session.owner,
          revision: expectedRevision + 1, updatedAt: this.clock.now() } }],
      { actorId: session.providerId, reason: 'Re-observed enrolled session; no run completion or continuation authority', evidenceRefs: observation.evidenceRefs });
      const run = this.get('run', session.runId), request = this.get('request', run.requestId);
      const received = this.receiveInside(validated<InboxInput>('execution-inbox', { schemaVersion: '1.0', stream: `session-read:${session.id}`, checkpoint: null, event: {
        schemaVersion: '1.0', eventId: `observation:${session.id}:${poll.revision}`, installationId: request.installationId,
        provider: session.providerId, externalId: `read:${session.id}:${poll.revision}`, subjectId: session.sessionId, actorId: session.providerId,
        kind: 'session.observed', origin: 'provider', occurredAt: this.clock.now(), observedAt: this.clock.now(),
        sourceVersion: digest(observation), facts: { ...observation },
      } }));
      this.db.prepare('UPDATE inbox SET processed=1,run_id=? WHERE id=? OR session_record_id=?').run(session.runId, received.id, session.id);
      if (projections.length && !this.recoveryStatus().paused) {
        if (projections.some(p => p.kind !== 'projection' || p.runId !== session.runId)) throw new LifecycleError('identity_conflict');
        this.write(projections.map(record => ({ record, expectedRevision: null })), { actorId: session.providerId, reason: 'Session progress projection', evidenceRefs: observation.evidenceRefs });
        for (const p of projections) this.enqueue('projection', p.id);
      }
      this.db.prepare('UPDATE session_polls SET revision=revision+1,attempts=0,next_at=? WHERE session_record_id=?')
        .run(new Date(Date.parse(this.clock.now()) + intervalMs).toISOString(), session.id);
      this.log(null, 'session_observation', { enrollmentId: session.id, observationId: received.id });
      if (observedEpoch === this.recoveryEpoch() && observation.state !== 'outcome_unknown' && observation.evidenceRefs.length) {
        this.db.prepare("UPDATE restore_observation_checks SET resolved=1 WHERE kind='session' AND id=? AND epoch=?").run(session.id, observedEpoch);
      }
    });
  }
  retrySession(poll: SessionPoll, policy: RetryPolicy, random: number): void {
    // Policy is validated by the worker before any adapter call.
    this.transaction(() => {
      const attempts = poll.attempts + 1;
      const delay = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(attempts - 1, 30)) * (0.5 + random * 0.5);
      const changed = this.db.prepare('UPDATE session_polls SET revision=revision+1,attempts=?,blocked=?,next_at=? WHERE session_record_id=? AND revision=?')
        .run(attempts, attempts >= policy.maxAttempts ? 1 : 0, new Date(Date.parse(this.clock.now()) + delay).toISOString(), poll.sessionId, poll.revision);
      if (Number(changed.changes)) this.log(null, 'session_observation_retry', { enrollmentId: poll.sessionId, attempts });
    });
  }
  resumeSessionObservation(sessionId: string, context: AuditContext): void {
    context = recoveryContext(context);
    this.transaction(() => {
      this.get('session', sessionId);
      this.db.prepare('UPDATE session_polls SET blocked=0,attempts=0,revision=revision+1,next_at=? WHERE session_record_id=?').run(this.clock.now(), sessionId);
      this.log(null, 'session_observation_resume', { sessionId, context });
    });
  }
  dueProjections(): Delivery[] {
    this.transaction(()=>{
      if (this.recoveryStatus().paused) return; // Each restored identity needs its own fresh read.
      const pending=this.db.prepare("SELECT d.projection_id FROM deliveries d LEFT JOIN projection_attempts a ON a.projection_id=d.projection_id WHERE d.state='pending' AND d.projection_id IS NOT NULL AND a.projection_id IS NULL ORDER BY d.rowid DESC").all();
      const seen=new Set<string>();
      for(const row of pending){
        const p=this.get('projection',String(row.projection_id)),key=JSON.stringify([p.providerId,p.subjectId,p.fieldId]);
        if(seen.has(key))this.db.prepare("UPDATE deliveries SET state='superseded',last_error='coalesced_unsent',revision=revision+1 WHERE projection_id=?").run(p.id);
        seen.add(key);
      }
    });
    return this.db.prepare(`SELECT id FROM deliveries WHERE projection_id IS NOT NULL AND
      (state IN ('pending','reconcile') OR EXISTS (SELECT 1 FROM restore_observation_checks c WHERE c.kind='projection' AND c.id=deliveries.projection_id AND c.resolved=0))
      AND next_at<=? ORDER BY rowid LIMIT 64`)
      .all(this.clock.now()).map(row => this.delivery(String(row.id)));
  }
  projectionToken(id: string): string | null {
    const row = this.db.prepare('SELECT token FROM projection_attempts WHERE projection_id=?').get(id);
    return row ? String(row.token) : null;
  }
  private projectionDecision(id: string, revision: number, input: ProjectionView): 'write' | 'wait' | 'finished' {
    const view = validated('projection-observation', input), projection = this.get('projection', id), delivery = this.delivery(`projection:${id}`);
    if (delivery.revision !== revision) throw new LifecycleError('revision_conflict');
    if (!['pending','reconcile'].includes(delivery.state)) return 'finished';
    if (view.providerId !== projection.providerId || view.subjectId !== projection.subjectId || view.fieldId !== projection.fieldId)
      throw new LifecycleError('identity_conflict');
    const finish = (state: Delivery['state'], reason: string) => {
      this.db.prepare('UPDATE deliveries SET state=?,last_error=?,revision=revision+1 WHERE id=?').run(state, reason, delivery.id);
      this.log(null, 'projection_observation', { projectionId: id, state, reason }); return 'finished' as const;
    };
    const conflict=(reason:string)=>{
      this.db.prepare('INSERT OR IGNORE INTO projection_holds VALUES (?,?,?,?)').run(projection.providerId,projection.subjectId,projection.fieldId,reason);
      return finish('conflict',reason);
    };
    const attempt = this.db.prepare('SELECT * FROM projection_attempts WHERE projection_id=?').get(id);
    if(attempt?.mode==='checked'&&attempt.state==='started'){
      if(attempt.acknowledged&&attempt.observed_version===view.version&&same(view.value,projection.payload.value)){
        this.db.prepare("UPDATE projection_attempts SET state='applied' WHERE projection_id=?").run(id);
        return finish('done','acknowledged_and_observed');
      }
      if(attempt.acknowledged&&attempt.observed_version!==view.version){
        this.db.prepare("UPDATE projection_attempts SET state='applied' WHERE projection_id=?").run(id);
        return conflict('projection_conflict');
      }
      // Desired state without a durable acknowledgement is not proof of our
      // write. Retain the original unknown attempt and do not replay it.
      if(!same(view.value,projection.payload.value)&&view.version!==projection.payload.expectedFingerprint)return conflict('projection_conflict');
      return 'wait';
    }
    if (attempt && view.appliedToken === attempt.token && same(view.value, projection.payload.value)) {
      this.db.prepare("UPDATE projection_attempts SET state='applied' WHERE projection_id=?").run(id);
      return finish('done', 'observed_applied');
    }
    if (!this.currentGeneration(projection.runId) || view.generation > projection.generation) return finish('superseded', 'newer_generation');
    if (view.generation !== projection.generation) return conflict('generation_conflict');
    if (view.version !== projection.payload.expectedFingerprint) return conflict('human_or_provider_change');
    if (attempt?.state === 'started') return 'wait';
    if(this.db.prepare('SELECT 1 FROM projection_holds WHERE provider_id=? AND subject_id=? AND field_id=?').get(projection.providerId,projection.subjectId,projection.fieldId))return conflict('projection_conflict');
    if (same(view.value, projection.payload.value)) return finish('done', 'already_matches');
    if (!this.projectionAllowed(projection.runId)) return 'wait';
    return 'write';
  }
  inspectProjection(id: string, expectedRevision: number, view: ProjectionView, observedEpoch?: number): 'write' | 'wait' | 'finished' {
    return this.transaction(() => {
      if (observedEpoch !== undefined && observedEpoch !== this.recoveryEpoch()) throw new LifecycleError('revision_conflict');
      const checked = validated('projection-observation', view), projection = this.get('projection', id);
      if (checked.providerId !== projection.providerId || checked.subjectId !== projection.subjectId || checked.fieldId !== projection.fieldId ||
        this.delivery(`projection:${id}`).revision !== expectedRevision) throw new LifecycleError('identity_conflict');
      const result = this.projectionDecision(id, expectedRevision, checked);
      const uncertain = this.db.prepare("SELECT 1 FROM projection_attempts WHERE projection_id=? AND state='started'").get(id);
      if (!uncertain && observedEpoch === this.recoveryEpoch()) this.db.prepare("UPDATE restore_observation_checks SET resolved=1 WHERE kind='projection' AND id=? AND epoch=?").run(id, observedEpoch);
      return result;
    });
  }
  beginProjection(id: string, expectedRevision: number, view: ProjectionView,mode:'atomic'|'checked'='atomic'): string {
    return this.transaction(() => {
      if(!['atomic','checked'].includes(mode))throw new LifecycleError('invalid_payload');
      if (this.projectionDecision(id, expectedRevision, view) !== 'write') throw new LifecycleError('effect_blocked');
      const projection=this.get('projection',id);
      for(const row of this.db.prepare("SELECT projection_id FROM projection_attempts WHERE state='started' AND projection_id!=?").all(id)){
        const other=this.get('projection',String(row.projection_id));
        if(other.providerId===projection.providerId&&other.subjectId===projection.subjectId&&other.fieldId===projection.fieldId)throw new LifecycleError('effect_blocked');
      }
      const token = this.projectionToken(id) ?? this.identities.next();
      this.db.prepare("INSERT INTO projection_attempts(projection_id,token,state,mode) VALUES (?,?,'started',?) ON CONFLICT(projection_id) DO UPDATE SET state='started',mode=excluded.mode,acknowledged=0,observed_version=NULL").run(id, token,mode);
      this.db.prepare("UPDATE deliveries SET state='reconcile',revision=revision+1 WHERE projection_id=?").run(id);
      this.log(null, 'projection_effect_boundary', { projectionId: id, token });
      return token;
    });
  }
  acknowledgeProjection(id:string,token:string,input:ProjectionView):void{
    const view=validated('projection-observation',input);
    this.transaction(()=>{
      const projection=this.get('projection',id);
      if(view.providerId!==projection.providerId||view.subjectId!==projection.subjectId||view.fieldId!==projection.fieldId||view.generation!==projection.generation||!same(view.value,projection.payload.value))throw new LifecycleError('identity_conflict');
      const result=this.db.prepare("UPDATE projection_attempts SET acknowledged=1,observed_version=? WHERE projection_id=? AND token=? AND state='started' AND mode='checked'").run(view.version,id,token);
      if(!result.changes)throw new LifecycleError('revision_conflict');
      this.log(null,'projection_acknowledged',{projectionId:id,token,version:view.version});
    });
  }
  projectionDiagnostics():{projectionId:string;state:string;reason:string|null;uncertain:boolean}[]{
    return this.db.prepare('SELECT d.projection_id,d.state,d.last_error,a.state AS attempt_state FROM deliveries d LEFT JOIN projection_attempts a ON a.projection_id=d.projection_id WHERE d.projection_id IS NOT NULL').all()
      .map(row=>({projectionId:String(row.projection_id),state:String(row.state),reason:row.last_error as string|null,uncertain:row.attempt_state==='started'}));
  }
  clearProjectionConflict(id:string,context:AuditContext,authority?:LocalPolicyAuthority):void{
    context=recoveryContext(context);
    this.transaction(()=>{
      const p=this.get('projection',id);this.assertControlAuthority(p.runId,authority);
      // Unknown attempts must be reconciled, not released by clearing a warning.
      for(const row of this.db.prepare("SELECT projection_id FROM projection_attempts WHERE state='started'").all()){
        const other=this.get('projection',String(row.projection_id));
        if(other.providerId===p.providerId&&other.subjectId===p.subjectId&&other.fieldId===p.fieldId)throw new LifecycleError('recovery_required');
      }
      this.db.prepare('DELETE FROM projection_holds WHERE provider_id=? AND subject_id=? AND field_id=?').run(p.providerId,p.subjectId,p.fieldId);
      this.log(null,'projection_conflict_cleared',{projectionId:id,context});
    });
  }
  projectionNotApplied(id: string, token: string): void {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE projection_attempts SET state='not_applied' WHERE projection_id=? AND token=? AND state='started'").run(id,token);
      if (!Number(result.changes)) throw new LifecycleError('revision_conflict');
      this.log(null, 'projection_proven_pre_effect_failure', { projectionId: id, token });
    });
  }
}
