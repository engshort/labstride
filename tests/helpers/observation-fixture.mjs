import { DatabaseSync } from 'node:sqlite';
import { fixtureRecords } from './lifecycle-fixture.mjs';
import { context, timestamp } from './execution-fixture.mjs';
import { PreEffectTransient } from '../../packages/core/worker.ts';
export function enroll(store) {
  const session = fixtureRecords().find(r => r.kind === 'session');
  session.createdAt = session.updatedAt = '2026-10-20T12:00:00.000Z';
  store.commit([{ record: session, expectedRevision: null }], context); return session;
}
export function hook(session, eventId = 'hook-1') {
  return { schemaVersion: '1.0', eventId, providerId: session.providerId, runId: session.runId, requestGeneration: 1,
    workspaceId: session.workspaceId, sessionId: session.sessionId, turnId: session.lastTurnId, origin: 'extension',
    kind: 'turn.stopped', occurredAt: timestamp, sourceVersion: 'opaque:v1', evidenceRefs: ['hook:advisory'] };
}
export function observation(session, fields = {}) {
  return { schemaVersion: '1.0', workspaceId: session.workspaceId, providerId: session.providerId, sessionId: session.sessionId,
    state: session.state, lastTurnId: session.lastTurnId, humanActivityRevision: session.humanActivityRevision,
    effectiveSettings: {}, evidenceRefs: ['backend:observed'], ...fields };
}
export async function observeRestoreProjections(store, path) {
  for (const id of store.recoveryStatus().unresolvedProjections) {
    const projection = store.get('projection', id), external = provider(path + '-' + id + '.sqlite', projection);
    try {
      const epoch = store.recoveryEpoch(), view = await external.adapter.read(projection);
      store.inspectProjection(id, store.delivery(`projection:${id}`).revision, view, epoch);
    } finally { external.close(); }
  }
}
// Stateful synthetic provider with real version CAS and durable write-token identity.
// It does not establish that GitHub supplies these capabilities.
export function provider(path, projection) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS field (id INTEGER PRIMARY KEY CHECK(id=1), version TEXT, value TEXT, generation INTEGER, token TEXT); CREATE TABLE IF NOT EXISTS writes (id INTEGER PRIMARY KEY, token TEXT)');
  db.prepare('INSERT OR IGNORE INTO field VALUES (1,?,?,?,NULL)').run(projection.payload.expectedFingerprint, JSON.stringify('old'), projection.generation);
  const view = () => {
    const row = db.prepare('SELECT * FROM field').get();
    return { schemaVersion: '1.0', providerId: projection.providerId, subjectId: projection.subjectId, fieldId: projection.fieldId,
      generation: row.generation, version: row.version, value: JSON.parse(row.value), appliedToken: row.token };
  };
  const adapter = {
    atomicPrecondition: true, failRead: false, failWrite: false, dropReply: false, reads: 0,
    async read() { this.reads++; if (this.failRead) throw new Error('Synthetic unavailable read'); return view(); },
    async write(p, token) {
      if (this.failWrite) throw new PreEffectTransient('Proven rejection before any write');
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('UPDATE field SET value=?,version=?,token=? WHERE id=1 AND version=? AND generation=?')
        .run(JSON.stringify(p.payload.value), `written:${token}`, token, p.payload.expectedFingerprint, p.generation);
      if (!row.changes) { db.exec('ROLLBACK'); throw new PreEffectTransient('Atomic precondition rejected without write'); }
      db.prepare('INSERT INTO writes(token) VALUES (?)').run(token); db.exec('COMMIT');
      if (this.dropReply) throw new Error('Lost reply after committed write'); return view();
    },
  };
  return { adapter, view, close: () => db.close(), count: () => db.prepare('SELECT count(*) AS n FROM writes').get().n,
    human(value = 'human-edited') { db.prepare('UPDATE field SET value=?,version=?,token=NULL WHERE id=1').run(JSON.stringify(value),'human-version'); },
  };
}
