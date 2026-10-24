import { constants, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import type { Installation } from './installation.ts';
import { acquireServiceLock } from './loop.ts';
import { assertPrivateDatabase, protectedPath, readProtected } from '../target-helper/filesystem.ts';
import { assertNoMaintenance } from '../storage-sqlite/maintenance.ts';
import { migrate, migrations, verifySchemaHistory } from '../storage-sqlite/migrations.ts';
import type { Migration } from '../storage-sqlite/migrations.ts';
import { fenceRecovery } from '../storage-sqlite/recovery.ts';
import { assertSeparate } from '../storage-sqlite/paths.ts';
import { validated } from '../storage-sqlite/validation.ts';
import { checkedSnapshot } from '../configuration/snapshot.ts';
import { digest } from '../configuration/json.ts';
import { readPinnedArtifact } from '../extensions/loader.ts';
import type { Pin, Profile } from '../extensions/loader.ts';
import type { InstallationBackupBundleV1 } from '../../contracts/generated/backup-bundle.ts';
import type { InstallationMaintenanceResultV1 } from '../../contracts/generated/maintenance-result.ts';

const context = { actorId: 'local-operator', reason: 'Explicit database restore or upgrade; independent reconciliation required', evidenceRefs: ['operator:local-file-authority'] };
function syncPath(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function writeExclusive(path: string, bytes: string | Buffer) { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); syncPath(path); syncPath(dirname(path)); }
function privateDirectory(path: string) { protectedPath(path); if (lstatSync(path).mode & 0o077) throw Error('unsafe_state_path'); }
function createDirectory(path: string) { protectedPath(dirname(path)); mkdirSync(path, { mode: 0o700 }); syncPath(dirname(path)); }
function checksum(path: string): string {
  protectedPath(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha256'), buffer = Buffer.alloc(65536);
  try { for (;;) { const n = readSync(fd, buffer); if (!n) break; hash.update(buffer.subarray(0, n)); } return hash.digest('hex'); }
  finally { closeSync(fd); }
}
function inspect(db: DatabaseSync, installationId: string): number {
  const version = verifySchemaHistory(db);
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw Error('storage_failure');
  const rows = db.prepare('SELECT id FROM installations').all();
  if (rows.length !== 1 || rows[0].id !== installationId) throw Error('installation_binding_invalid');
  return version;
}
function pins(db: DatabaseSync): Pin[] {
  const result: Pin[] = [];
  const exists = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (exists('configuration_snapshots')) for (const row of db.prepare('SELECT digest,payload FROM configuration_snapshots').all()) {
    const snapshot = checkedSnapshot(JSON.parse(String(row.payload)));
    if (snapshot.digest !== row.digest) throw Error('identity_conflict');
    result.push(...snapshot.extensionLock.extensions);
  }
  if (exists('extension_profiles')) for (const row of db.prepare('SELECT digest,payload FROM extension_profiles').all()) {
    const profile = validated<Profile>('extension-profile', JSON.parse(String(row.payload)));
    if (digest(profile) !== row.digest) throw Error('identity_conflict');
    result.push(profile.pin);
  }
  return result;
}
async function snapshot(source: string, target: string) {
  writeExclusive(target, '');
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); } finally { db.close(); }
  // Publish a standalone database, never a file that needs omitted WAL bytes.
  const copy = new DatabaseSync(target);
  try { copy.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL'); } finally { copy.close(); }
  syncPath(target);
}
function result(code: InstallationMaintenanceResultV1['code'], databaseVersion: number): InstallationMaintenanceResultV1 {
  return validated('maintenance-result', { schemaVersion: '1.0', code, databaseVersion, reconciliationRequired: code !== 'backup_bundle_created' });
}
function readBundle(directory: string, installationId: string) {
  privateDirectory(directory); assertPrivateDatabase(directory, 'state.sqlite');
  const entries = new Set(readdirSync(directory));
  if (['-wal','-shm','-journal'].some(suffix => entries.has('state.sqlite' + suffix))) throw Error('backup_invalid');
  const metadata = validated<InstallationBackupBundleV1>('backup-bundle', JSON.parse(readProtected(join(directory, 'manifest.json')).toString('utf8')));
  if (metadata.installationId !== installationId) throw Error('installation_binding_invalid');
  if (checksum(join(directory, 'state.sqlite')) !== metadata.databaseSha256) throw Error('backup_invalid');
  privateDirectory(join(directory, 'artifacts'));
  for (const sha of metadata.artifacts) if (createHash('sha256').update(readProtected(join(directory, 'artifacts', sha + '.json'))).digest('hex') !== sha) throw Error('backup_invalid');
  const db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
  try {
    if (inspect(db, installationId) !== metadata.databaseVersion) throw Error('backup_invalid');
    for (const pin of pins(db)) {
      if (!metadata.artifacts.includes(pin.integrity)) throw Error('backup_invalid');
      readPinnedArtifact(pin, join(directory, 'artifacts'));
    }
  } finally { db.close(); }
  return metadata;
}
export async function createBackupBundle(spec: Installation, destination: string) {
  const directory = resolve(destination);
  assertNoMaintenance(spec.stateDirectory); assertPrivateDatabase(spec.stateDirectory, 'state.sqlite');
  // Exclusive directory creation preserves even an incomplete prior attempt.
  try { createDirectory(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('backup_exists'); throw error; }
  createDirectory(join(directory, 'artifacts'));
  await snapshot(join(spec.stateDirectory, 'state.sqlite'), join(directory, 'state.sqlite'));
  const db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
  let databaseVersion: number, required: Pin[];
  try { databaseVersion = inspect(db, spec.configuration.installationId); required = [...pins(db), ...spec.lock.extensions]; }
  finally { db.close(); }
  const artifacts = new Set<string>();
  for (const pin of required) {
    const bytes = readPinnedArtifact(pin, join(spec.stateDirectory, 'artifacts'));
    if (!artifacts.has(pin.integrity)) writeExclusive(join(directory, 'artifacts', pin.integrity + '.json'), bytes);
    artifacts.add(pin.integrity);
  }
  const metadata = validated<InstallationBackupBundleV1>('backup-bundle', { schemaVersion: '1.0', installationId: spec.configuration.installationId,
    databaseVersion, databaseSha256: checksum(join(directory, 'state.sqlite')), artifacts: [...artifacts].sort() });
  // The manifest is the completion record. Failed attempts remain visibly incomplete.
  writeExclusive(join(directory, 'manifest.json'), JSON.stringify(metadata));
  readBundle(directory, spec.configuration.installationId);
  return result('backup_bundle_created', databaseVersion);
}

// Hooks are trusted embedding/test seams, never CLI input or migration source.
export interface MaintenanceOptions { boundary?: (stage: string) => void; migrations?: readonly Migration[] }
function marker(directory: string, operation: 'restore' | 'upgrade', bundle: string, installationId: string) {
  writeExclusive(join(directory, 'maintenance.json'), JSON.stringify(validated('maintenance-operation', { schemaVersion: '1.0', operation, bundle, installationId })));
}
function complete(directory: string) { unlinkSync(join(directory, 'maintenance.json')); syncPath(directory); }
function retainArtifacts(bundle: string, directory: string, metadata: InstallationBackupBundleV1) {
  const destination = join(directory, 'artifacts');
  try { createDirectory(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; privateDirectory(destination); }
  for (const sha of metadata.artifacts) {
    const bytes = readProtected(join(bundle, 'artifacts', sha + '.json'));
    if (createHash('sha256').update(bytes).digest('hex') !== sha) throw Error('backup_invalid');
    try { writeExclusive(join(destination, sha + '.json'), bytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (checksum(join(destination, sha + '.json')) !== sha) throw Error('backup_invalid');
    }
  }
}
export async function restoreBundle(spec: Installation, source: string, options: MaintenanceOptions = {}) {
  const bundle = resolve(source), directory = spec.stateDirectory;
  const metadata = readBundle(bundle, spec.configuration.installationId);
  privateDirectory(directory); assertNoMaintenance(directory);
  const release = await acquireServiceLock(directory);
  try {
    if (readdirSync(directory).some(name => name !== 'service.lock')) throw Error('restore_destination_occupied');
    marker(directory, 'restore', bundle, metadata.installationId);
    options.boundary?.('restore-marked');
    const staging = join(directory, 'restore-staging'); createDirectory(staging);
    await snapshot(join(bundle, 'state.sqlite'), join(staging, 'state.sqlite'));
    const db = new DatabaseSync(join(staging, 'state.sqlite'));
    try {
      inspect(db, metadata.installationId);
      for (const row of db.prepare('SELECT payload FROM workspaces').all()) {
        const record = validated('lifecycle-record', JSON.parse(String(row.payload)));
        if (record.kind !== 'workspace') throw Error('storage_failure');
        if (record.localPath !== null) assertSeparate(directory, record.localPath);
      }
      db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      migrate(db, options.migrations ?? migrations, () => { fenceRecovery(db, new Date().toISOString(), context); options.boundary?.('migration-before-commit'); });
      inspect(db, metadata.installationId);
    } finally { db.close(); }
    syncPath(join(staging, 'state.sqlite'));
    retainArtifacts(bundle, directory, metadata);
    options.boundary?.('restore-before-publish');
    copyFileSync(join(staging, 'state.sqlite'), join(directory, 'state.sqlite'), constants.COPYFILE_EXCL);
    syncPath(join(directory, 'state.sqlite')); syncPath(directory);
    options.boundary?.('restore-published');
    complete(directory);
    return result('restore_completed', migrations.length);
  } finally { await release(); }
}
export async function upgradeDatabase(spec: Installation, destination: string, options: MaintenanceOptions = {}) {
  const directory = spec.stateDirectory, bundle = resolve(destination);
  assertNoMaintenance(directory); assertPrivateDatabase(directory, 'state.sqlite');
  const release = await acquireServiceLock(directory);
  try {
    await createBackupBundle(spec, bundle);
    const metadata = readBundle(bundle, spec.configuration.installationId);
    marker(directory, 'upgrade', bundle, metadata.installationId);
    options.boundary?.('upgrade-marked');
    retainArtifacts(bundle, directory, metadata);
    const db = new DatabaseSync(join(directory, 'state.sqlite'));
    try {
      inspect(db, metadata.installationId);
      db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      migrate(db, options.migrations ?? migrations, () => { fenceRecovery(db, new Date().toISOString(), context); options.boundary?.('migration-before-commit'); });
      options.boundary?.('upgrade-committed');
      inspect(db, metadata.installationId);
    } finally { db.close(); }
    syncPath(join(directory, 'state.sqlite')); syncPath(directory);
    complete(directory);
    return result('upgrade_completed', migrations.length);
  } finally { await release(); }
}
