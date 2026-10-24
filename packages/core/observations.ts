import type { LabstrideHookObservation } from '../../contracts/generated/hook-observation.ts';
import type { LabstrideSessionObservationV1 } from '../../contracts/generated/session-observation.ts';
import type { ProjectionObservation } from '../../contracts/generated/projection-observation.ts';
import type { AuditContext, RecordOf } from './lifecycle.ts';
import type { Delivery, RetryPolicy } from './execution.ts';
import type { ProjectionWriteCapabilities } from '../../contracts/generated/projection-capabilities.ts';
export type Hook = LabstrideHookObservation;
export type SessionObservation = LabstrideSessionObservationV1;
export type ProjectionView = ProjectionObservation;
export interface SessionPoll { sessionId: string; revision: number; nextAt: string; attempts: number; blocked: boolean }
export interface SessionObserver { observe(session: RecordOf<'session'>): Promise<SessionObservation> }
export interface ProjectionAdapter {
  capabilities?: ProjectionWriteCapabilities;
  /** Legacy atomic adapters remain compatible. New adapters declare capabilities. */
  atomicPrecondition?: boolean;
  read(projection: RecordOf<'projection'>, token: string | null): Promise<ProjectionView>;
  // Atomic mode binds generation AND version. Checked mode declares its weaker
  // pre-read/write/readback guarantee and never invents durable write identity.
  write(projection: RecordOf<'projection'>, token: string): Promise<ProjectionView>;
}
export interface ObservationPort {
  recoveryEpoch(): number;
  projectionAllowed(runId: string): boolean;
  get<K extends import('./lifecycle.ts').Kind>(kind: K, id: string): RecordOf<K>;
  receiveHook(enrollmentId: string, hook: Hook): import('../../contracts/generated/hook-ack.ts').LabstrideHookAcknowledgement;
  bootObservations(): void;
  dueSessions(): SessionPoll[];
  applySession(poll: SessionPoll, expectedRevision: number, observation: SessionObservation, intervalMs: number, projections?: RecordOf<'projection'>[], observedEpoch?: number): void;
  retrySession(poll: SessionPoll, policy: RetryPolicy, random: number): void;
  dueProjections(): Delivery[];
  delivery(id: string): Delivery;
  projectionToken(id: string): string | null;
  inspectProjection(id: string, expectedRevision: number, view: ProjectionView, observedEpoch?: number): 'write' | 'wait' | 'finished';
  beginProjection(id: string, expectedRevision: number, view: ProjectionView, mode?: 'atomic'|'checked'): string;
  acknowledgeProjection(id: string, token: string, view: ProjectionView): void;
  projectionNotApplied(id: string, token: string): void;
  retryRead(id: string, policy: RetryPolicy, random: number): void;
  block(id: string, code: string): void;
  resumeObservation(id: string, context: AuditContext): void;
}
