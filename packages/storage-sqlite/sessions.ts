import { ObservationStore } from './observations.ts';
import { canonical, digest, recoveryContext } from './execution.ts';
import { validated } from './validation.ts';
import { LifecycleError } from '../core/lifecycle.ts';
import type { AuditContext } from '../core/lifecycle.ts';
import type { Profile } from '../extensions/loader.ts';
import { sessionAction, sessionActionVersion } from '../core/sessions.ts';
import type { SessionCommand, SessionReply } from '../core/sessions.ts';
import type { SessionBinding } from '../../contracts/generated/session-binding.ts';
import type { SessionHandoff } from '../../contracts/generated/session-handoff.ts';
import type { SessionObservation } from '../core/observations.ts';

export class SessionStore extends ObservationStore {
  override receiveHook(enrollmentId: string, hook: Parameters<ObservationStore['receiveHook']>[1]) {
    if (this.db.prepare('SELECT 1 FROM session_bindings WHERE enrollment_id=?').get(enrollmentId)) {
      const binding = this.binding(enrollmentId);
      if (binding.status !== 'attached' || !this.profile(binding.runId, binding.providerId).capabilities.includes('session.hooks.v1'))
        throw new LifecycleError('unsupported_capability');
    }
    return super.receiveHook(enrollmentId, hook);
  }
  completeSessionHandoff(input: SessionHandoff, inputObservation: SessionObservation, authorization: AuditContext): void {
    const request = validated('session-handoff', input), observation = validated('session-observation', inputObservation);
    const context = recoveryContext(authorization);
    this.transaction(() => {
      const contents = canonical({ request, context }), old = this.db.prepare('SELECT payload FROM session_handoffs WHERE id=?').get(request.id);
      if (old) { if (old.payload !== contents) throw new LifecycleError('identity_conflict'); return; }
      const run = this.get('run', request.runId), session = this.get('session', request.enrollmentId), binding = this.binding(session.id);
      const profile = this.profile(run.id, session.providerId);
      if (!profile.capabilities.includes('session.atomic-guards.v1')) throw new LifecycleError('unsupported_capability');
      if (session.runId !== run.id || binding.status !== 'attached' || observation.sessionId !== session.sessionId ||
        observation.providerId !== session.providerId || observation.workspaceId !== session.workspaceId) throw new LifecycleError('identity_conflict');
      if (run.revision !== request.expectedRunRevision || session.revision !== request.expectedSessionRevision ||
        session.state !== 'ready' || observation.state !== 'ready' || session.lastTurnId !== request.expectedLastTurnId ||
        observation.lastTurnId !== request.expectedLastTurnId || session.humanActivityRevision !== request.expectedHumanActivityRevision ||
        observation.humanActivityRevision !== request.expectedHumanActivityRevision) throw new LifecycleError('stale_revision');
      if (this.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled','superseded')").get(run.id)) throw new LifecycleError('effect_blocked');
      this.write([{ expectedRevision: session.revision, record: { ...session, owner: 'automation', revision: session.revision + 1, updatedAt: this.clock.now() } }], context);
      this.write([{ expectedRevision: run.revision, record: { ...run, revision: run.revision + 1, updatedAt: this.clock.now() } }], context);
      this.db.prepare('UPDATE run_controls SET human_hold=0 WHERE run_id=?').run(run.id);
      this.db.prepare('INSERT INTO session_handoffs VALUES (?,?)').run(request.id, contents);
      this.log(null, 'session_handoff', { request, context });
    });
  }
  pinProfile(input: Profile, authorization: AuditContext): string {
    const profile = validated('extension-profile', input), context = recoveryContext(authorization);
    return this.transaction(() => {
      const run = this.get('run', profile.runId);
      if (run.configRevision !== profile.configRevision || profile.pin.kind !== 'session-provider') throw new LifecycleError('identity_conflict');
      const hash = digest(profile), old = this.db.prepare('SELECT digest FROM extension_profiles WHERE run_id=? AND provider_id=?').get(run.id, profile.pin.id);
      if (old && old.digest !== hash) throw new LifecycleError('identity_conflict');
      this.db.prepare('INSERT OR IGNORE INTO extension_profiles VALUES (?,?,?,?)').run(run.id, profile.pin.id, hash, canonical(profile));
      if (!old) this.log(null, 'extension_profile', { runId: run.id, profileDigest: hash, context });
      return hash;
    });
  }
  profile(runId: string, providerId: string): Profile {
    const row = this.db.prepare('SELECT payload FROM extension_profiles WHERE run_id=? AND provider_id=?').get(runId, providerId);
    if (!row) throw new LifecycleError('not_found');
    return validated<Profile>('extension-profile', JSON.parse(String(row.payload)));
  }
  registerSessionCommand(operationId: string, input: SessionCommand, authorization: AuditContext): void {
    const context = recoveryContext(authorization);
    input = validated('session-command', input);
    const op = this.get('operation', operationId);
    const request = validated('session-request', input.request);
    const command: SessionCommand = { schemaVersion: '1.0', enrollmentId: input.enrollmentId, backendIdentity: input.backendIdentity,
      profileDigest: input.profileDigest, request };
    if (!command.enrollmentId || !command.backendIdentity || canonical(input) !== canonical(command) ||
      op.request.actionId !== sessionAction || op.request.actionVersion !== sessionActionVersion ||
      canonical(op.request.inputs) !== canonical({ sessionCommand: command }) || request.operationId !== op.id || request.workspaceId !== op.workspaceId)
      throw new LifecycleError('identity_conflict');
    const profile = this.profile(op.runId, request.providerId);
    if (digest(profile) !== command.profileDigest) throw new LifecycleError('identity_conflict');
    this.transaction(() => {
      const old = this.db.prepare('SELECT payload FROM session_commands WHERE operation_id=?').get(operationId);
      if (old) { if (old.payload !== canonical(command)) throw new LifecycleError('identity_conflict'); return; }
      if (this.get('operation', operationId).state !== 'prepared') throw new LifecycleError('effect_blocked');
      if (request.command === 'start' && this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(command.enrollmentId))
        throw new LifecycleError('identity_conflict');
      if (request.command !== 'start') {
        const binding = this.binding(command.enrollmentId);
        if (binding.status !== 'attached' || binding.runId !== op.runId || binding.workspaceId !== op.workspaceId ||
          binding.providerId !== request.providerId || binding.sessionId !== request.sessionId ||
          binding.backendIdentity !== command.backendIdentity || binding.profileDigest !== command.profileDigest) throw new LifecycleError('identity_conflict');
      }
      this.db.prepare('INSERT INTO session_commands VALUES (?,?,NULL)').run(operationId, canonical(command));
      this.log(operationId, 'session_intent', { enrollmentId: command.enrollmentId, command: request.command, digest: digest(command), context });
    });
  }
  command(operationId: string): SessionCommand {
    const row = this.db.prepare('SELECT payload FROM session_commands WHERE operation_id=?').get(operationId);
    if (!row) throw new LifecycleError('not_found');
    return validated<SessionCommand>('session-command', JSON.parse(String(row.payload)));
  }
  binding(enrollmentId: string): SessionBinding {
    const row = this.db.prepare('SELECT payload FROM session_bindings WHERE enrollment_id=?').get(enrollmentId);
    if (!row) throw new LifecycleError('not_found');
    return validated<SessionBinding>('session-binding', JSON.parse(String(row.payload)));
  }
  protected override assertAutomation(operationId: string, atomicGuards?: boolean): void {
    const op = this.get('operation', operationId);
    if (op.request.actionId === sessionAction) {
      const command = this.command(operationId), request = command.request;
      const profile = this.profile(op.runId, request.providerId);
      if (digest(profile) !== command.profileDigest) throw new LifecycleError('identity_conflict');
      if (request.command === 'send') {
        const guard = this.sessionGuard(operationId);
        if (!guard || guard.enrollmentId !== command.enrollmentId || guard.sessionId !== request.sessionId ||
          guard.expectedLastTurnId !== request.expectedLastTurnId || guard.expectedHumanActivityRevision !== request.expectedHumanActivityRevision)
          throw new LifecycleError('stale_revision');
        const session = this.get('session', command.enrollmentId);
        if (session.lastTurnId !== request.expectedLastTurnId || session.humanActivityRevision !== request.expectedHumanActivityRevision)
          throw new LifecycleError('stale_revision');
        if (!profile.capabilities.includes('session.atomic-guards.v1')) throw new LifecycleError('unsupported_capability');
      }
    }
    super.assertAutomation(operationId, atomicGuards);
  }
  savedSessionReply(operationId: string): SessionReply | null {
    const row = this.db.prepare('SELECT response FROM session_commands WHERE operation_id=?').get(operationId);
    return row?.response ? JSON.parse(String(row.response)) as SessionReply : null;
  }
  recordSessionReply(operationId: string, reply: SessionReply): void {
    reply = validated('session-reply', reply);
    this.transaction(() => {
      const command = this.command(operationId), op = this.get('operation', operationId);
      const prior = this.savedSessionReply(operationId);
      if (prior && prior.outcome !== 'outcome_unknown') {
        if (canonical(prior) !== canonical(reply)) throw new LifecycleError('identity_conflict');
        return;
      }
      if (reply.outcome === 'ok') {
        const observation = validated('session-observation', reply.observation), req = command.request;
        if (!observation.evidenceRefs.length || observation.providerId !== req.providerId || observation.workspaceId !== op.workspaceId ||
          (req.command !== 'start' && observation.sessionId !== req.sessionId)) throw new LifecycleError('identity_conflict');
        let session;
        if (req.command === 'start') {
          const existing = this.db.prepare('SELECT payload FROM sessions WHERE id=?').get(command.enrollmentId);
          if (!existing) {
            session = { schemaVersion: '1.0' as const, kind: 'session' as const, id: command.enrollmentId, revision: 1,
              createdAt: this.clock.now(), updatedAt: this.clock.now(), runId: op.runId, workspaceId: op.workspaceId,
              providerId: req.providerId, sessionId: observation.sessionId, state: 'ready' as const,
              owner: 'human' as const, lastTurnId: observation.lastTurnId, humanActivityRevision: observation.humanActivityRevision };
            this.write([{ record: session, expectedRevision: null }], { actorId: req.providerId, reason: 'Enrolled original session', evidenceRefs: observation.evidenceRefs });
            const binding: SessionBinding = { schemaVersion: '1.0', enrollmentId: session.id, runId: op.runId, workspaceId: op.workspaceId,
              providerId: req.providerId, sessionId: observation.sessionId, backendIdentity: command.backendIdentity, profileDigest: command.profileDigest, status: 'attached' };
            this.db.prepare('INSERT INTO session_bindings VALUES (?,?,?,?)').run(session.id, op.runId, req.providerId, canonical(binding));
          } else {
            const binding = this.binding(command.enrollmentId);
            if (binding.sessionId !== observation.sessionId || binding.runId !== op.runId || binding.profileDigest !== command.profileDigest || binding.status !== 'attached')
              throw new LifecycleError('identity_conflict');
          }
        }
        session = this.get('session', command.enrollmentId);
        if (this.recoveryStatus().paused) {
          this.db.prepare("INSERT OR IGNORE INTO restore_observation_checks VALUES ('session',?,?,0)").run(session.id, this.recoveryEpoch());
        }
        if (session.state !== 'closed' && session.state !== 'failed') {
          this.db.prepare('INSERT OR IGNORE INTO session_polls(session_record_id,next_at) VALUES (?,?)').run(session.id, this.clock.now());
          const poll = this.db.prepare('SELECT revision,next_at,attempts,blocked FROM session_polls WHERE session_record_id=?').get(session.id)!;
          this.applySession({ sessionId: session.id, revision: Number(poll.revision), nextAt: String(poll.next_at),
            attempts: Number(poll.attempts), blocked: !!poll.blocked }, session.revision, observation, 60000);
        }
        if (req.command === 'close') {
          const binding = this.binding(command.enrollmentId);
          this.db.prepare('UPDATE session_bindings SET payload=? WHERE enrollment_id=?').run(canonical({ ...binding, status: 'detached' }), binding.enrollmentId);
          this.db.prepare('UPDATE session_polls SET blocked=1 WHERE session_record_id=?').run(binding.enrollmentId);
        }
      } else if (!['error', 'outcome_unknown'].includes(reply.outcome) || !reply.evidenceRefs?.length ||
        (reply.outcome === 'error' && !['stale_revision','unsupported_capability','identity_mismatch','validation_failed','forbidden'].includes(reply.code)))
        throw new LifecycleError('invalid_payload');
      this.db.prepare('UPDATE session_commands SET response=? WHERE operation_id=?').run(canonical(reply), operationId);
    });
  }
}
