import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrivateDatabase, protectedPath } from '../target-helper/filesystem.ts';
import { canonical, digest } from '../configuration/json.ts';
import { validated } from '../storage-sqlite/validation.ts';
import type { ManagedCodingResultV1 } from '../../contracts/generated/managed-result.ts';
import type { BridgeBinding } from './bridge.ts';

/** Untrusted native result data, committed before the tool acknowledgement. */
export class ReportJournal {
  private db: DatabaseSync;
  private closed = false;
  constructor(stateDirectory: string) {
    protectedPath(stateDirectory);
    const directory = join(stateDirectory, 'managed-reports');
    try { mkdirSync(directory, { mode: 0o700, recursive: false }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.db = ReportJournal.open(directory);
  }
  private static open(directory: string): DatabaseSync {
    if (lstatSync(directory).uid !== process.getuid!()) throw Error('report_journal_unsafe');
    assertPrivateDatabase(directory, 'reports.sqlite');
    const path = join(directory, 'reports.sqlite'), fresh = !existsSync(path);
    if (fresh) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    const db = new DatabaseSync(path, { timeout: 5000 });
    try {
      db.exec('PRAGMA synchronous=FULL');
      if (fresh) db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE reports (binding TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          call_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), digest TEXT NOT NULL,
          PRIMARY KEY(binding,session_id,turn_id,call_id));
        PRAGMA user_version=1; COMMIT;`);
      if (db.prepare('PRAGMA user_version').get()!.user_version !== 1) throw Error('report_journal_version');
      db.exec(`CREATE TABLE IF NOT EXISTS checkout_sessions (
        session_id TEXT PRIMARY KEY, binding TEXT NOT NULL UNIQUE
      )`);
      return db;
    } catch (error) { db.close(); throw error; }
  }
  registerCheckoutSession(binding: BridgeBinding, sessionId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO checkout_sessions VALUES (?,?)').run(sessionId, digest(binding));
    this.verifyCheckoutSession(binding, sessionId);
  }
  verifyCheckoutSession(binding: BridgeBinding, sessionId: string): void {
    const row = this.db.prepare('SELECT binding FROM checkout_sessions WHERE session_id=?').get(sessionId);
    if (row?.binding !== digest(binding)) throw Error('identity_mismatch');
  }
  record(binding: BridgeBinding, callId: unknown, input: unknown): void {
    if (typeof callId !== 'string' || !callId || callId.length > 1024) throw Error('report_call_invalid');
    const report = validated<ManagedCodingResultV1>('managed-result', input as ManagedCodingResultV1);
    if (report.runId !== binding.runId) throw Error('identity_mismatch');
    const key = digest(binding), payload = canonical(report), fingerprint = digest(report);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT digest FROM reports WHERE binding=? AND session_id=? AND turn_id=? AND call_id=?')
        .get(key, report.sessionId, report.turnId, callId);
      if (prior && prior.digest !== fingerprint) throw Error('report_conflict');
      this.db.prepare('INSERT OR IGNORE INTO reports VALUES (?,?,?,?,?,?)')
        .run(key, report.sessionId, report.turnId, callId, payload, fingerprint);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  hasSession(binding: BridgeBinding, sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM reports WHERE binding=? AND session_id=? LIMIT 1').get(digest(binding), sessionId));
  }
  read(binding: BridgeBinding, sessionId: string, turnId: string): ManagedCodingResultV1 | null {
    const rows = this.db.prepare('SELECT payload,digest FROM reports WHERE binding=? AND session_id=? AND turn_id=? LIMIT 65')
      .all(digest(binding), sessionId, turnId);
    if (rows.length > 64) throw Error('report_limit');
    let report: ManagedCodingResultV1 | null = null;
    for (const row of rows) {
      const candidate = validated<ManagedCodingResultV1>('managed-result', JSON.parse(String(row.payload)));
      if (candidate.runId !== binding.runId || candidate.sessionId !== sessionId || candidate.turnId !== turnId || digest(candidate) !== row.digest) throw Error('report_journal_invalid');
      if (report && digest(report) !== digest(candidate)) throw Error('report_conflict');
      report = candidate;
    }
    return report;
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
