import type { SessionStore } from '../storage-sqlite/sessions.ts';
import type { SessionHandoff } from '../../contracts/generated/session-handoff.ts';
import type { AuditContext, RecordOf } from './lifecycle.ts';
import type { SessionProvider, SessionRequest } from './sessions.ts';
import type { Profile } from '../extensions/loader.ts';
import { LifecycleError } from './lifecycle.ts';
import { randomUUID } from 'node:crypto';

export function pinnedSessionObserver(store: SessionStore, resolve: (profile: Profile) => Promise<SessionProvider>) {
  return { async observe(session: RecordOf<'session'>) {
    const binding = store.binding(session.id);
    // A delayed close reply can detach during recovery. Independent reads may
    // confirm that closed identity; detachment never grants command authority.
    if (binding.status !== 'attached' && session.state !== 'closed') throw new LifecycleError('effect_blocked');
    const instance = await resolve(store.profile(session.runId, session.providerId));
    if (instance.backendIdentity !== binding.backendIdentity) throw new LifecycleError('identity_conflict');
    const request: SessionRequest = { schemaVersion: '1.0', operationId: `read:${randomUUID()}`, workspaceId: session.workspaceId,
      providerId: session.providerId, command: 'observe', sessionId: session.sessionId, expectedLastTurnId: session.lastTurnId,
      expectedHumanActivityRevision: session.humanActivityRevision, input: {} };
    const reply = await instance.invoke(request);
    if (reply.outcome !== 'ok') throw new LifecycleError('recovery_required');
    return reply.observation;
  } };
}
export async function handoffSession(store: SessionStore, request: SessionHandoff,
  resolve: (profile: Profile) => Promise<SessionProvider>, authorization: AuditContext) {
  const session = store.get('session', request.enrollmentId);
  const instance = await resolve(store.profile(session.runId, session.providerId));
  if (!instance.atomicSessionGuards) throw new LifecycleError('unsupported_capability');
  const observation = await pinnedSessionObserver(store, resolve).observe(session);
  store.completeSessionHandoff(request, observation, authorization);
}
