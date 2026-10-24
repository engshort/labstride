// Only used to reconstruct older layouts in owned temporary test databases.
export function removeGitHubMigration(db){
  removeDeploymentOrderingMigration(db);
  db.exec('DROP TABLE IF EXISTS merge_intents; DELETE FROM schema_migrations WHERE version=16;');
  db.exec('DROP TABLE IF EXISTS deployment_evidence; DELETE FROM schema_migrations WHERE version=15;');
  db.exec('DROP TABLE IF EXISTS workflow_receipts; DROP TABLE IF EXISTS workflow_claims; DROP TABLE IF EXISTS workflow_dispatches; DELETE FROM schema_migrations WHERE version=14;');
  db.exec('DROP TABLE IF EXISTS managed_phases; DROP TABLE IF EXISTS managed_summary_errors;');
  db.exec(`DROP TABLE IF EXISTS managed_summaries; DROP TABLE IF EXISTS managed_reports; DROP TABLE IF EXISTS managed_sessions;
    DROP TABLE IF EXISTS managed_effects; DROP TABLE IF EXISTS managed_pull_requests;
    DROP TABLE IF EXISTS workflow_diagnostics; DROP TABLE IF EXISTS workflow_steps;
    DELETE FROM schema_migrations WHERE version=13;`);
  db.exec(`DROP TABLE github_webhooks;DROP TABLE github_candidates;DROP TABLE github_history;DROP TABLE github_items;
    DROP TABLE github_projects;DROP TABLE github_generations;DROP TABLE projection_holds;
    ALTER TABLE projection_attempts DROP COLUMN observed_version;
    ALTER TABLE projection_attempts DROP COLUMN acknowledged;
    ALTER TABLE projection_attempts DROP COLUMN mode;
    DELETE FROM schema_migrations WHERE version=12;PRAGMA user_version=11;`);
}

export function removeDeploymentOrderingMigration(db) {
  db.exec('DROP TABLE IF EXISTS restore_observation_checks; DELETE FROM schema_migrations WHERE version=20;');
  db.exec('DROP TABLE IF EXISTS cleanup_executions; DELETE FROM schema_migrations WHERE version=19;');
  db.exec('DROP TABLE IF EXISTS cleanup_decisions; DROP TABLE IF EXISTS cleanup_requests; DELETE FROM schema_migrations WHERE version=18;');
  db.exec(`DROP TABLE IF EXISTS deployment_successor_uses; DROP TABLE IF EXISTS deployment_successors; DROP TABLE IF EXISTS deployment_order_checks;
    DROP TABLE IF EXISTS deployment_orders; DROP TABLE IF EXISTS deployment_targets;
    DELETE FROM schema_migrations WHERE version=17;
    ALTER TABLE operations DROP COLUMN state;
    ALTER TABLE operations ADD COLUMN state TEXT GENERATED ALWAYS AS (json_extract(payload,'$.state')) VIRTUAL
      NOT NULL CHECK(state IN ('prepared','claimed','running','succeeded','failed','cancelled','outcome_unknown'));
    ALTER TABLE deployments DROP COLUMN state;
    ALTER TABLE deployments ADD COLUMN state TEXT GENERATED ALWAYS AS (json_extract(payload,'$.state')) VIRTUAL
      NOT NULL CHECK(state IN ('requested','running','verified','failed','outcome_unknown'));
    PRAGMA user_version=16;`);
}
