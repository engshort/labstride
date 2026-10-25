import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Installation } from './installation.ts';
import type { DiagnosticRetentionResultV1 } from '../../contracts/generated/retention-result.ts';
import { validated } from '../storage-sqlite/validation.ts';
import { acquireServiceLock } from './loop.ts';
import { readStatus } from './inspection.ts';
import { verifySchema } from '../storage-sqlite/migrations.ts';

// No provider, target, transcript, workspace or recovery record is removed here.
export async function retainDiagnostics(spec: Installation, mode: 'dry-run' | 'apply', options: { at?: string; beforeCommit?: () => void } = {}): Promise<DiagnosticRetentionResultV1> {
  const days = spec.configuration.limits.metadataRetentionDays;
  const at = options.at ?? new Date().toISOString();
  if (!['dry-run','apply'].includes(mode) || !Number.isSafeInteger(days) || days < 1 || !Number.isFinite(Date.parse(at))) throw Error('configuration_invalid');
  const cutoffDate = new Date(Date.parse(at) - days * 86400000);
  if (!Number.isFinite(cutoffDate.getTime())) throw Error('configuration_invalid');
  const cutoff = cutoffDate.toISOString();
  readStatus(spec.stateDirectory, spec.configuration.installationId);
  const release = await acquireServiceLock(spec.stateDirectory);
  try {
    const db = new DatabaseSync(join(spec.stateDirectory, 'state.sqlite'), { readOnly: mode === 'dry-run', timeout: 5000 });
    try {
      verifySchema(db);
      db.exec(mode === 'apply' ? 'PRAGMA synchronous=FULL; BEGIN IMMEDIATE' : 'BEGIN');
      try {
        if (db.prepare('SELECT paused FROM recovery_control').get()!.paused) throw Error('recovery_required');
        const query = `SELECT d.sequence FROM retention_diagnostics d JOIN runs r ON r.id=d.run_id
          WHERE d.at<? AND json_extract(r.payload,'$.updatedAt')<?`;
        const eligible = Number(db.prepare(`SELECT count(*) AS n FROM (${query})`).get(cutoff,cutoff)!.n);
        const rows = db.prepare(`${query} ORDER BY d.sequence LIMIT 500`).all(cutoff,cutoff);
        const blockers: Array<DiagnosticRetentionResultV1['blockers'][number]> = [];
        if (db.prepare('SELECT 1 FROM runs WHERE id NOT IN (SELECT id FROM retention_resolved_runs) LIMIT 1').get()) blockers.push('active_or_unresolved');
        if (db.prepare("SELECT 1 FROM workspaces WHERE state!='deleted' OR json_extract(payload,'$.keep')=1 UNION ALL SELECT 1 FROM resources WHERE json_extract(payload,'$.resourceType')!='source-checkout' LIMIT 1").get()) blockers.push('retained_resource');
        if (db.prepare('SELECT 1 FROM retention_diagnostics d JOIN runs r ON r.id=d.run_id WHERE d.at>=? OR json_extract(r.payload,\'$.updatedAt\')>=? LIMIT 1').get(cutoff,cutoff)) blockers.push('recent_metadata');
        if (db.prepare("SELECT 1 FROM execution_log WHERE kind NOT IN ('observation','retry_scheduled') LIMIT 1").get()) blockers.push('recovery_evidence');
        const result = validated('retention-result', { schemaVersion: '1.0', at, cutoff, mode,
          eligible, deleted: mode === 'apply' ? rows.length : 0, remaining: eligible - (mode === 'apply' ? rows.length : 0), batchLimit: 500, blockers }) as DiagnosticRetentionResultV1;
        if (mode === 'apply') {
          // The deletion trigger independently rechecks the same eligibility.
          for (const row of rows) {
            db.prepare('INSERT INTO retention_candidates VALUES (?,?)').run(row.sequence,cutoff);
            db.prepare('DELETE FROM execution_log WHERE sequence=?').run(row.sequence);
            db.prepare('DELETE FROM retention_candidates WHERE sequence=?').run(row.sequence);
          }
          db.prepare('INSERT INTO retention_batches VALUES (?,?)').run(randomUUID(), JSON.stringify(result));
          options.beforeCommit?.();
        }
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  } finally { await release(); }
}
