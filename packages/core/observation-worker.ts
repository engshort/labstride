import { LifecycleError } from './lifecycle.ts';
import type { RecordOf } from './lifecycle.ts';
import { defaultRetryPolicy } from './execution.ts';
import type { ExecutionMode, RetryPolicy } from './execution.ts';
import type { ObservationPort, ProjectionAdapter, SessionObserver, SessionObservation } from './observations.ts';
import { PreEffectTransient } from './worker.ts';
import { validated } from '../storage-sqlite/validation.ts';
import type { ProjectionWriteCapabilities } from '../../contracts/generated/projection-capabilities.ts';
export interface ObservationOptions {
  mode?: ExecutionMode;
  sessions: ReadonlyMap<string, SessionObserver>;
  projections: ReadonlyMap<string, ProjectionAdapter>;
  sessionIntervalMs?: number; retry?: RetryPolicy; random?: () => number;
  sessionProjections?: (session: RecordOf<'session'>, observation: SessionObservation) => RecordOf<'projection'>[];
}
export function createObservationWorker(store: ObservationPort, options: ObservationOptions) {
  const policy = { ...(options.retry ?? defaultRetryPolicy) }, interval = options.sessionIntervalMs ?? 60000;
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 86400000 ||
    !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 100 ||
    !Number.isFinite(policy.baseMs) || policy.baseMs < 1 || !Number.isFinite(policy.capMs) || policy.capMs < policy.baseMs || policy.capMs > 86400000)
    throw new LifecycleError('invalid_payload');
  const sessions = new Map(options.sessions), projections = new Map(options.projections);
  const random = () => { const value = (options.random ?? Math.random)(); if (!Number.isFinite(value) || value < 0 || value > 1) throw new LifecycleError('invalid_payload'); return value; };
  store.bootObservations();
  let ticking = false;
  return {
    async tick(): Promise<void> {
      if (ticking) return; ticking = true;
      try {
        for (const poll of store.dueSessions()) {
          const observedEpoch = store.recoveryEpoch();
          const session = store.get('session', poll.sessionId), adapter = sessions.get(session.providerId);
          if (!adapter) { store.retrySession(poll, policy, random()); continue; }
          try {
            const observation = await adapter.observe(structuredClone(session));
            store.applySession(poll, session.revision, observation, interval, options.sessionProjections?.(session, observation), observedEpoch);
          } catch { store.retrySession(poll, policy, random()); }
        }
        for (const delivery of store.dueProjections()) {
          const observedEpoch = store.recoveryEpoch();
          const id = delivery.projectionId!, projection = store.get('projection', id), adapter = projections.get(projection.providerId);
          if (!adapter) { store.block(delivery.id, 'unsupported_capability'); continue; }
          try {
            const view = await adapter.read(structuredClone(projection), store.projectionToken(id));
            const decision = store.inspectProjection(id, delivery.revision, view, observedEpoch);
            if (decision === 'finished') continue;
            if (decision === 'wait') { if (store.projectionAllowed(projection.runId)) store.retryRead(delivery.id, policy, random()); continue; }
            if (options.mode === 'reconcile-only') continue;
            const capabilities = validated<ProjectionWriteCapabilities>('projection-capabilities',adapter.capabilities ?? {
              schemaVersion:'1.0',mode:adapter.atomicPrecondition?'atomic':'unsupported',durableWriteIdentity:!!adapter.atomicPrecondition,
            });
            if (capabilities.mode==='unsupported') { store.block(delivery.id, 'unsupported_capability'); continue; }
            const token = store.beginProjection(id, delivery.revision, view,capabilities.mode);
            try {
              const written=await adapter.write(structuredClone(projection), token);
              if(capabilities.mode==='checked')store.acknowledgeProjection(id,token,written);
            }
            catch (error) {
              if (error instanceof PreEffectTransient) store.projectionNotApplied(id, token);
              store.retryRead(delivery.id, policy, random());
              continue;
            }
            // Read failures after a returned write can never establish a pre-effect failure.
            const observed = await adapter.read(structuredClone(projection), token);
            if (store.inspectProjection(id, store.delivery(delivery.id).revision, observed, observedEpoch) === 'wait')
              store.retryRead(delivery.id, policy, random());
          } catch (error) {
            if (error instanceof LifecycleError && ['revision_conflict','effect_blocked'].includes(error.code)) continue;
            store.retryRead(delivery.id, policy, random());
          }
        }
      } finally { ticking = false; }
    },
  };
}
