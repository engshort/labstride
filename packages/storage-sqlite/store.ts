import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkChange, LifecycleError } from '../core/lifecycle.ts';
import type { AuditContext, AuditRecord, Change, Clock, IdentityProvider, Kind, LifecycleRecord, RecordOf, RecoverySnapshot, StateStore } from '../core/lifecycle.ts';
import { migrate, verifySchema } from './migrations.ts';
import { assertNoMaintenance } from './maintenance.ts';
import { validated } from './validation.ts';
import { assertDatabaseFiles, assertSeparate, canonicalPath } from './paths.ts';
import { checkedSnapshot } from '../configuration/snapshot.ts';
import type { ConfigurationSnapshot } from '../configuration/snapshot.ts';
import { canonical } from '../configuration/json.ts';
import type { PolicyDependencies } from '../core/policy.ts';

const tables: Record<Kind, string> = {
  installation: 'installations', request: 'requests', run: 'runs', workspace: 'workspaces', operation: 'operations',
  deployment: 'deployments', session: 'sessions', outbox: 'outbox', projection: 'projections',
  resource: 'resources', evidence: 'evidence',
};
export interface StoreDependencies extends PolicyDependencies { clock?: Clock; identities?: IdentityProvider; localWorkspaceRoots?: readonly string[]; readOnly?: boolean; existingOnly?: boolean }
function classify(error: unknown): LifecycleError {
  if (error instanceof LifecycleError) return error;
  const code = (error as { errcode?: number }).errcode;
  if (code !== undefined && (code & 255) === 5) return new LifecycleError('storage_busy');
  if (code !== undefined && (code & 255) === 19) return new LifecycleError('identity_conflict');
  return new LifecycleError('storage_failure');
}

export class SqliteStore implements StateStore {
  private transactionDepth = 0;
  readonly dataDir: string;
  protected db: DatabaseSync;
  protected clock: Clock;
  protected identities: IdentityProvider;

  constructor(dataDir: string, dependencies: StoreDependencies = {}) {
    assertNoMaintenance(dataDir);
    this.clock = dependencies.clock ?? { now: () => new Date().toISOString() };
    this.identities = dependencies.identities ?? { next: randomUUID };
    const canonical = canonicalPath(dataDir);
    for (const root of dependencies.localWorkspaceRoots ?? []) assertSeparate(canonical, root);
    try {
      if (!dependencies.readOnly && !dependencies.existingOnly) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      this.dataDir = realpathSync(dataDir);
      assertDatabaseFiles(this.dataDir);
      if (dependencies.existingOnly) lstatSync(join(this.dataDir, 'state.sqlite'));
    } catch { throw new LifecycleError('unsafe_state_path'); }
    try { this.db = new DatabaseSync(join(this.dataDir, 'state.sqlite'), { timeout: 5000, readOnly: dependencies.readOnly ?? false }); }
    catch (error) { throw classify(error); }
    try {
      if (dependencies.readOnly || dependencies.existingOnly) verifySchema(this.db);
      if (!dependencies.readOnly) {
        this.db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
        if (!dependencies.existingOnly) migrate(this.db);
        const mode = this.db.prepare('PRAGMA journal_mode=WAL').get();
        if (mode!.journal_mode !== 'wal') throw new LifecycleError('storage_failure');
      }
      // Recheck recorded local paths on every boot, including changed symlink aliases.
      for (const { payload } of this.db.prepare('SELECT payload FROM workspaces').all()) {
        const record = validated('lifecycle-record', JSON.parse(String(payload)));
        if (record.kind !== 'workspace') throw new LifecycleError('storage_failure');
        if (record.localPath !== null) assertSeparate(this.dataDir, record.localPath);
      }
    } catch (error) { this.db.close(); throw classify(error); }
  }

  #read<K extends Kind>(kind: K, id: string): RecordOf<K> | undefined {
    if (!Object.hasOwn(tables, kind)) throw new LifecycleError('invalid_payload');
    const row = this.db.prepare(`SELECT payload FROM ${tables[kind]} WHERE id=?`).get(id);
    if (!row) return undefined;
    const record = validated('lifecycle-record', JSON.parse(String(row.payload)));
    if (record.kind !== kind || record.id !== id) throw new LifecycleError('storage_failure');
    return record as RecordOf<K>;
  }
  get<K extends Kind>(kind: K, id: string): RecordOf<K> {
    try {
      const record = this.#read(kind, id);
      if (!record) throw new LifecycleError('not_found');
      return record;
    } catch (error) { throw classify(error); }
  }

  protected transaction<T>(work: () => T): T {
    const savepoint = `nested_${this.transactionDepth}`;
    const nested = this.transactionDepth > 0;
    try {
      this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      this.transactionDepth++;
      try { const result = work(); this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
      catch (error) {
        this.db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
        if (nested) this.db.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally { this.transactionDepth--; }
    } catch (error) { throw classify(error); }
  }

  successorFulfilled(_operationId: string): boolean { return false; }
  successorSatisfied(_operationId: string): boolean { return false; }
  consumeSuccessorEvidence(_operationId: string): boolean { return false; }

  commit(input: Change[], context: AuditContext): void {
    this.transaction(() => {
      if (!Array.isArray(input)) throw new LifecycleError('invalid_payload');
      for (const change of input) {
        if (change?.record?.kind === 'installation') {
          const previous = this.#read('installation', change.record.id);
          if (previous && previous.configRevision !== change.record.configRevision)
            throw new LifecycleError('recovery_required'); // Only audited preflight activation may advance the revision.
        }
        if (change?.record?.kind === 'run' && !this.#read('run', change.record.id)) {
          const requestId = change.record.requestId;
          const requestChange = input.find(c => c?.record?.kind === 'request' && c.record.id === requestId);
          const request = requestChange?.record?.kind === 'request' ? requestChange.record : this.get('request', requestId);
          if (this.db.prepare('SELECT 1 FROM active_configurations WHERE installation_id=?').get(request.installationId))
            throw new LifecycleError('recovery_required');
        }
        if (change?.record?.kind === 'operation' && this.db.prepare('SELECT 1 FROM execution_bindings WHERE operation_id=?').get(change.record.id))
          throw new LifecycleError('recovery_required');
      }
      for (const change of input) {
        if (change?.record?.kind === 'run' && this.db.prepare('SELECT 1 FROM run_controls WHERE run_id=?').get(change.record.id)) {
          const old = this.get('run', change.record.id);
          const completing = change.record.state === 'completed';
          if (old.paused !== change.record.paused || (['completed','cancelled','failed'].includes(change.record.state) &&
            this.db.prepare("SELECT id,state FROM operations WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled')").all(old.id)
              .some(op => op.state !== 'superseded' || completing && !this.consumeSuccessorEvidence(String(op.id)))))
            throw new LifecycleError('recovery_required');
        }
      }
      this.write(input, context);
    });
  }

  protected write(input: Change[], context: AuditContext): void {
    if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw new LifecycleError('invalid_payload');
    if (!context || Object.keys(context).some(key => !['actorId', 'reason', 'evidenceRefs'].includes(key)))
      throw new LifecycleError('invalid_payload');
    // Snapshot/validate every payload before beginning any writes.
    const changes = input.map(change => ({ ...change, record: validated('lifecycle-record', change.record) }));
    const audits = changes.map(change => validated('lifecycle-audit', {
      schemaVersion: '1.0', id: 'pending-audit', at: this.clock.now(),
      actorId: context.actorId, reason: context.reason, evidenceRefs: context.evidenceRefs,
      previousRevision: change.expectedRevision, recovery: change.recovery ?? false, record: change.record,
    } as AuditRecord));
    for (const [index, change] of changes.entries()) {
      const record = change.record;
      const previous = this.#read(record.kind, record.id);
      checkChange(previous, change);
      if (change.recovery && audits[index].evidenceRefs.length === 0) throw new LifecycleError('recovery_required');
      if ('state' in record && ['completed', 'succeeded', 'verified', 'deleted'].includes(record.state) &&
        audits[index].evidenceRefs.length === 0) throw new LifecycleError('invalid_payload');
      this.#checkReferences(record);
      const table = tables[record.kind];
      if (previous) {
        const result = this.db.prepare(`UPDATE ${table} SET payload=? WHERE id=? AND revision=?`)
          .run(JSON.stringify(record), record.id, change.expectedRevision);
        if (Number(result.changes) !== 1) throw new LifecycleError('revision_conflict');
      } else this.db.prepare(`INSERT INTO ${table}(id,payload) VALUES (?,?)`).run(record.id, JSON.stringify(record));
      if (record.kind === 'session' && previous?.kind === 'session' &&
        (record.humanActivityRevision > previous.humanActivityRevision || (record.owner === 'human' && previous.owner !== 'human')))
        this.db.prepare('UPDATE run_controls SET human_hold=1 WHERE run_id=?').run(record.runId);
      const audit = validated('lifecycle-audit', { ...audits[index], id: this.identities.next() });
      this.db.prepare('INSERT INTO audit VALUES (?,?)').run(audit.id, JSON.stringify(audit));
    }
    for (const { record } of changes) {
      if (record.kind === 'operation' && !this.db.prepare('SELECT id FROM outbox WHERE operation_id=?').get(record.id))
        throw new LifecycleError('identity_conflict');
    }
  }

  #checkReferences(record: LifecycleRecord): void {
    if (record.kind === 'workspace' && record.localPath !== null) assertSeparate(this.dataDir, record.localPath);
    if (record.kind === 'run') {
      const request = this.get('request', record.requestId);
      // Existing runs keep their original revision after ordinary installation edits.
      if (!this.#read('run', record.id) && record.configRevision !== this.get('installation', request.installationId).configRevision)
        throw new LifecycleError('identity_conflict');
    }
    if (record.kind === 'operation') {
      const workspace = this.get('workspace', record.workspaceId);
      if (record.request.operationId !== record.id || record.request.runId !== record.runId ||
        record.request.workspaceId !== record.workspaceId || record.request.targetId !== workspace.targetId ||
        record.request.source.repositoryId !== this.get('run', record.runId).repositoryId)
        throw new LifecycleError('identity_conflict');
    }
    if (record.kind === 'deployment') {
      const operation = this.get('operation', record.operationId);
      if (record.targetId !== operation.request.targetId || record.sourceSha !== operation.request.source.sha)
        throw new LifecycleError('identity_conflict');
    }
    if (record.kind === 'outbox' && record.payload.operationId !== record.operationId)
      throw new LifecycleError('identity_conflict');
    if (record.kind === 'projection') {
      const run = this.get('run', record.runId);
      const request = this.get('request', run.requestId);
      if (record.generation !== request.generation || record.providerId !== request.providerId ||
        record.subjectId !== request.issueId) throw new LifecycleError('identity_conflict');
    }
    if (record.kind === 'resource') {
      const workspace = this.get('workspace', record.workspaceId);
      if (record.ownershipRef !== workspace.ownershipRef) throw new LifecycleError('identity_conflict');
    }
    if (record.kind === 'evidence') {
      const operation = this.get('operation', record.operationId);
      if ((record.sourceSha !== null && record.sourceSha !== operation.request.source.sha) ||
        (record.targetId !== null && record.targetId !== operation.request.targetId)) throw new LifecycleError('identity_conflict');
      if (record.correctsId !== null) {
        const original = this.get('evidence', record.correctsId);
        if (original.runId !== record.runId || original.workspaceId !== record.workspaceId || original.subjectId !== record.subjectId)
          throw new LifecycleError('identity_conflict');
      }
    }
  }

  configurationSnapshot(hash: string): ConfigurationSnapshot {
    const row = this.db.prepare('SELECT installation_id,payload FROM configuration_snapshots WHERE digest=?').get(hash);
    if (!row) throw new LifecycleError('effect_blocked');
    try {
      const snapshot = checkedSnapshot(JSON.parse(String(row.payload)));
      if (snapshot.digest !== hash || snapshot.configuration.installationId !== row.installation_id) throw new Error();
      return snapshot;
    } catch { throw new LifecycleError('effect_blocked'); }
  }
  runConfiguration(runId: string): ConfigurationSnapshot | null {
    const run = this.get('run', runId);
    const marker = this.db.prepare('SELECT config_digest FROM runs WHERE id=?').get(runId)!;
    if (marker.config_digest === null) return null; // Migrated legacy runs acquire no invented snapshot.
    const snapshot = this.configurationSnapshot(String(marker.config_digest));
    const request = this.get('request', run.requestId);
    if (snapshot.digest !== run.configRevision || snapshot.configuration.installationId !== request.installationId)
      throw new LifecycleError('effect_blocked');
    return snapshot;
  }
  protected assertConfigurationOperation(runId: string, operation: RecordOf<'operation'>['request']): void {
    const snapshot = this.runConfiguration(runId);
    if (!snapshot) return;
    const pin = snapshot.extensionLock.extensions.find(pin => pin.kind === 'action' && pin.id === operation.actionId && pin.version === operation.actionVersion);
    if (!pin || operation.configDigest !== snapshot.digest || !Object.hasOwn(snapshot.configuration.targets, operation.targetId) ||
      !snapshot.configuration.github.repositories.includes(operation.source.repository)) throw new LifecycleError('effect_blocked');
  }
  protected bindStartConfiguration(snapshot: ConfigurationSnapshot | undefined, run: RecordOf<'run'>, installationId: string): void {
    const active = this.db.prepare('SELECT digest FROM active_configurations WHERE installation_id=?').get(installationId);
    if (!active && !snapshot) return;
    if (!active || !snapshot || active.digest !== snapshot.digest || snapshot.digest !== run.configRevision)
      throw new LifecycleError('effect_blocked');
    const saved = this.configurationSnapshot(snapshot.digest);
    if (!saved.configuration.enabled || canonical(saved) !== canonical(checkedSnapshot(snapshot))) throw new LifecycleError('effect_blocked');
    this.db.prepare('UPDATE runs SET config_digest=? WHERE id=?').run(snapshot.digest, run.id);
  }

  #records(): LifecycleRecord[] {
    return Object.entries(tables).flatMap(([kind, table]) => this.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all()
      .map(row => this.get(kind as Kind, String(row.id))));
  }
  snapshot(): RecoverySnapshot {
    this.db.exec('BEGIN');
    try {
      const records = this.#records();
      const operations = records.filter((record): record is RecordOf<'operation'> => record.kind === 'operation');
      const prepared = new Set(operations.filter(op => op.state === 'prepared' && op.effectBoundary === 'not_crossed').map(op => op.id));
      const pendingIntents = records.filter((record): record is RecordOf<'outbox'> => record.kind === 'outbox' && prepared.has(record.operationId));
      const reconciliationRequired = operations.filter(op => ['claimed', 'running', 'outcome_unknown'].includes(op.state));
      this.db.exec('COMMIT');
      return { schemaVersion: '1.0', records, pendingIntents, reconciliationRequired };
    } catch (error) { this.db.exec('ROLLBACK'); throw classify(error); }
  }

  history(runId: string): { records: LifecycleRecord[]; audit: AuditRecord[] } {
    this.db.exec('BEGIN');
    try {
      this.get('run', runId);
      const snapshot = { records: this.#records() };
      const run = snapshot.records.find(record => record.kind === 'run' && record.id === runId) as RecordOf<'run'>;
      const request = this.get('request', run.requestId);
      const records = snapshot.records.filter(record => ('runId' in record && record.runId === runId) ||
        (record.kind === 'run' && record.id === runId) || (record.kind === 'request' && record.id === request.id) ||
        (record.kind === 'installation' && record.id === request.installationId));
      const identities = new Set(records.map(record => `${record.kind}:${record.id}`));
      const audit = this.db.prepare('SELECT payload FROM audit ORDER BY rowid').all()
        .map(row => validated('lifecycle-audit', JSON.parse(String(row.payload))))
        .filter(item => identities.has(`${item.record.kind}:${item.record.id}`));
      this.db.exec('COMMIT');
      return { records, audit };
    } catch (error) { this.db.exec('ROLLBACK'); throw classify(error); }
  }
  close(): void { this.db.close(); }
}
