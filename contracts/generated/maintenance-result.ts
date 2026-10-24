/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface InstallationMaintenanceResultV1 {
  schemaVersion: "1.0";
  code: "backup_bundle_created" | "restore_completed" | "upgrade_completed";
  databaseVersion: number;
  reconciliationRequired: boolean;
}
