import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LifecycleError } from '../core/lifecycle.ts';

const common = `
  id TEXT PRIMARY KEY NOT NULL CHECK(id = json_extract(payload, '$.id')),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 262144
    AND json_extract(payload, '$.schemaVersion') = '1.0'),
  revision INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.revision')) STORED
    CHECK(typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991)`;
const ref = (name: string, field: string) =>
  `${name} TEXT GENERATED ALWAYS AS (json_extract(payload, '$.${field}')) STORED NOT NULL`;
const state = (states: string) => `state TEXT GENERATED ALWAYS AS (json_extract(payload, '$.state')) STORED
  NOT NULL CHECK(state IN (${states.split(' ').map(s => `'${s}'`).join(',')}))`;

export interface Migration { version: number; sql: string }
// Immutable migration text: future schema changes must append a migration.
export const migrations: readonly Migration[] = [{ version: 1, sql: `
  CREATE TABLE installations (${common});
  CREATE TABLE requests (${common}, ${ref('installation_id', 'installationId')},
    ${ref('provider_id', 'providerId')}, ${ref('issue_id', 'issueId')},
    generation INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.generation')) STORED NOT NULL CHECK(generation > 0),
    FOREIGN KEY(installation_id) REFERENCES installations(id) ON DELETE RESTRICT,
    UNIQUE(installation_id, provider_id, issue_id, generation));
  CREATE TABLE runs (${common}, ${ref('request_id', 'requestId')},
    ${state('queued preparing ready active waiting_human waiting_ci delivering completed failed cancelled outcome_unknown')},
    FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE RESTRICT, UNIQUE(request_id));
  CREATE TABLE workspaces (${common}, ${ref('run_id', 'runId')},
    ${state('requested creating ready in_use retained cleanup_pending deleting deleted error outcome_unknown')},
    FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT, UNIQUE(id, run_id));
  CREATE UNIQUE INDEX one_live_workspace ON workspaces(run_id) WHERE state != 'deleted';
  CREATE TABLE operations (${common}, ${ref('run_id', 'runId')}, ${ref('workspace_id', 'workspaceId')},
    ${state('prepared claimed running succeeded failed cancelled outcome_unknown')},
    FOREIGN KEY(workspace_id, run_id) REFERENCES workspaces(id, run_id) ON DELETE RESTRICT, UNIQUE(id, run_id));
  CREATE TABLE deployments (${common}, ${ref('run_id', 'runId')}, ${ref('operation_id', 'operationId')},
    ${state('requested running verified failed outcome_unknown')},
    FOREIGN KEY(operation_id, run_id) REFERENCES operations(id, run_id) ON DELETE RESTRICT);
  CREATE TABLE sessions (${common}, ${ref('run_id', 'runId')}, ${ref('workspace_id', 'workspaceId')},
    ${ref('provider_id', 'providerId')}, ${ref('session_id', 'sessionId')},
    ${state('ready busy waiting_human closed failed outcome_unknown')},
    FOREIGN KEY(workspace_id, run_id) REFERENCES workspaces(id, run_id) ON DELETE RESTRICT,
    UNIQUE(provider_id, session_id));
  CREATE TABLE outbox (${common}, ${ref('run_id', 'runId')}, ${ref('operation_id', 'operationId')},
    ${ref('intent_key', 'intentKey')}, FOREIGN KEY(operation_id, run_id) REFERENCES operations(id, run_id) ON DELETE RESTRICT,
    UNIQUE(operation_id), UNIQUE(intent_key));
  CREATE TABLE projections (${common}, ${ref('run_id', 'runId')},
    FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT);
  CREATE TABLE audit (id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 262144
      AND json_extract(payload, '$.schemaVersion') = '1.0'),
    entity_kind TEXT GENERATED ALWAYS AS (json_extract(payload, '$.record.kind')) STORED NOT NULL,
    entity_id TEXT GENERATED ALWAYS AS (json_extract(payload, '$.record.id')) STORED NOT NULL);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'immutable_audit'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'immutable_audit'); END;
` }, { version: 2, sql: `
  CREATE UNIQUE INDEX operation_workspace_owner ON operations(id, workspace_id, run_id);
  CREATE TABLE resources (${common}, ${ref('run_id', 'runId')}, ${ref('workspace_id', 'workspaceId')},
    ${ref('created_by_operation', 'createdByOperation')},
    FOREIGN KEY(created_by_operation, workspace_id, run_id) REFERENCES operations(id, workspace_id, run_id) ON DELETE RESTRICT);
  CREATE TABLE evidence (${common}, ${ref('run_id', 'runId')}, ${ref('workspace_id', 'workspaceId')},
    ${ref('operation_id', 'operationId')},
    corrects_id TEXT GENERATED ALWAYS AS (json_extract(payload, '$.correctsId')) STORED,
    FOREIGN KEY(operation_id, workspace_id, run_id) REFERENCES operations(id, workspace_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY(corrects_id, run_id, workspace_id) REFERENCES evidence(id, run_id, workspace_id) ON DELETE RESTRICT,
    UNIQUE(id, run_id, workspace_id), CHECK(corrects_id IS NULL OR corrects_id != id));
  CREATE TRIGGER resources_no_update BEFORE UPDATE ON resources BEGIN SELECT RAISE(ABORT, 'immutable_resource'); END;
  CREATE TRIGGER resources_no_delete BEFORE DELETE ON resources BEGIN SELECT RAISE(ABORT, 'immutable_resource'); END;
  CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
  CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
` }, { version: 3, sql: `
  CREATE TABLE inbox (
    id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id),
    provider_id TEXT NOT NULL, stream TEXT NOT NULL, external_id TEXT NOT NULL,
    digest TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 262144),
    run_id TEXT REFERENCES runs(id), processed INTEGER NOT NULL DEFAULT 0 CHECK(processed IN (0,1)),
    UNIQUE(installation_id, provider_id, stream, external_id));
  CREATE TABLE checkpoints (
    installation_id TEXT NOT NULL REFERENCES installations(id), provider_id TEXT NOT NULL, stream TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0), cursor TEXT NOT NULL,
    PRIMARY KEY(installation_id, provider_id, stream));
  CREATE TABLE execution_bindings (
    operation_id TEXT PRIMARY KEY REFERENCES operations(id), resource_key TEXT NOT NULL,
    request_digest TEXT NOT NULL, authorized_by TEXT NOT NULL);
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY, operation_id TEXT UNIQUE REFERENCES operations(id), projection_id TEXT UNIQUE REFERENCES projections(id),
    state TEXT NOT NULL CHECK(state IN ('pending','reconcile','blocked','done','superseded','conflict')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), next_at TEXT NOT NULL,
    last_error TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    CHECK((operation_id IS NULL) != (projection_id IS NULL)));
` }, { version: 4, sql: `
  CREATE TABLE fences (resource_key TEXT PRIMARY KEY, number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 9007199254740991));
  CREATE TABLE claims (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
    resource_key TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
    consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
  CREATE UNIQUE INDEX one_resource_claim ON claims(resource_key) WHERE active=1;
  CREATE TABLE resource_holds (resource_key TEXT PRIMARY KEY, reason TEXT NOT NULL);
  CREATE TABLE execution_results (operation_id TEXT PRIMARY KEY REFERENCES operations(id), payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE TABLE execution_log (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT REFERENCES operations(id),
    at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE TRIGGER execution_log_no_update BEFORE UPDATE ON execution_log BEGIN SELECT RAISE(ABORT, 'immutable_execution_log'); END;
  CREATE TRIGGER execution_log_no_delete BEFORE DELETE ON execution_log BEGIN SELECT RAISE(ABORT, 'immutable_execution_log'); END;
  CREATE TRIGGER execution_result_no_update BEFORE UPDATE ON execution_results BEGIN SELECT RAISE(ABORT, 'immutable_execution_result'); END;
  CREATE TRIGGER execution_result_no_delete BEFORE DELETE ON execution_results BEGIN SELECT RAISE(ABORT, 'immutable_execution_result'); END;
  CREATE TABLE recovery_control (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL CHECK(paused IN (0,1)), epoch INTEGER NOT NULL);
  INSERT INTO recovery_control VALUES (1,0,0);
  CREATE TABLE restore_checks (operation_id TEXT PRIMARY KEY REFERENCES operations(id), epoch INTEGER NOT NULL, resolved INTEGER NOT NULL CHECK(resolved IN (0,1)));
` }, { version: 5, sql: `
  ALTER TABLE inbox ADD COLUMN session_record_id TEXT REFERENCES sessions(id);
  CREATE TABLE session_polls (session_record_id TEXT PRIMARY KEY REFERENCES sessions(id),
    revision INTEGER NOT NULL DEFAULT 1, next_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)));
  CREATE TABLE projection_attempts (projection_id TEXT PRIMARY KEY REFERENCES projections(id),
    token TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('started','not_applied','applied')));
` }, { version: 6, sql: `
  CREATE TABLE scheduling_policy (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL CHECK(json_valid(payload)));
  INSERT INTO scheduling_policy VALUES (1,'{"schemaVersion":"1.0","activeRuns":2,"development":2,"ciReview":2}');
  CREATE TABLE run_admissions (run_id TEXT PRIMARY KEY REFERENCES runs(id), admitted_at TEXT);
  INSERT INTO run_admissions SELECT r.id, CASE WHEN r.state!='queued' OR EXISTS
    (SELECT 1 FROM operations o JOIN claims c ON c.operation_id=o.id WHERE o.run_id=r.id)
    THEN json_extract(r.payload,'$.createdAt') ELSE NULL END FROM runs r;
  CREATE TABLE operation_scheduling (operation_id TEXT PRIMARY KEY REFERENCES operations(id),
    capacity_class TEXT NOT NULL CHECK(capacity_class IN ('development','ciReview')));
  INSERT INTO operation_scheduling SELECT operation_id,'development' FROM execution_bindings;
` }, { version: 7, sql: `
  CREATE TABLE run_controls (run_id TEXT PRIMARY KEY REFERENCES runs(id), operator_paused INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0);
  INSERT INTO run_controls SELECT id,json_extract(payload,'$.paused'),0 FROM runs;
  CREATE TABLE control_requests (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL);
  CREATE TABLE cancellations (operation_id TEXT PRIMARY KEY REFERENCES operations(id),control_id TEXT NOT NULL REFERENCES control_requests(id),
    state TEXT NOT NULL CHECK(state IN ('pending','submitted','requested','unsupported','outcome_unknown','observed')));
` }, { version: 8, sql: `
  ALTER TABLE run_controls ADD COLUMN human_hold INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE run_controls ADD COLUMN max_repairs INTEGER NOT NULL DEFAULT 3;
  ALTER TABLE run_controls ADD COLUMN unattended_ms INTEGER NOT NULL DEFAULT 86400000;
  ALTER TABLE run_controls ADD COLUMN budget_anchor TEXT;
  ALTER TABLE run_controls ADD COLUMN repairs INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE run_controls ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE run_controls ADD COLUMN last_failure TEXT;
  ALTER TABLE run_controls ADD COLUMN budget_hold TEXT;
  ALTER TABLE operation_scheduling ADD COLUMN automation TEXT NOT NULL DEFAULT '{"schemaVersion":"1.0"}';
` }, { version: 9, sql: `
  CREATE TABLE extension_profiles (run_id TEXT NOT NULL REFERENCES runs(id), provider_id TEXT NOT NULL,
    digest TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(run_id,provider_id));
  CREATE TABLE session_bindings (enrollment_id TEXT PRIMARY KEY REFERENCES sessions(id),
    run_id TEXT NOT NULL REFERENCES runs(id), provider_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
    FOREIGN KEY(run_id,provider_id) REFERENCES extension_profiles(run_id,provider_id));
  CREATE TABLE session_commands (operation_id TEXT PRIMARY KEY REFERENCES operations(id),
    payload TEXT NOT NULL CHECK(json_valid(payload)), response TEXT CHECK(response IS NULL OR json_valid(response)));
  CREATE UNIQUE INDEX session_start_enrollment ON session_commands(json_extract(payload,'$.enrollmentId'))
    WHERE json_extract(payload,'$.request.command')='start';
  CREATE TABLE session_handoffs (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
` }, { version: 10, sql: `
  CREATE TABLE configuration_snapshots (
    digest TEXT PRIMARY KEY CHECK(length(digest)=64), installation_id TEXT NOT NULL REFERENCES installations(id),
    payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=262144));
  CREATE TRIGGER configuration_snapshot_no_update BEFORE UPDATE ON configuration_snapshots BEGIN SELECT RAISE(ABORT,'immutable_configuration'); END;
  CREATE TRIGGER configuration_snapshot_no_delete BEFORE DELETE ON configuration_snapshots BEGIN SELECT RAISE(ABORT,'immutable_configuration'); END;
  CREATE TABLE active_configurations (
    installation_id TEXT PRIMARY KEY REFERENCES installations(id), digest TEXT NOT NULL REFERENCES configuration_snapshots(digest));
  ALTER TABLE runs ADD COLUMN config_digest TEXT REFERENCES configuration_snapshots(digest);
  CREATE TABLE rule_evaluations (
    inbox_id TEXT PRIMARY KEY REFERENCES inbox(id), config_digest TEXT NOT NULL REFERENCES configuration_snapshots(digest),
    payload TEXT NOT NULL CHECK(json_valid(payload)), run_id TEXT REFERENCES runs(id));
  CREATE TRIGGER rule_evaluation_no_update BEFORE UPDATE ON rule_evaluations BEGIN SELECT RAISE(ABORT,'immutable_rule_evaluation'); END;
  CREATE TRIGGER rule_evaluation_no_delete BEFORE DELETE ON rule_evaluations BEGIN SELECT RAISE(ABORT,'immutable_rule_evaluation'); END;
` }, { version: 11, sql: `
  CREATE TABLE policy_revisions (installation_id TEXT NOT NULL REFERENCES installations(id), revision INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), digest TEXT NOT NULL CHECK(length(digest)=64), PRIMARY KEY(installation_id,revision));
  CREATE TABLE policy_state (installation_id TEXT PRIMARY KEY REFERENCES installations(id), revision INTEGER NOT NULL,
    policy_revision INTEGER NOT NULL, FOREIGN KEY(installation_id,policy_revision) REFERENCES policy_revisions(installation_id,revision));
  CREATE TABLE policy_changes (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id),
    payload TEXT NOT NULL CHECK(json_valid(payload)), receipt TEXT NOT NULL CHECK(json_valid(receipt)));
  CREATE TABLE run_authorizations (run_id TEXT PRIMARY KEY REFERENCES runs(id), installation_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL, actor_id TEXT NOT NULL,
    FOREIGN KEY(installation_id,policy_revision) REFERENCES policy_revisions(installation_id,revision));
  CREATE TABLE policy_restrictions (installation_id TEXT NOT NULL REFERENCES installations(id), scope TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(installation_id,scope));
  CREATE TABLE authorization_decisions (inbox_id TEXT PRIMARY KEY REFERENCES inbox(id), payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE TRIGGER policy_revision_no_update BEFORE UPDATE ON policy_revisions BEGIN SELECT RAISE(ABORT,'immutable_policy'); END;
  CREATE TRIGGER policy_revision_no_delete BEFORE DELETE ON policy_revisions BEGIN SELECT RAISE(ABORT,'immutable_policy'); END;
  CREATE TRIGGER policy_change_no_update BEFORE UPDATE ON policy_changes BEGIN SELECT RAISE(ABORT,'immutable_policy_change'); END;
  CREATE TRIGGER policy_change_no_delete BEFORE DELETE ON policy_changes BEGIN SELECT RAISE(ABORT,'immutable_policy_change'); END;
  CREATE TRIGGER authorization_decision_no_update BEFORE UPDATE ON authorization_decisions BEGIN SELECT RAISE(ABORT,'immutable_authorization_decision'); END;
  CREATE TRIGGER authorization_decision_no_delete BEFORE DELETE ON authorization_decisions BEGIN SELECT RAISE(ABORT,'immutable_authorization_decision'); END;
` }, { version: 12, sql: `
  CREATE TABLE github_projects (key TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id),
    payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE TABLE github_items (key TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES github_projects(key),
    item_id TEXT NOT NULL, subject_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), baseline INTEGER NOT NULL DEFAULT 0,
    cursor TEXT, overlap_cursor TEXT, dirty INTEGER NOT NULL DEFAULT 1, seen_epoch INTEGER NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0, last_error TEXT, UNIQUE(project_key,item_id));
  CREATE TABLE github_history (item_key TEXT NOT NULL REFERENCES github_items(key), event_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), processed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(item_key,event_id));
  CREATE TABLE github_generations (installation_id TEXT NOT NULL, provider_id TEXT NOT NULL, subject_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>0), PRIMARY KEY(installation_id,provider_id,subject_id));
  CREATE TABLE github_candidates (id TEXT PRIMARY KEY, item_key TEXT NOT NULL REFERENCES github_items(key),
    observation TEXT NOT NULL CHECK(json_valid(observation)), evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence)),
    source TEXT NOT NULL CHECK(json_valid(source)), state TEXT NOT NULL CHECK(state IN ('pending','admitted','superseded')),
    receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)));
  CREATE TABLE github_webhooks (installation_id TEXT NOT NULL REFERENCES installations(id), delivery_id TEXT NOT NULL,
    digest TEXT NOT NULL, receipt TEXT NOT NULL CHECK(json_valid(receipt)), PRIMARY KEY(installation_id,delivery_id));
  ALTER TABLE projection_attempts ADD COLUMN mode TEXT NOT NULL DEFAULT 'atomic';
  ALTER TABLE projection_attempts ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projection_attempts ADD COLUMN observed_version TEXT;
  CREATE TABLE projection_holds (provider_id TEXT NOT NULL,subject_id TEXT NOT NULL,field_id TEXT NOT NULL,reason TEXT NOT NULL,
    PRIMARY KEY(provider_id,subject_id,field_id));
` }, { version: 13, sql: `
  CREATE TABLE workflow_steps (run_id TEXT NOT NULL REFERENCES runs(id), position INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id), PRIMARY KEY(run_id,position));
  CREATE TABLE workflow_diagnostics (run_id TEXT PRIMARY KEY REFERENCES runs(id), code TEXT NOT NULL);
  CREATE TABLE managed_effects (operation_id TEXT NOT NULL REFERENCES operations(id), name TEXT NOT NULL,
    digest TEXT NOT NULL, request TEXT NOT NULL CHECK(json_valid(request)), response TEXT CHECK(response IS NULL OR json_valid(response)),
    PRIMARY KEY(operation_id,name));
  CREATE TABLE managed_sessions (run_id TEXT PRIMARY KEY REFERENCES runs(id), operation_id TEXT NOT NULL REFERENCES operations(id),
    session_id TEXT NOT NULL UNIQUE, workspace_path TEXT NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL, reasoning TEXT NOT NULL);
  CREATE TABLE managed_summaries (run_id TEXT PRIMARY KEY REFERENCES runs(id), comment_id INTEGER, body TEXT NOT NULL, previous_body TEXT, pending INTEGER NOT NULL, next_at TEXT NOT NULL);
  CREATE TABLE managed_pull_requests (run_id TEXT PRIMARY KEY REFERENCES runs(id), number INTEGER NOT NULL, sha TEXT NOT NULL, next_at TEXT NOT NULL);
  CREATE TABLE managed_reports (run_id TEXT PRIMARY KEY REFERENCES runs(id), session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE TABLE managed_phases (run_id TEXT PRIMARY KEY REFERENCES runs(id), name TEXT NOT NULL, revision INTEGER NOT NULL);
  CREATE TABLE managed_summary_errors (run_id TEXT PRIMARY KEY REFERENCES runs(id), code TEXT NOT NULL);
` }, { version: 14, sql: `
  CREATE TABLE workflow_dispatches (operation_id TEXT PRIMARY KEY REFERENCES operations(id),
    payload TEXT NOT NULL CHECK(json_valid(payload)), resource_key TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), conflict INTEGER NOT NULL DEFAULT 0 CHECK(conflict IN (0,1)));
  CREATE UNIQUE INDEX workflow_target_active ON workflow_dispatches(resource_key) WHERE active=1;
  CREATE TABLE workflow_claims (operation_id TEXT PRIMARY KEY REFERENCES workflow_dispatches(operation_id),
    payload TEXT NOT NULL CHECK(json_valid(payload)), consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)));
  CREATE TABLE workflow_receipts (operation_id TEXT PRIMARY KEY REFERENCES workflow_claims(operation_id),
    payload TEXT NOT NULL CHECK(json_valid(payload)));
` }, { version: 15, sql: `
  CREATE TABLE deployment_evidence (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES workflow_dispatches(operation_id),
    payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE INDEX deployment_evidence_operation ON deployment_evidence(operation_id);
` }, { version: 16, sql: `
  CREATE TABLE merge_intents (operation_id TEXT PRIMARY KEY REFERENCES operations(id), resource_key TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
  CREATE UNIQUE INDEX merge_branch_active ON merge_intents(resource_key) WHERE active=1;
` }, { version: 17, sql: `
  ALTER TABLE operations DROP COLUMN state;
  ALTER TABLE operations ADD COLUMN state TEXT GENERATED ALWAYS AS (json_extract(payload, '$.state')) VIRTUAL
    NOT NULL CHECK(state IN ('prepared','claimed','running','succeeded','failed','cancelled','outcome_unknown','superseded'));
  ALTER TABLE deployments DROP COLUMN state;
  ALTER TABLE deployments ADD COLUMN state TEXT GENERATED ALWAYS AS (json_extract(payload, '$.state')) VIRTUAL
    NOT NULL CHECK(state IN ('requested','running','verified','failed','outcome_unknown','superseded'));
  CREATE TABLE deployment_targets (resource_key TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
    operation_id TEXT REFERENCES operations(id), evidence_id TEXT REFERENCES deployment_evidence(id),
    legacy_blocked INTEGER NOT NULL DEFAULT 0 CHECK(legacy_blocked IN (0,1)));
  INSERT INTO deployment_targets(resource_key,legacy_blocked)
    SELECT DISTINCT resource_key,1 FROM workflow_dispatches WHERE json_type(payload,'$.enrollment.deployment')='object';
  CREATE TABLE deployment_orders (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
    resource_key TEXT NOT NULL REFERENCES deployment_targets(resource_key), payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE TABLE deployment_order_checks (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES deployment_orders(operation_id),
    payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE INDEX deployment_order_checks_operation ON deployment_order_checks(operation_id);
  CREATE TABLE deployment_successors (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES deployment_orders(operation_id),
    payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE INDEX deployment_successors_operation ON deployment_successors(operation_id);
  CREATE TABLE deployment_successor_uses (operation_id TEXT PRIMARY KEY REFERENCES deployment_orders(operation_id),
    evidence_id TEXT NOT NULL REFERENCES deployment_successors(id));
  CREATE TRIGGER deployment_successor_use_no_update BEFORE UPDATE ON deployment_successor_uses BEGIN SELECT RAISE(ABORT, 'immutable_successor_use'); END;
  CREATE TRIGGER deployment_successor_use_no_delete BEFORE DELETE ON deployment_successor_uses BEGIN SELECT RAISE(ABORT, 'immutable_successor_use'); END;
  CREATE TRIGGER deployment_order_check_no_update BEFORE UPDATE ON deployment_order_checks BEGIN SELECT RAISE(ABORT, 'immutable_order_check'); END;
  CREATE TRIGGER deployment_order_check_no_delete BEFORE DELETE ON deployment_order_checks BEGIN SELECT RAISE(ABORT, 'immutable_order_check'); END;
  CREATE TRIGGER deployment_successor_no_update BEFORE UPDATE ON deployment_successors BEGIN SELECT RAISE(ABORT, 'immutable_successor'); END;
  CREATE TRIGGER deployment_successor_no_delete BEFORE DELETE ON deployment_successors BEGIN SELECT RAISE(ABORT, 'immutable_successor'); END;
` }, { version: 18, sql: `
  CREATE TABLE cleanup_requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id), trigger TEXT NOT NULL CHECK(trigger IN ('completion_verified','operator_request')),
    state TEXT NOT NULL CHECK(state IN ('requested','blocked','eligible','pending_executor','outcome_unknown','retained')),
    decision_id TEXT, operation TEXT CHECK(operation IS NULL OR json_valid(operation)), result TEXT CHECK(result IS NULL OR json_valid(result)));
  CREATE TRIGGER cleanup_request_identity_immutable BEFORE UPDATE OF id,run_id,workspace_id,trigger ON cleanup_requests BEGIN SELECT RAISE(ABORT,'immutable_cleanup_request'); END;
  CREATE TRIGGER cleanup_operation_immutable BEFORE UPDATE OF operation ON cleanup_requests WHEN OLD.operation IS NOT NULL AND NEW.operation IS NOT OLD.operation BEGIN SELECT RAISE(ABORT,'immutable_cleanup_operation'); END;
  CREATE TABLE cleanup_decisions (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES cleanup_requests(id),
    payload TEXT NOT NULL CHECK(json_valid(payload)));
  CREATE TRIGGER cleanup_decision_no_update BEFORE UPDATE ON cleanup_decisions BEGIN SELECT RAISE(ABORT,'immutable_cleanup_decision'); END;
  CREATE TRIGGER cleanup_decision_no_delete BEFORE DELETE ON cleanup_decisions BEGIN SELECT RAISE(ABORT,'immutable_cleanup_decision'); END;
` }, { version: 19, sql: `
  CREATE TABLE cleanup_executions (request_id TEXT PRIMARY KEY REFERENCES cleanup_requests(id),
    workspace_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(json_valid(operation)), stage TEXT NOT NULL, commit_context TEXT, authorization TEXT CHECK(authorization IS NULL OR json_valid(authorization)),
    observation TEXT CHECK(observation IS NULL OR json_valid(observation)));
  CREATE UNIQUE INDEX cleanup_execution_owner ON cleanup_executions(workspace_id) WHERE stage NOT IN ('blocked','released');
  CREATE TRIGGER cleanup_execution_identity BEFORE UPDATE OF request_id,workspace_id,operation ON cleanup_executions BEGIN SELECT RAISE(ABORT,'immutable_cleanup_execution'); END;
  CREATE TRIGGER cleanup_authorization_immutable BEFORE UPDATE OF authorization ON cleanup_executions WHEN OLD.authorization IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable_cleanup_authorization'); END;
  CREATE TRIGGER cleanup_execution_retained BEFORE DELETE ON cleanup_executions BEGIN SELECT RAISE(ABORT,'immutable_cleanup_execution'); END;
  CREATE TRIGGER cleanup_execution_complete BEFORE UPDATE ON cleanup_executions WHEN OLD.stage='deleted' BEGIN SELECT RAISE(ABORT,'immutable_cleanup_execution'); END;
` }, { version: 20, sql: `
  CREATE TABLE restore_observation_checks (
    kind TEXT NOT NULL CHECK(kind IN ('session','projection')), id TEXT NOT NULL,
    epoch INTEGER NOT NULL, resolved INTEGER NOT NULL CHECK(resolved IN (0,1)), PRIMARY KEY(kind,id));
  INSERT INTO restore_observation_checks SELECT 'session',s.id,(SELECT epoch FROM recovery_control),0 FROM sessions s
    WHERE (SELECT paused FROM recovery_control)=1 AND NOT EXISTS
      (SELECT 1 FROM session_bindings b WHERE b.enrollment_id=s.id AND json_extract(b.payload,'$.status')='detached');
  INSERT INTO restore_observation_checks SELECT 'projection',projection_id,(SELECT epoch FROM recovery_control),0 FROM deliveries
    WHERE projection_id IS NOT NULL AND state IN ('pending','reconcile','blocked','conflict') AND (SELECT paused FROM recovery_control)=1;
` }];

export function verifySchema(db: DatabaseSync): void {
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== migrations.length) throw new LifecycleError('unsupported_schema');
  if (verifySchemaHistory(db) !== migrations.length) throw new LifecycleError('unsupported_schema');
}

// Accept only an exact immutable prefix, never an arbitrary older layout.
export function verifySchemaHistory(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version < 1 || version > migrations.length) throw new LifecycleError('unsupported_schema');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) throw new LifecycleError('unsupported_schema');
  const applied = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
  if (applied.length !== version || applied.some((row, index) => Number(row.version) !== index + 1 ||
    row.checksum !== createHash('sha256').update(migrations[index].sql).digest('hex'))) throw new LifecycleError('unsupported_schema');
  return version;
}

export function migrate(db: DatabaseSync, steps: readonly Migration[] = migrations, beforeCommit?: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > steps.length) throw new LifecycleError('unsupported_schema');
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (version > 0 && !exists) throw new LifecycleError('unsupported_schema');
    if (!exists) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get())
        throw new LifecycleError('unsupported_schema');
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL)');
    }
    const applied = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    if (applied.length !== version) throw new LifecycleError('unsupported_schema');
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (step.version !== index + 1) throw new LifecycleError('migration_failed');
      const checksum = createHash('sha256').update(step.sql).digest('hex');
      if (index < version) {
        if (Number(applied[index].version) !== step.version || applied[index].checksum !== checksum)
          throw new LifecycleError('unsupported_schema');
      } else {
        db.exec(step.sql);
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(step.version, checksum);
        db.exec(`PRAGMA user_version=${step.version}`);
      }
    }
    beforeCommit?.();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError('migration_failed');
  }
}
