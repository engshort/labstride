import { removeOperationsMigration } from './helpers/migration-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { publicFixture } from './helpers/public-installation-fixture.mjs';
import { setup, follow, host as sessionHost } from './helpers/session-fixture.mjs';
import { seed, schedule, context } from './helpers/execution-fixture.mjs';
import { enroll, hook, observation, provider } from './helpers/observation-fixture.mjs';
import { startCoordinator } from '../apps/coordinator/main.ts';
import { startExecution } from '../apps/coordinator/runtime.ts';
import { cli } from '../apps/cli/main.ts';
import { createBackupBundle, restoreBundle, upgradeDatabase } from '../packages/operations/recovery.ts';
import { installationHost } from '../packages/operations/installation.ts';
import { loadExtension } from '../packages/extensions/loader.ts';
import { sessionResolver } from '../packages/extensions/session-provider.ts';
import { createSessionAction, sessionAction, sessionActionVersion } from '../packages/core/sessions.ts';
import { pinnedSessionObserver } from '../packages/core/session-runtime.ts';
import { actionKey, createWorker } from '../packages/core/worker.ts';
import { migrations } from '../packages/storage-sqlite/migrations.ts';
import { initializePrivateState } from '../packages/operations/runtime.ts';
import { acquireServiceLock } from '../packages/operations/loop.ts';
import { readStatus } from '../packages/operations/inspection.ts';

function fixture(t, session = false) {
  const f = publicFixture(t), { store } = startCoordinator(f.spec.stateDirectory);
  const configured = session ? setup(store, f.root) : (seed(store), { plan: schedule(store) });
  for (const file of readdirSync(f.spec.stateDirectory)) chmodSync(join(f.spec.stateDirectory, file), 0o600);
  let closed = false; const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(close); f.write();
  return { ...f, ...configured, store, close, bundle: join(f.root, 'backup') };
}
function restoredSpec(f, name = 'restored') {
  const spec = structuredClone(f.spec); spec.stateDirectory = join(f.root, name); mkdirSync(spec.stateDirectory, { mode: 0o700 }); return spec;
}
function reply(op, status = 'succeeded') {
  return { schemaVersion: '1.0', kind: 'result', operationId: op.operationId, requestDigest: op.requestDigest,
    result: { status, handle: 'opaque-original-handle', resources: [], outputs: {}, evidenceRefs: ['test:durable-peer'], error: null } };
}
function processFor(t, file, args) {
  const child = fork(new URL(`./helpers/${file}`, import.meta.url), args, { stdio: ['ignore','ignore','pipe','ipc'] });
  child.exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', part => { stderr += part; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await child.exited; } });
  child.message = async () => {
    const result = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(15000) }).then(([message]) => message), child.exited.then(() => { throw Error(stderr || 'child_exited'); })]);
    return result;
  };
  return child;
}
test('bundle CLI snapshots WAL state and restores immutable session pins after original artifacts disappear', async t => {
  const f = fixture(t, true), old = structuredClone(f.profile);
  f.spec.host.permissions = [...new Set([...f.spec.host.permissions, ...sessionHost.permissions])];
  const newer = structuredClone(f.pkg.artifact); newer.manifest.version = '99.0.0';
  newer.module = "throw Error('backup_must_not_execute_artifacts');\n" + newer.module;
  const bytes = Buffer.from(JSON.stringify(newer)), nextPath = join(f.root, 'new-version.json'); writeFileSync(nextPath, bytes);
  f.spec.lock.extensions.push({ ...f.pkg.pin, artifactPath: nextPath, integrity: createHash('sha256').update(bytes).digest('hex'), version: '99.0.0' });
  f.write(); const out = [];
  await cli(['backup','--bundle',f.bundle,'--config',f.path], value => out.push(value));
  assert.equal(out[0].code, 'backup_bundle_created');
  const metadata = JSON.parse(readFileSync(join(f.bundle, 'manifest.json')));
  assert(metadata.artifacts.includes(old.pin.integrity)); assert(metadata.artifacts.includes(f.spec.lock.extensions.at(-1).integrity));
  const sourcePins = f.store.profile(f.plan.run.id, f.pkg.pin.id); f.close();
  for (const pin of [...f.spec.lock.extensions, old.pin]) if (existsSync(pin.artifactPath)) renameSync(pin.artifactPath, pin.artifactPath + '.unavailable');
  const spec = restoredSpec(f), config = join(f.root, 'restore.json'); writeFileSync(config, JSON.stringify(spec), { mode: 0o600 });
  await cli(['restore',f.bundle,'--config',config], value => out.push(value));
  assert.equal(out.at(-1).code, 'restore_completed');
  const { store } = startCoordinator(spec.stateDirectory); t.after(() => store.close());
  assert.deepEqual(store.profile(f.plan.run.id, f.pkg.pin.id), sourcePins);
  const loaded = await loadExtension(old, installationHost(spec)); assert.equal(loaded.profile.pin.version, old.pin.version);
  assert.equal(loaded.instance.backendIdentity, 'test-backend');
  assert.equal(store.recoveryStatus().paused, true);
  assert.throws(() => store.resumeAfterRestore(context), /recovery_required/);
  await assert.rejects(cli(['restore',f.bundle,'--config',config]), /restore_destination_occupied/);
});
test('AC21 slice: older bundle reconciles one independently durable external effect before CLI resume', async t => {
  const f = fixture(t), targetPath = join(f.root, 'target.sqlite'), target = processFor(t, 'effect-target.mjs', [targetPath]);
  const { url } = await target.message(), external = provider(join(f.root, 'provider.sqlite'), f.plan.projections[0]); t.after(external.close);
  await createBackupBundle(f.spec, f.bundle);
  const send = async (route, op) => (await fetch(url + route, { method: 'POST', body: JSON.stringify(op) })).json();
  const adapter = { async validate() {}, start: op => send('/start', op), reconcile: op => send('/observe', op) };
  const worker = createWorker(f.store, { executorId: 'original', nextAttempt: () => 'original', adapters: new Map([[actionKey(f.plan.operation.request.actionId, f.plan.operation.request.actionVersion), adapter]]) });
  await worker.tick(); await worker.drain(); assert.equal(f.store.get('operation', f.plan.operation.id).state, 'succeeded');
  external.human(); f.close(); const spec = restoredSpec(f); await restoreBundle(spec, f.bundle);
  const runtime = startExecution(spec.stateDirectory, { mode: 'reconcile-only', actions: { executorId: 'restore', nextAttempt: () => { throw Error('unexpected_start'); },
    adapters: new Map([[actionKey(f.plan.operation.request.actionId, f.plan.operation.request.actionVersion), adapter]]) },
    observations: { sessions: new Map(), projections: new Map([[f.plan.projections[0].providerId, external.adapter]]) } });
  assert.throws(() => runtime.store.resumeAfterRestore(context), /recovery_required/);
  await runtime.tick(); await runtime.drain();
  assert.equal(runtime.store.operationHandle(f.plan.operation.id), `handle:${f.plan.operation.id}`);
  assert.deepEqual(runtime.store.recoveryStatus().unresolved, []); assert.deepEqual(runtime.store.recoveryStatus().unresolvedProjections, []);
  assert.equal(external.view().value, 'human-edited'); assert.equal(external.count(), 0);
  assert.equal(runtime.store.delivery(`projection:${f.plan.projections[0].id}`).state, 'conflict');
  await runtime.close(); const config = join(f.root, 'restore.json'); writeFileSync(config, JSON.stringify(spec), { mode: 0o600 });
  await cli(['recovery','resume','--config',config], () => {}); assert.equal(readStatus(spec.stateDirectory).recovery.paused, false);
  const targetDb = new DatabaseSync(targetPath); try { assert.equal(targetDb.prepare('SELECT count(*) AS n FROM calls').get().n, 1); } finally { targetDb.close(); }
});
test('pending hooks, session observations, uncertain projection tokens and stale epochs survive restore', async t => {
  const f = fixture(t), session = enroll(f.store), event = hook(session);
  f.store.receiveHook(session.id, event);
  const projection = f.plan.projections[0], external = provider(join(f.root, 'provider.sqlite'), projection); t.after(external.close);
  const token = f.store.beginProjection(projection.id, f.store.delivery(`projection:${projection.id}`).revision, external.view());
  await createBackupBundle(f.spec, f.bundle); f.close(); const spec = restoredSpec(f); await restoreBundle(spec, f.bundle);
  const { store } = startCoordinator(spec.stateDirectory); t.after(() => store.close());
  assert.equal(store.projectionToken(projection.id), token);
  assert.equal(store.receiveHook(session.id, event).outcome, 'duplicate');
  assert.deepEqual(store.recoveryStatus().unresolvedSessions, [session.id]);
  const poll = store.dueSessions()[0], epoch = store.recoveryEpoch();
  assert.throws(() => store.applySession(poll, session.revision, observation(session), 1000, [], epoch - 1), /revision_conflict/);
  store.applySession(poll, session.revision, observation(session, { state: 'outcome_unknown', evidenceRefs: [] }), 1000, [], epoch);
  assert.deepEqual(store.recoveryStatus().unresolvedSessions, [session.id]);
  store.resumeSessionObservation(session.id, context);
  store.applySession(store.dueSessions()[0], store.get('session', session.id).revision, observation(session), 1000, [], epoch);
  const delivery = store.delivery(`projection:${projection.id}`);
  assert.throws(() => store.inspectProjection(projection.id, delivery.revision, external.view(), epoch - 1), /revision_conflict/);
  store.inspectProjection(projection.id, delivery.revision, external.view(), epoch);
  assert.deepEqual(store.recoveryStatus().unresolvedSessions, []);
  assert.deepEqual(store.recoveryStatus().unresolvedProjections, [projection.id]);
  assert.throws(() => store.resumeAfterRestore(context), /recovery_required/);
  await external.adapter.write(projection, token); // Original effect becomes independently observable.
  store.inspectProjection(projection.id, store.delivery(delivery.id).revision, external.view(), epoch);
  assert.deepEqual(store.recoveryStatus().unresolvedProjections, []);
});
test('a delayed session-start reply retains identity but cannot clear a fresh session observation check', async t => {
  const f = fixture(t, true), claim = f.store.claim(f.plan.operation.id, 'original', 'original'); f.store.beginEffect(claim);
  const loaded = await loadExtension(f.profile, sessionHost), reply = await loaded.instance.invoke(f.command.request);
  t.after(() => loaded.instance.dispose());
  assert.equal(reply.outcome, 'ok'); f.store.enterRestore(context);
  f.store.recordSessionReply(f.plan.operation.id, reply);
  assert.deepEqual(f.store.recoveryStatus().unresolvedSessions, [f.command.enrollmentId]);
  assert.equal(f.store.binding(f.command.enrollmentId).sessionId, reply.observation.sessionId);
  const observed = await loaded.instance.invoke({ ...f.command.request, operationId: 'independent-read', command: 'observe', sessionId: reply.observation.sessionId });
  f.store.resumeSessionObservation(f.command.enrollmentId, context);
  const session = f.store.get('session', f.command.enrollmentId), poll = f.store.dueSessions()[0];
  f.store.applySession(poll, session.revision, observed.observation, 1000, [], f.store.recoveryEpoch());
  assert.deepEqual(f.store.recoveryStatus().unresolvedSessions, []);
});
for (const delayed of [false, true]) test(`a ${delayed ? 'delayed' : 'previously confirmed'} session close preserves independent recovery without stranding a detached session`, async t => {
  const f = fixture(t, true), resolver = sessionResolver(sessionHost); t.after(() => resolver.close());
  const worker = createWorker(f.store, { executorId: 'session-test', nextAttempt: () => crypto.randomUUID(),
    adapters: new Map([[actionKey(sessionAction, sessionActionVersion), createSessionAction(f.store, resolver.resolve)]]) });
  await worker.tick(); await worker.drain();
  const close = follow(f, 'close', 'close'), claim = f.store.claim(close.operation.id, 'session-test', 'close'); f.store.beginEffect(claim, true);
  const real = await resolver.resolve(f.profile), reply = await real.invoke(close.command.request); assert.equal(reply.outcome, 'ok');
  if (delayed) f.store.enterRestore(context);
  f.store.recordSessionReply(close.operation.id, reply);
  if (!delayed) f.store.enterRestore(context);
  assert.equal(f.store.binding(f.command.enrollmentId).status, 'detached');
  assert.deepEqual(f.store.recoveryStatus().unresolvedSessions, delayed ? [f.command.enrollmentId] : []);
  if (delayed) {
    f.store.resumeSessionObservation(f.command.enrollmentId, context);
    const session = f.store.get('session', f.command.enrollmentId), epoch = f.store.recoveryEpoch();
    const current = await pinnedSessionObserver(f.store, resolver.resolve).observe(session);
    f.store.applySession(f.store.dueSessions()[0], session.revision, current, 1000, [], epoch);
    assert.deepEqual(f.store.recoveryStatus().unresolvedSessions, []);
  }
});
test('upgrade retains active handles and artifacts; failed DDL leaves original version and handles recoverable', async t => {
  const f = fixture(t, true), claim = f.store.claim(f.plan.operation.id, 'original', 'original'); f.store.beginEffect(claim);
  f.store.acceptResult(reply(f.plan.operation.request, 'accepted'), claim, f.plan.operation.revision);
  f.close();
  const db = new DatabaseSync(join(f.spec.stateDirectory, 'state.sqlite'));
  removeOperationsMigration(db);
  db.exec('DROP TABLE restore_observation_checks; DELETE FROM schema_migrations WHERE version=20; PRAGMA user_version=19'); db.close();
  const failing = [...migrations, { version: migrations.length + 1, sql: 'CREATE TABLE partial_upgrade(id TEXT); INVALID SQL;' }];
  await assert.rejects(upgradeDatabase(f.spec, f.bundle, { migrations: failing }), /migration_failed/);
  assert.throws(() => initializePrivateState(f.spec.stateDirectory), /maintenance_incomplete/);
  const original = new DatabaseSync(join(f.spec.stateDirectory, 'state.sqlite'));
  try { assert.equal(original.prepare('PRAGMA user_version').get().user_version, 19); assert.equal(original.prepare("SELECT name FROM sqlite_master WHERE name='partial_upgrade'").get(), undefined);
    assert.match(original.prepare("SELECT payload FROM execution_log WHERE kind='observation'").get().payload, /opaque-original-handle/); } finally { original.close(); }
  const spec = restoredSpec(f); await restoreBundle(spec, f.bundle);
  const { store } = startCoordinator(spec.stateDirectory); try {
    assert.equal(store.operationHandle(f.plan.operation.id), 'opaque-original-handle'); assert.deepEqual(store.profile(f.plan.run.id, f.pkg.pin.id), f.profile);
    assert.equal(store.recoveryStatus().paused, true);
  } finally { store.close(); }
});
test('successful explicit upgrade fences current state and preserves its pre-upgrade bundle', async t => {
  const f = fixture(t, true); f.close(); const out = [];
  const old = new DatabaseSync(join(f.spec.stateDirectory, 'state.sqlite'));
  removeOperationsMigration(old);
  old.exec('DROP TABLE restore_observation_checks; DELETE FROM schema_migrations WHERE version=20; PRAGMA user_version=19'); old.close();
  await cli(['upgrade','--backup',f.bundle,'--config',f.path], value => out.push(value));
  assert.equal(out[0].code, 'upgrade_completed'); assert.equal(readStatus(f.spec.stateDirectory).recovery.paused, true);
  assert.equal(existsSync(join(f.bundle, 'manifest.json')), true);
  assert.equal(JSON.parse(readFileSync(join(f.bundle, 'manifest.json'))).databaseVersion, 19);
  const { store } = startCoordinator(f.spec.stateDirectory); try { assert.deepEqual(store.profile(f.plan.run.id, f.pkg.pin.id), f.profile); } finally { store.close(); }
});
for (const [operation, stage] of [['upgrade','migration-before-commit'], ['upgrade','upgrade-committed'], ['restore','restore-marked'], ['restore','restore-before-publish'], ['restore','restore-published']]) {
  test(`actual SIGKILL during ${operation} at ${stage} leaves fenced or rollback-recoverable state`, async t => {
    const f = fixture(t, true), spec = operation === 'restore' ? restoredSpec(f, 'interrupted') : f.spec;
    const claim = f.store.claim(f.plan.operation.id, 'original', 'original'); f.store.beginEffect(claim);
    f.store.acceptResult(reply(f.plan.operation.request, 'accepted'), claim, f.plan.operation.revision);
    await createBackupBundle(f.spec, f.bundle); f.close();
    const bundle = operation === 'upgrade' ? join(f.root, 'upgrade-backup') : f.bundle, config = join(f.root, 'maintenance.json');
    writeFileSync(config, JSON.stringify(spec), { mode: 0o600 });
    const child = processFor(t, 'maintenance-process.mjs', [config, operation, bundle, stage]);
    assert.equal((await child.message()).stage, stage); child.kill('SIGKILL'); await child.exited;
    assert.throws(() => initializePrivateState(spec.stateDirectory), /maintenance_incomplete/);
    const marker = JSON.parse(readFileSync(join(spec.stateDirectory, 'maintenance.json'))); assert.equal(marker.operation, operation);
    if (existsSync(join(spec.stateDirectory, 'state.sqlite'))) {
      const db = new DatabaseSync(join(spec.stateDirectory, 'state.sqlite')); try {
        assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
        assert.equal(db.prepare('SELECT count(*) AS n FROM extension_profiles').get().n, 1);
        assert.match(db.prepare("SELECT payload FROM execution_log WHERE kind='observation'").get().payload, /opaque-original-handle/);
        if (stage.endsWith('committed') || stage.endsWith('published')) assert.equal(db.prepare('SELECT paused FROM recovery_control').get().paused, 1);
      } finally { db.close(); }
    }
    const recovery = restoredSpec(f, 'recovered'); await restoreBundle(recovery, bundle);
    assert.equal(readStatus(recovery.stateDirectory).recovery.paused, true);
  });
}
test('restore and upgrade exclude a service lock holder and preserve occupied destinations', async t => {
  const f = fixture(t); await createBackupBundle(f.spec, f.bundle); f.close(); const spec = restoredSpec(f);
  const release = await acquireServiceLock(spec.stateDirectory);
  try { await assert.rejects(restoreBundle(spec, f.bundle), /service_lock_present/); } finally { await release(); }
  const service = await acquireServiceLock(f.spec.stateDirectory);
  try { await assert.rejects(upgradeDatabase(f.spec, join(f.root, 'blocked')), /service_lock_present/); } finally { await service(); }
  assert.equal(existsSync(join(f.root, 'blocked')), false);
  writeFileSync(join(spec.stateDirectory, 'keep'), 'preserve'); await assert.rejects(restoreBundle(spec, f.bundle), /restore_destination_occupied/);
  assert.equal(readFileSync(join(spec.stateDirectory, 'keep'), 'utf8'), 'preserve');
});
test('invalid, incomplete, altered-history and foreign bundles are rejected before destination publication', async t => {
  const f = fixture(t); await createBackupBundle(f.spec, f.bundle); f.close(); const spec = restoredSpec(f);
  const manifestPath = join(f.bundle, 'manifest.json'), manifest = readFileSync(manifestPath), database = readFileSync(join(f.bundle, 'state.sqlite'));
  const reject = async () => { await assert.rejects(restoreBundle(spec, f.bundle)); assert.deepEqual(readdirSync(spec.stateDirectory), []); };
  renameSync(manifestPath, manifestPath + '.partial'); await reject(); renameSync(manifestPath + '.partial', manifestPath);
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), installationId: 'foreign' })); await reject(); writeFileSync(manifestPath, manifest);
  writeFileSync(join(f.bundle, 'state.sqlite'), 'corrupt'); await reject(); writeFileSync(join(f.bundle, 'state.sqlite'), database);
  const db = new DatabaseSync(join(f.bundle, 'state.sqlite')); db.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=1"); db.close();
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), databaseSha256: createHash('sha256').update(readFileSync(join(f.bundle, 'state.sqlite'))).digest('hex') })); await reject();
  writeFileSync(join(f.bundle, 'state.sqlite'), database); writeFileSync(manifestPath, manifest);
  const sha = JSON.parse(manifest).artifacts[0], artifact = join(f.bundle, 'artifacts', sha + '.json');
  renameSync(artifact, artifact + '.original'); symlinkSync(artifact + '.original', artifact); await reject();
  unlinkSync(artifact); writeFileSync(artifact, 'tampered', { mode: 0o600 }); await reject();
  unlinkSync(artifact); renameSync(artifact + '.original', artifact);
  writeFileSync(join(f.bundle, 'state.sqlite-wal'), 'unmanifested-sidecar', { mode: 0o600 }); await reject(); unlinkSync(join(f.bundle, 'state.sqlite-wal'));
  const future = new DatabaseSync(join(f.bundle, 'state.sqlite')); future.exec('PRAGMA user_version=999'); future.close();
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), databaseVersion: 999, databaseSha256: createHash('sha256').update(readFileSync(join(f.bundle, 'state.sqlite'))).digest('hex') })); await reject();
  await assert.rejects(createBackupBundle(f.spec, f.bundle), /backup_exists/);
});
test('raw SQLite backup CLI remains compatible and private, without claiming a complete bundle', async t => {
  const f = fixture(t), file = join(f.root, 'database-only.sqlite'), out = [];
  await cli(['backup',file,'--config',f.path], value => out.push(value));
  assert.equal(out[0].code, 'backup_created');
  const db = new DatabaseSync(file, { readOnly: true }); try { assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 1); } finally { db.close(); }
  await assert.rejects(cli(['backup',file,'--config',f.path]), /backup_exists/);
});
