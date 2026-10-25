import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readStatus } from './inspection.ts';
import { validated } from '../storage-sqlite/validation.ts';
import type { OperationalMetricSnapshotV1 } from '../../contracts/generated/operational-metrics.ts';

export function operationalMetrics(directory: string, installationId: string, at = new Date().toISOString()): OperationalMetricSnapshotV1 {
  readStatus(directory, installationId);
  const db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const count = (sql: string) => Number(db.prepare(sql).get()!.n);
    const oldest = db.prepare("SELECT min(json_extract(payload,'$.createdAt')) AS at FROM runs WHERE state='queued'").get()!.at;
    const durations = db.prepare(`SELECT l.at AS started,o.state,json_extract(o.payload,'$.updatedAt') AS ended
      FROM operations o JOIN execution_log l ON l.operation_id=o.id AND l.kind='effect_boundary'`).all()
      .map(row => Math.max(0, Date.parse(['succeeded','failed','cancelled','superseded'].includes(String(row.state)) ? String(row.ended) : at) - Date.parse(String(row.started))));
    const stale = Number(db.prepare(`SELECT count(*) AS n FROM claims c JOIN operations o ON o.id=c.operation_id
      WHERE c.active=1 AND json_extract(o.payload,'$.request.deadline')<=?`).get(at)!.n);
    const result = validated<OperationalMetricSnapshotV1>('operational-metrics', {
      schemaVersion: '1.0', at, queueAgeMs: oldest ? Math.max(0, Date.parse(at) - Date.parse(String(oldest))) : 0,
      activeWorkspaces: count("SELECT count(*) AS n FROM workspaces WHERE state!='deleted'"),
      actionCount: durations.length, actionDurationTotalMs: durations.reduce((a,b) => a+b, 0), actionDurationMaxMs: durations.reduce((a,b) => Math.max(a,b), 0),
      unknownOutcomes: count("SELECT count(*) AS n FROM operations WHERE state='outcome_unknown'"),
      failedReconciliation: count("SELECT count(*) AS n FROM deliveries WHERE attempts>0 AND state IN ('reconcile','blocked')"),
      projectionPending: count("SELECT count(*) AS n FROM deliveries WHERE projection_id IS NOT NULL AND state IN ('pending','reconcile')"),
      projectionBlocked: count("SELECT count(*) AS n FROM deliveries WHERE projection_id IS NOT NULL AND state='blocked'"),
      projectionConflicts: count("SELECT count(*) AS n FROM deliveries WHERE projection_id IS NOT NULL AND state='conflict'"),
      staleLeases: stale, repairAttempts: count('SELECT coalesce(sum(repairs),0) AS n FROM run_controls'),
      budgetHolds: count('SELECT count(*) AS n FROM run_controls WHERE budget_hold IS NOT NULL'),
      cleanupBlockers: count("SELECT count(*) AS n FROM cleanup_requests WHERE state IN ('blocked','retained','outcome_unknown')"),
    });
    db.exec('COMMIT'); return result;
  } finally { db.close(); }
}
