import type { DatabaseSync } from 'node:sqlite';
import type { AuditContext } from '../core/lifecycle.ts';

// Caller owns a transaction, including the migration transaction on upgrade.
export function fenceRecovery(db: DatabaseSync, at: string, context: AuditContext): void {
  db.exec('UPDATE recovery_control SET paused=1,epoch=epoch+1 WHERE id=1');
  db.exec(`INSERT INTO restore_checks SELECT id,(SELECT epoch FROM recovery_control),0 FROM operations WHERE true
    ON CONFLICT(operation_id) DO UPDATE SET epoch=excluded.epoch,resolved=0`);
  db.prepare("UPDATE deliveries SET state='reconcile',attempts=0,next_at=?,revision=revision+1 WHERE operation_id IS NOT NULL AND state!='conflict'").run(at);
  db.exec(`UPDATE restore_observation_checks SET resolved=1;
    INSERT INTO restore_observation_checks SELECT 'session',s.id,(SELECT epoch FROM recovery_control),0 FROM sessions s
    WHERE NOT EXISTS (SELECT 1 FROM session_bindings b WHERE b.enrollment_id=s.id AND json_extract(b.payload,'$.status')='detached')
    ON CONFLICT(kind,id) DO UPDATE SET epoch=excluded.epoch,resolved=0;
    INSERT INTO restore_observation_checks SELECT 'projection',projection_id,(SELECT epoch FROM recovery_control),0 FROM deliveries
    WHERE projection_id IS NOT NULL AND state IN ('pending','reconcile','blocked','conflict')
    ON CONFLICT(kind,id) DO UPDATE SET epoch=excluded.epoch,resolved=0;`);
  db.prepare(`INSERT INTO session_polls(session_record_id,next_at) SELECT s.id,? FROM sessions s
    WHERE NOT EXISTS (SELECT 1 FROM session_bindings b WHERE b.enrollment_id=s.id AND json_extract(b.payload,'$.status')='detached')
    ON CONFLICT(session_record_id) DO UPDATE SET blocked=0,attempts=0,next_at=excluded.next_at,revision=revision+1`).run(at);
  db.prepare("UPDATE deliveries SET state='reconcile',attempts=0,next_at=?,revision=revision+1 WHERE projection_id IS NOT NULL AND state='blocked'").run(at);
  db.prepare("INSERT INTO execution_log(operation_id,at,kind,payload) VALUES (NULL,?,'restore_paused',?)").run(at, JSON.stringify(context));
}
