// Optional native metadata. Names never supply task authority.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { protectedPath, assertPrivateDatabase } from '../target-helper/filesystem.ts';
import { digest } from '../configuration/json.ts';
import type { BridgeBinding } from './bridge.ts';

export type NameState = 'pending' | 'intent' | 'applied' | 'preserved';
export interface NameRecord { title: string; state: NameState; lastError: string | null }

/** Parse only the generated header before the FIRST Task data boundary. */
export function issueThreadTitle(prompt: string, repository: string): string | null {
  if (typeof prompt !== 'string' || typeof repository !== 'string') return null;
  const boundary = prompt.indexOf('\nTask data:\n');
  if (boundary < 0) return null;
  const match = /\nIssue: https:\/\/github\.com\/([a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100})\/issues\/([1-9][0-9]{0,9})\nTitle: ([^\r\n]{1,4096})$/.exec(prompt.slice(0, boundary));
  if (!match || match[1] !== repository) return null;
  const repo = match[1].split('/')[1], prefix = `${repo} · #${match[2]} · `;
  const title = match[3].toWellFormed().normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!title || Array.from(prefix).length >= 200) return null;
  return prefix + Array.from(title).slice(0, 200 - Array.from(prefix).length).join('');
}

/** Optional private metadata journal; separate from the publication journal. */
export class NativeNameJournal {
  private db: DatabaseSync;
  private closed = false;
  constructor(stateDirectory: string) {
    protectedPath(stateDirectory);
    const directory = join(stateDirectory, 'native-names');
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    protectedPath(directory);
    if (lstatSync(directory).uid !== process.getuid!()) throw Error('name_journal_unsafe');
    assertPrivateDatabase(directory, 'names.sqlite');
    const path = join(directory, 'names.sqlite'), fresh = !existsSync(path);
    if (fresh) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    // Naming is optional; a busy metadata store must not stall task delivery.
    this.db = new DatabaseSync(path, { timeout: 50 });
    try {
      this.db.exec('PRAGMA synchronous=FULL');
      if (fresh) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE native_names (
          binding TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','intent','applied','preserved')),
          last_error TEXT, PRIMARY KEY(binding,session_id));
        PRAGMA user_version=1; COMMIT;`);
      if (this.db.prepare('PRAGMA user_version').get()!.user_version !== 1) throw Error('name_journal_version');
      this.db.prepare('SELECT binding,session_id,title,state,last_error FROM native_names LIMIT 1').get();
    } catch (error) { this.db.close(); throw error; }
  }
  private key(binding: BridgeBinding, sessionId: string) {
    if (this.closed || !/^[a-z0-9-]{1,128}$/i.test(sessionId)) throw Error('name_journal_invalid');
    return [digest(binding), sessionId];
  }
  private title(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 200 || /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(value)) throw Error('name_journal_invalid');
  }
  read(binding: BridgeBinding, sessionId: string): NameRecord | null {
    const row = this.db.prepare('SELECT title,state,last_error FROM native_names WHERE binding=? AND session_id=?').get(...this.key(binding, sessionId));
    if (!row) return null;
    this.title(row.title);
    if (!['pending', 'intent', 'applied', 'preserved'].includes(String(row.state))) throw Error('name_journal_invalid');
    if (row.last_error !== null && !['native_name_unavailable', 'name_metadata_missing', 'name_effect_unknown'].includes(String(row.last_error))) throw Error('name_journal_invalid');
    return { title: row.title, state: row.state as NameState, lastError: row.last_error === null ? null : String(row.last_error) };
  }
  propose(binding: BridgeBinding, sessionId: string, title: string): void {
    this.title(title);
    const key = this.key(binding, sessionId);
    this.db.prepare("INSERT OR IGNORE INTO native_names(binding,session_id,title,state,last_error) VALUES (?,?,?,'pending',NULL)").run(...key, title);
    if (this.read(binding, sessionId)?.title !== title) throw Error('name_intent_conflict');
  }
  intent(binding: BridgeBinding, sessionId: string): boolean {
    return Number(this.db.prepare("UPDATE native_names SET state='intent',last_error=NULL WHERE binding=? AND session_id=? AND state='pending'").run(...this.key(binding, sessionId)).changes) === 1;
  }
  complete(binding: BridgeBinding, sessionId: string, state: 'applied' | 'preserved'): void {
    this.db.prepare("UPDATE native_names SET state=?,last_error=NULL WHERE binding=? AND session_id=? AND state IN ('pending','intent')").run(state, ...this.key(binding, sessionId));
  }
  note(binding: BridgeBinding, sessionId: string, code: 'native_name_unavailable' | 'name_metadata_missing' | 'name_effect_unknown'): void {
    this.db.prepare("UPDATE native_names SET last_error=? WHERE binding=? AND session_id=? AND state IN ('pending','intent')").run(code, ...this.key(binding, sessionId));
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
